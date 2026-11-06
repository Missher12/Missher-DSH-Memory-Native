#!/usr/bin/env python3
"""Build a clean plugin tarball without macOS AppleDouble/xattr members.

Usage: python3 scripts/pack-plugin.py [output.tgz]
The package list is deliberately explicit: runtime files/README only. Locale
files are whitelisted by language id so `._en.json` can never be published.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["package.json", "index.js", "client.js", "cordis.patch.yml", "icon.svg", "README.md"]
HOST_SUFFIX = ".js"
LOCALE = {"en.json", "zh.json"}
BAD_MAGIC = b"\x00\x05\x16\x07\x00\x02\x00\x00"


def collect() -> list[str]:
    names = list(FILES)
    host = ROOT / "host"
    for path in sorted(host.iterdir()):
        if path.is_file() and path.suffix == HOST_SUFFIX:
            names.append(f"host/{path.name}")
    for name in sorted(LOCALE):
        if (ROOT / "locale" / name).is_file():
            names.append(f"locale/{name}")
    return names


def clean_name(name: str) -> bool:
    return not (
        name.startswith("._")
        or "/._" in name
        or name.startswith("__MACOSX")
        or "/__MACOSX" in name
        or name.endswith(".DS_Store")
        or name.endswith(".tmp")
    )


def main() -> int:
    version = json.loads((ROOT / "package.json").read_text())["version"]
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / f"dsh-memory-{version}.tgz"
    names = collect()
    with tempfile.TemporaryDirectory(prefix="dsh-memory-pack-") as stage:
        stage_path = Path(stage) / "package"
        for name in names:
            source = ROOT / name
            target = stage_path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
            os.chmod(target, 0o644)
        # USTAR has no PAX/xattr headers. Add explicit TarInfo objects so no
        # AppleDouble fork or `com.apple.provenance` can enter the archive.
        with tarfile.open(output, "w:gz", format=tarfile.USTAR_FORMAT) as archive:
            for name in ["package"] + sorted(names):
                path = stage_path / name
                if name == "package":
                    info = tarfile.TarInfo("package")
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    info.size = 0
                    archive.addfile(info)
                    continue
                data = path.read_bytes()
                info = tarfile.TarInfo(f"package/{name}")
                info.size = len(data)
                info.mode = 0o644
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
    with tarfile.open(output, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            if not clean_name(member.name):
                raise SystemExit(f"refusing unclean member: {member.name}")
            if member.pax_headers:
                raise SystemExit(f"refusing xattr/PAX member: {member.name}")
            if member.isfile():
                data = archive.extractfile(member).read(8)
                if data == BAD_MAGIC:
                    raise SystemExit(f"refusing AppleDouble member: {member.name}")
        names_in_archive = {m.name for m in members}
        required = {"package/package.json", "package/index.js", "package/client.js", "package/locale/en.json", "package/locale/zh.json"}
        if not required.issubset(names_in_archive):
            raise SystemExit("package is missing required files")
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(output)
    print(f"sha256 {digest}")
    print(f"members {len(names) + 1}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
