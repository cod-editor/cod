"""Remote fixtures must install the binary under the app's exact cache name."""

import os
import subprocess
import unittest
from unittest import mock

import loopback_ssh


class RemoteServerNameTest(unittest.TestCase):
    def test_preserves_built_app_version_and_commit(self) -> None:
        version = "0.0.1+stable.20261027.abc123"
        with mock.patch.dict(os.environ, {"COD_E2E_BIN": "/tmp/cod"}), mock.patch.object(
            loopback_ssh.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, f"Zed: v{version} (Zed)\n")
        ) as run:
            self.assertEqual(loopback_ssh.remote_server_name(), f"cod-remote-server-stable-{version}")
            self.assertEqual(run.call_args.args[0][0], "/tmp/cod")
            self.assertIn("--system-specs", run.call_args.args[0])

    def test_missing_version_does_not_silently_use_cargo_version(self) -> None:
        with mock.patch.dict(os.environ, {"COD_E2E_BIN": "/tmp/cod"}), mock.patch.object(
            loopback_ssh.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "invalid output")
        ):
            with self.assertRaisesRegex(RuntimeError, "no app version"):
                loopback_ssh.remote_server_name()
