import hashlib
import runpy
import tempfile
import unittest
from pathlib import Path


write_manifest = runpy.run_path(str(Path(__file__).with_name("cod-update-manifest")))["write_manifest"]


class UpdateManifestTests(unittest.TestCase):
    def test_only_the_checked_archive_is_advertised(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "cod-macos-aarch64.zip"
            archive.write_bytes(b"invented archive fixture")
            checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
            (directory / (archive.name + ".sha256")).write_text(f"{checksum}  {archive.name}\n")
            manifest = write_manifest("preview-10", "0.0.100", "a" * 40, directory)
            self.assertEqual(manifest["version"], "0.0.100")
            self.assertEqual(manifest["macos_aarch64"]["sha256"], checksum)
            self.assertEqual(manifest["macos_aarch64"]["url"], "https://github.com/cod-editor/cod/releases/download/preview-10/cod-macos-aarch64.zip")
            archive.write_bytes(b"changed after testing")
            with self.assertRaisesRegex(ValueError, "checksum"):
                write_manifest("preview-10", "0.0.100", "a" * 40, directory)

    def test_local_builds_and_invalid_commits_cannot_be_published(self):
        for version, commit in [("0.0.0", "a" * 40), ("1.0.2", "a" * 40), ("0.0.100", "abc")]:
            with self.assertRaises(ValueError):
                write_manifest("preview-10", version, commit)


if __name__ == "__main__":
    unittest.main()
