#!/usr/bin/env python3
"""Read-only archive verification. Never extract or execute archive members."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

ROOT = Path(__file__).resolve().parent.parent
DIRECTORIES = ("src", "webapp", "test", "scripts", "systemd", "benchmarks", "audits")
FILES = ("package.json", "package-lock.json", "release-notes.json", ".env.example", "start.sh", "README.md", "QUICKSTART.md", "LOCAL-MODELS.md", "AI-KEYS.md", "BUILD-LOG.md", "NEURAL.md", "DEEP-TESTING.md", "VOICE.md", "WHATSAPP-CALL.md", "docker-compose.yml", "Containerfile")
# Written by build-bundle.sh at pack time, not kept in the tree: it names the ref
# the bundle came from, so a download can refuse another branch's bundle that
# happens to carry the same version number.
STAMPED = ".bundle-ref"
FORBIDDEN = {".git", "node_modules", "data", "auth_info", "auth_info_baileys", ".cache", "coverage", "__pycache__"}


def verify(archive, root=ROOT):
    expected = {p.relative_to(root).as_posix() for name in DIRECTORIES if (root / name).is_dir() for p in (root / name).rglob("*") if p.is_file() and not FORBIDDEN.intersection(p.relative_to(root).parts)}
    expected.update(name for name in FILES if (root / name).is_file())
    expected.add(STAMPED)
    found = set()
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf:
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or path.parts[0] != "whatsapp-agent" or ".." in path.parts:
                raise ValueError(f"Unsafe archive path: {member.name}")
            if FORBIDDEN.intersection(path.parts) or path.name == ".env":
                raise ValueError(f"Private/runtime archive path: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise ValueError(f"Archive links/devices are forbidden: {member.name}")
            if member.isdir():
                continue
            relative = PurePosixPath(*path.parts[1:]).as_posix()
            if relative in found or relative not in expected:
                raise ValueError(f"Duplicate/unexpected archive member: {member.name}")
            if relative == STAMPED:
                stamp = tf.extractfile(member).read().decode("utf-8", "replace")
                if not any(line.startswith("ref=") and len(line) > 4 for line in stamp.splitlines()):
                    raise ValueError("Bundle ref stamp is missing its ref")
                found.add(relative)
                continue
            if (root / relative).is_symlink():
                raise ValueError(f"Source symlink not allowed: {relative}")
            if tf.extractfile(member).read() != (root / relative).read_bytes():
                raise ValueError(f"Stale/mismatched bundled file: {relative}")
            found.add(relative)
        if found != expected:
            raise ValueError(f"Missing archive files: {sorted(expected - found)}")
        package, lock, notes = [json.load(tf.extractfile(f"whatsapp-agent/{name}")) for name in ("package.json", "package-lock.json", "release-notes.json")]
        version = package["version"]
        if not version == lock["version"] == lock["packages"][""]["version"] == notes["latest"]:
            raise ValueError("Package, lock and release announcement versions differ")
        checkpoint = tf.extractfile("whatsapp-agent/src/neural/weights.json").read()
        evidence = json.load(tf.extractfile("whatsapp-agent/benchmarks/neural-v2.json"))
        if hashlib.sha256(checkpoint).hexdigest() != evidence["checkpoint"]["sha256"]:
            raise ValueError("Public checkpoint differs from the recorded public-only model")
    return {"version": version, "files": len(found), "bytes": Path(archive).stat().st_size, "sha256": hashlib.sha256(Path(archive).read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", type=Path, default=ROOT / "release-bundle.tar.gz")
    args = parser.parse_args()
    print(json.dumps(verify(args.archive), indent=2))


if __name__ == "__main__":
    main()
