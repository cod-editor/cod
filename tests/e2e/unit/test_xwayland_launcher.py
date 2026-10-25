"""Check the XWayland fallback without needing an X server or browser runtime."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class XWaylandLauncherTest(unittest.TestCase):
    def test_backend_and_crash_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher = root / "cod-xwayland.sh"
            shutil.copyfile(Path(__file__).resolve().parents[3] / "script/cod-xwayland.sh", launcher)
            binary = root / "cod"
            binary.write_text(
                '#!/bin/sh\n'
                'printf "%s\\n" "$COD_WEBVIEW_BACKEND" "${WAYLAND_DISPLAY-unset}" "$RUST_BACKTRACE" "$COD_SPIKE_URL" "$@"\n'
                'echo "simulated GTK error" >&2\n'
                'exit 17\n'
            )
            binary.chmod(0o700)
            environment = {
                **os.environ,
                "HOME": str(root / "home"),
                "WAYLAND_DISPLAY": "wayland-test",
                "COD_WEBVIEW_BACKEND": "offscreen",
                "RUST_BACKTRACE": "0",
            }
            for _ in range(2):
                result = subprocess.run(
                    ["sh", str(launcher), "https://example.invalid", "folder with spaces"],
                    env=environment, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 17)
                self.assertEqual(result.stderr, "")
                self.assertEqual(result.stdout.splitlines(), [
                    "webkitgtk", "unset", "1", "https://example.invalid",
                    "--user-data-dir", str(root / "home/.local/share/cod-preview"), "folder with spaces",
                ])
            log = (root / "home/.local/share/cod-preview/logs/cod-stderr.log").read_text()
            self.assertEqual(log.count("=== cod start "), 2)
            self.assertEqual(log.count("simulated GTK error"), 2)
