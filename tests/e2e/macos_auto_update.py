"""Install a release through the real native updater using invented release metadata."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from cod_e2e import Driver, DriverError, cod_settings, make_repo, palette_problem


def run(archive: Path, artifacts: Path) -> None:
    artifacts.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="cod-update-"))
    subprocess.run(["ditto", "-x", "-k", str(archive), str(root)], check=True)
    app = root / "Cod.app"
    resources = app / "Contents/Resources"
    version_file = resources / "cod-update-version.txt"
    target_version = version_file.read_text().strip()
    target_commit = (resources / "cod-commit.txt").read_text().strip()
    assert target_version != "0.0.1", target_version
    version_file.write_text("0.0.1\n")
    with (app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    info["CFBundleVersion"] = "1"
    with (app / "Contents/Info.plist").open("wb") as output:
        plistlib.dump(info, output)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
    requested = []
    with archive.open("rb") as source:
        archive_hash = hashlib.file_digest(source, "sha256").hexdigest()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requested.append(self.path)
            base = f"http://127.0.0.1:{self.server.server_port}"
            if self.path == "/releases":
                body = json.dumps([{"draft": False, "assets": [{"name": "cod-update.json",
                    "browser_download_url": base + "/metadata"}]}]).encode()
            elif self.path == "/metadata":
                body = json.dumps({"version": target_version, "commit": target_commit,
                    "macos_aarch64": {"url": base + "/Cod.zip", "sha256": archive_hash}}).encode()
            elif self.path == "/Cod.zip":
                self.send_response(200)
                self.send_header("Content-Length", str(archive.stat().st_size))
                self.end_headers()
                with archive.open("rb") as source:
                    import shutil
                    shutil.copyfileobj(source, self.wfile)
                return
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    data = root / "profile"
    (data / "config").mkdir(parents=True)
    (data / "config/settings.json").write_text(json.dumps(cod_settings()))
    project = make_repo(data, "update-notes", {"README.txt": "Update smoke fixture.\n"})
    socket_path = root / "driver.sock"
    launch = ["open", "-n", "--env", f"COD_PREVIEW_DIR={data}", "--env",
              f"COD_E2E_SOCKET={socket_path}", "--env",
              f"COD_UPDATE_RELEASES_URL=http://127.0.0.1:{server.server_port}/releases",
              str(app), "--args", str(project)]
    driver = None

    def connect():
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                return Driver(socket_path)
            except OSError:
                time.sleep(.1)
        raise AssertionError("App driver did not start")

    def wait(predicate, description, timeout=60):
        deadline = time.monotonic() + timeout
        state = {}
        while time.monotonic() < deadline:
            state = driver.state()
            if predicate(state):
                return state
            if str(state.get("auto_update", "")).startswith("Errored"):
                raise AssertionError(state["auto_update"])
            time.sleep(.1)
        raise AssertionError((description, state))

    def command(name):
        driver.keys("super-shift-p")
        wait(lambda s: s["modal"] == "command_palette", "palette")
        driver.type(name)
        wait(lambda s: palette_problem(name, s) is None, name)
        driver.keys("enter")

    def capture(name):
        (artifacts / f"{name}.json").write_text(json.dumps(driver.state(), indent=2))
        subprocess.run(["screencapture", "-x", "-t", "jpg", str(artifacts / f"{name}.jpg")], check=True)

    # LaunchServices starts a fresh process on native restart. Give launchd the
    # same isolated fixture environment and restore its previous values afterward.
    environment = {
        "COD_PREVIEW_DIR": str(data),
        "COD_E2E_SOCKET": str(socket_path),
        "COD_UPDATE_RELEASES_URL": f"http://127.0.0.1:{server.server_port}/releases",
    }
    previous_environment = {}
    try:
        for name, value in environment.items():
            previous = subprocess.run(["launchctl", "getenv", name], capture_output=True, text=True)
            previous_environment[name] = previous.stdout.rstrip("\n") if previous.returncode == 0 else None
            subprocess.run(["launchctl", "setenv", name, value], check=True)
        subprocess.run(launch, check=True, capture_output=True, timeout=30)
        driver = connect()
        wait(lambda s: len(s["worktrees"]) == 1, "project ready")
        capture("before-update")
        command("auto update: check")
        wait(lambda s: str(s.get("auto_update", "")).startswith("Updated"), "update installed", 180)
        assert version_file.read_text().strip() == target_version
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        capture("update-ready")
        pids = subprocess.check_output(["pgrep", "-f", str(app / "Contents/MacOS/Cod")], text=True).split()
        assert len(pids) == 1, pids
        pid = int(pids[0])
        try:
            command("workspace: reload")
        except DriverError:
            # Restart may close the driver before the Enter key reply is sent.
            pass
        driver.close()
        driver = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(.1)
        else:
            raise AssertionError("Old app did not exit for restart")
        driver = connect()
        wait(lambda s: len(s["worktrees"]) == 1, "project restored after update")
        command("auto update: check")
        wait(lambda s: s.get("auto_update") == "Idle" and requested.count("/metadata") >= 2,
             "installed release is current")
        assert requested.count("/Cod.zip") == 1, requested
        capture("restarted-current")
        print("PASS native updater downloads, verifies, installs and relaunches the current release", flush=True)
    finally:
        (artifacts / "requests.json").write_text(json.dumps(requested, indent=2))
        if driver is not None:
            try:
                driver.keys("super-q")
            except DriverError:
                pass
            driver.close()
        for name, value in previous_environment.items():
            operation = ["launchctl", "unsetenv", name] if value is None else ["launchctl", "setenv", name, value]
            subprocess.run(operation, check=True)
        server.shutdown()
        for source in (data / "logs").glob("*.log"):
            (artifacts / source.name).write_bytes(source.read_bytes()[-512 * 1024:])


if __name__ == "__main__":
    run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
