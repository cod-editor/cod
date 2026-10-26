"""Check the packaged app's name in a real macOS local-network permission alert."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

from cod_e2e import cod_settings


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=40, **kwargs)


def main():
    app = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    data = Path(tempfile.mkdtemp(prefix="cod-network-"))
    (data / "config").mkdir()
    (data / "config/settings.json").write_text(json.dumps(cod_settings()))
    # A gateway is on the local network, unlike the loopback HTTP fixtures. No
    # service is required: the connection attempt itself requests permission.
    route = run("route", "-n", "get", "default").stdout
    gateway = re.search(r"gateway:\s+(\d+\.\d+\.\d+\.\d+)", route)
    assert gateway, "No IPv4 local-network route on this runner"
    swift = output / "recognize.swift"
    swift.write_text('''import AppKit
import Vision
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: url).perform([request])
let image = NSImage(contentsOf: url)!
let rows = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let text = observation.topCandidates(1).first?.string else { return nil }
    let box = observation.boundingBox
    return ["text": text, "x": box.midX * image.size.width,
            "y": (1 - box.midY) * image.size.height]
}
let data = try JSONSerialization.data(withJSONObject: rows)
print(String(data: data, encoding: .utf8)!)
''')
    recognizer = output / "recognize"
    run("swiftc", str(swift), "-o", str(recognizer))
    run("open", "-n", "--env", f"COD_PREVIEW_DIR={data}", str(app))
    time.sleep(8)
    try:
        run(str(app / "Contents/MacOS/codctl"), "open", f"http://{gateway[1]}:9/")
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            image = output / "permission.png"
            run("screencapture", "-x", str(image))
            rows = json.loads(run(str(recognizer), str(image)).stdout)
            text = "\n".join(row["text"] for row in rows)
            (output / "permission-text.json").write_text(json.dumps(rows, indent=2))
            if re.search(r"local networks?", text, re.I):
                assert not re.search(r"\bzed\b|hosted-compute", text, re.I), text
                assert re.search(r"\bCod[\"\u201c\u201d]?\s+(?:to find|would like|wants)", text, re.I), text
                deny = next((row for row in rows if re.search(r"don.t allow", row["text"], re.I)), None)
                assert deny, ("Missing permission decision button", text)
                run("osascript", "-e", 'tell application "System Events" to click at '
                    + "{%d, %d}" % (deny["x"], deny["y"]))
                print("PASS native local-network permission alert identifies Cod", flush=True)
                return
            time.sleep(1)
        raise AssertionError("No local-network permission alert appeared; identity is unverified")
    finally:
        # This test owns only the editor from this exact bundle. The ordinary
        # smoke uses its own extracted package and profile afterwards.
        result = subprocess.run(["pgrep", "-f", str(app / "Contents/MacOS/Cod")],
                                capture_output=True, text=True, timeout=10)
        for process in result.stdout.split():
            try:
                os.kill(int(process), 15)
            except ProcessLookupError:
                pass


if __name__ == "__main__":
    main()
