#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Ziya Karakaya
# SPDX-License-Identifier: GPL-2.0-or-later
"""Validate and package the explicitly listed public extension files."""

import argparse
import io
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
UUID = "ard-window-list@ziyakarakaya.github.io"
SCHEMA_ID = "org.gnome.shell.extensions.window-list-custom"
SCHEMA_FILE = f"schemas/{SCHEMA_ID}.gschema.xml"
JAVASCRIPT = (
    "extension.js", "prefs.js", "workspacePrefs.js", "workspaceIndicator.js",
)
# An allowlist prevents local files and new development artifacts leaking into ZIPs.
RELEASE_FILES = (
    "metadata.json",
    *JAVASCRIPT,
    "stylesheet-dark.css",
    "stylesheet-light.css",
    "stylesheet-workspace-switcher-dark.css",
    "stylesheet-workspace-switcher-light.css",
    SCHEMA_FILE,
    "LICENSE",
    "README.md",
    "ATTRIBUTION.md",
    "data/ard-window-list-preferences.desktop",
)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate metadata key: {key}")
        result[key] = value
    return result


def validate(sources):
    metadata = json.loads(sources["metadata.json"], object_pairs_hook=unique_object)
    expected = {
        "uuid": UUID,
        "name": "ARD Window List",
        "extension-id": "ard-window-list",
        "settings-schema": SCHEMA_ID,
        "url": "https://github.com/ziyakarakaya/ard-window-list",
        "shell-version": ["50"],
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"metadata.json: expected {key} = {value!r}")
    description = metadata.get("description")
    if not isinstance(description, str) or not description.startswith(
        "Adaptive Responsive Desktop Window List:"
    ):
        raise ValueError("metadata.json: missing full project name in description")

    schema = ET.fromstring(sources[SCHEMA_FILE]).find("schema")
    if schema is None or schema.get("id") != SCHEMA_ID or schema.get("path") != (
        "/org/gnome/shell/extensions/window-list-custom/"
    ):
        raise ValueError("Schema ID/path must preserve existing user settings")

    subprocess.run(
        ["glib-compile-schemas", "--strict", "--dry-run", "schemas"],
        cwd=ROOT, check=True,
    )
    for filename in JAVASCRIPT:
        subprocess.run(
            ["node", "--input-type=module", "--check"],
            input=sources[filename], cwd=ROOT, check=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path,
        default=Path("dist") / f"{UUID}.shell-extension.zip",
        help="new ZIP path inside this repository (existing files are never overwritten)",
    )
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(ROOT) or output.suffix != ".zip":
        raise ValueError("Output must be a .zip file inside this repository")
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}; choose another --output")

    sources = {}
    for filename in RELEASE_FILES:
        path = ROOT / filename
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError(f"Release input must be a regular repository file: {filename}")
        sources[filename] = path.read_bytes()
    validate(sources)

    # Fixed timestamps and modes make unchanged inputs produce identical ZIPs.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename, contents in sources.items():
            entry = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, contents)

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as target:
        target.write(buffer.getvalue())
    print(f"Validated metadata, schema, and {len(JAVASCRIPT)} JavaScript modules.")
    print(f"Created {output.relative_to(ROOT)} ({len(sources)} files).")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, ET.ParseError, subprocess.CalledProcessError) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        sys.exit(1)
