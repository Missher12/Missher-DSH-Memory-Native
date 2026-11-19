#!/usr/bin/env python3
"""Assemble the browser source parts into the single DSH client entry."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "client-src"
OUTPUT = ROOT / "client.js"
PARTS = [
    "00-module-shell.js",
    "10-dictionaries.js",
    "20-style-transport.js",
    "30-shared-ui.js",
    "40-activity-reports.js",
    "50-settings.js",
    "60-knowledge-library.js",
    "70-capture-health.js",
    "80-memory-panel.js",
    "90-plugin-entry.js",
]


def assembled_client() -> str:
    return "".join((SOURCE / part).read_text(encoding="utf-8") for part in PARTS)


def main() -> int:
    result = assembled_client()
    if "--check" in sys.argv[1:]:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != result:
            print("client.js is stale; run python3 scripts/build-client.py", file=sys.stderr)
            return 1
        print(f"client.js matches {len(PARTS)} source parts")
        return 0
    with OUTPUT.open("w", encoding="utf-8", newline="\n") as output:
        output.write(result)
    print(f"built client.js from {len(PARTS)} source parts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
