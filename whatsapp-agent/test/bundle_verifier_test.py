"""Stdlib-only adversarial tests for the read-only bundle verifier."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import sys
sys.dont_write_bytecode = True
import unittest

spec = importlib.util.spec_from_file_location("bundle_verifier", Path(__file__).resolve().parent.parent / "scripts/verify-bundle.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class BundleVerifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="observer-bundle-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        model = b'{"public":true}'
        self.files = {"package.json": b'{"version":"3.9.1"}', "package-lock.json": b'{"version":"3.9.1","packages":{"":{"version":"3.9.1"}}}', "release-notes.json": b'{"latest":"3.9.1"}', "src/neural/weights.json": model, "benchmarks/neural-v2.json": json.dumps({"checkpoint": {"sha256": hashlib.sha256(model).hexdigest()}}).encode()}
        for name, data in self.files.items():
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)

    def archive(self, extra=None, omit=None, stale=None):
        file = self.root / "bundle.tar.gz"
        with tarfile.open(file, "w:gz") as tf:
            for name, data in self.files.items():
                if name == omit:
                    continue
                content = b"stale" if name == stale else data
                info = tarfile.TarInfo(f"whatsapp-agent/{name}")
                info.size = len(content)
                tf.addfile(info, io.BytesIO(content))
            if extra is not None:
                tf.addfile(extra, io.BytesIO(b"x") if extra.isfile() else None)
        return file

    def test_valid(self):
        self.assertEqual(verifier.verify(self.archive(), self.root)["version"], "3.9.1")

    def test_traversal(self):
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(extra=tarfile.TarInfo("whatsapp-agent/../../escape")), self.root)

    def test_absolute(self):
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(extra=tarfile.TarInfo("/absolute")), self.root)

    def test_symlink(self):
        info = tarfile.TarInfo("whatsapp-agent/src/link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/outside"
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(extra=info), self.root)

    def test_private_data(self):
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(extra=tarfile.TarInfo("whatsapp-agent/data/state.json")), self.root)

    def test_duplicate(self):
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(extra=tarfile.TarInfo("whatsapp-agent/package.json")), self.root)

    def test_missing(self):
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(omit="package.json"), self.root)

    def test_stale(self):
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(stale="package.json"), self.root)

    def test_version_mismatch(self):
        self.files["release-notes.json"] = b'{"latest":"old"}'
        (self.root / "release-notes.json").write_bytes(self.files["release-notes.json"])
        with self.assertRaises(ValueError):
            verifier.verify(self.archive(), self.root)


if __name__ == "__main__":
    unittest.main()
