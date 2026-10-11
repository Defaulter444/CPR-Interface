#!/usr/bin/env python3
"""Validate the actual Foundry module tree and, optionally, its release archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def local_file(path: str) -> Path:
    require(isinstance(path, str) and bool(path), "Empty module path")
    relative = PurePosixPath(path)
    require(not relative.is_absolute() and ".." not in relative.parts,
            f"Module file path escapes the package: {path}")
    resolved = ROOT.joinpath(*relative.parts)
    require(resolved.is_file(), f"Missing module file: {path}")
    return resolved


def https_url(value, label):
    parsed = urlparse(value or "")
    require(parsed.scheme == "https" and parsed.netloc and not parsed.username,
            f"{label} must be a public HTTPS URL")
    return parsed


def check_manifest():
    manifest = load_json(ROOT / "module.json")
    identifier = manifest.get("id", "")
    require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", identifier),
            "Foundry module id must be a stable lowercase slug")
    version = manifest.get("version", "")
    require(re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", version),
            "Manifest version must be semver")
    require(bool(manifest.get("title")), "Manifest title is missing")
    require(bool(manifest.get("description")), "Manifest description is missing")
    compatibility = manifest.get("compatibility", {})
    require(str(compatibility.get("minimum", "")).split(".")[0] == "12",
            "This release must require Foundry v12")
    require(str(compatibility.get("verified", "")).split(".")[0] == "12",
            "Manifest must identify its v12 API target")
    require(str(compatibility.get("maximum", "")).split(".")[0] == "12",
            "Untested later Foundry majors must not be declared compatible")
    entry_points = manifest.get("esmodules", [])
    require(entry_points, "Manifest has no ES module entry point")
    for entry in entry_points:
        local_file(entry)
    styles = manifest.get("styles", [])
    require(styles, "Manifest has no bundled stylesheet")
    for stylesheet in styles:
        local_file(stylesheet)
    systems = manifest.get("relationships", {}).get("systems", [])
    require(any(system.get("id") == "cyberpunk-red-core" for system in systems),
            "Cyberpunk RED system compatibility must be declared")
    manifest_url = https_url(manifest.get("manifest"), "Manifest URL")
    download_url = https_url(manifest.get("download"), "Download URL")
    require(manifest_url.path.endswith("/module.json"),
            "Manifest URL must point to module.json")
    require(download_url.path.endswith(".zip"), "Download URL must point to a zip archive")
    require(f"/v{version}/" in download_url.path,
            "Download URL must pin the exact manifest release version")
    require(manifest_url.netloc in ("raw.githubusercontent.com", "github.com"),
            "Install manifest must be hosted on GitHub")
    require(download_url.netloc in ("github.com", "raw.githubusercontent.com"),
            "Release archive must be hosted on GitHub")
    require(manifest_url.path.strip("/").split("/")[:2] == download_url.path.strip("/").split("/")[:2],
            "Manifest and archive must belong to the same GitHub repository")
    require(download_url.path.rsplit("/", 1)[-1] == f"{identifier}-{version}.zip",
            "Release archive filename must match the module id and version")
    return manifest


def check_archive(path: Path, manifest):
    forbidden = {".git", "node_modules", "tests", "__pycache__", ".aws", ".codex"}
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        require(names and len(names) == len(set(names)), "Release has duplicate archive paths")
        prefix = f"{manifest['id']}/"
        require(f"{prefix}module.json" in names,
                "Release must contain module-id/module.json at its top level")
        require(all(name.startswith(prefix) for name in names),
                "Release must have exactly one top-level module directory")
        for name in names:
            parts = PurePosixPath(name).parts
            require(not name.startswith("/") and ".." not in parts,
                    f"Unsafe archive path: {name}")
            require(not forbidden.intersection(parts), f"Development/private content in zip: {name}")
            require(not any(part == ".env" or part.startswith(".env.") for part in parts),
                    f"Environment file in zip: {name}")
            require(not name.endswith((".pem", ".key", ".p12", ".pyc")),
                    f"Unexpected sensitive/runtime file in zip: {name}")
            local = ROOT.joinpath(*parts[1:])
            require(local.is_file(), f"Archive contains file absent from checked tree: {name}")
            require(archive.read(name) == local.read_bytes(), f"Archive/tree mismatch: {name}")
        require(json.loads(archive.read(f"{prefix}module.json")) == manifest,
                "Archive manifest differs from repository manifest")
        for name in manifest["esmodules"] + manifest["styles"]:
            require(f"{prefix}{name}" in names, f"Required module file missing from archive: {name}")
        for directory in ("assets", "data", "templates"):
            for local in (ROOT / directory).rglob("*"):
                if local.is_file():
                    relative = local.relative_to(ROOT).as_posix()
                    require(f"{prefix}{relative}" in names,
                            f"Runtime resource missing from archive: {relative}")
    print(f"PASS: archive {path.name}; {len(names)} files; exact tree match; no development/private files")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, help="Built release zip to validate")
    parser.add_argument("--references", type=Path,
                        help="Original reference directory, for exact full-description comparison")
    options = parser.parse_args()
    manifest = check_manifest()
    print(f"PASS: manifest {manifest['id']} v{manifest['version']}; Foundry v12; pinned GitHub release URLs")
    check_dataset()
    if options.references:
        check_reference_descriptions(options.references)
    if options.package:
        check_archive(options.package, manifest)


def check_dataset():
    data = load_json(ROOT / "data" / "locations.json")
    require(data.get("schemaVersion") == 1, "Unknown location data schema")
    locations = data.get("locations", [])
    require(len(locations) == 549, "The release must retain all 549 sourced locations")
    ids = [location.get("id") for location in locations]
    require(all(ids) and len(ids) == len(set(ids)), "Location IDs must be unique and nonempty")
    codes = {}
    for location in locations:
        require(bool(location.get("name")), f"Missing name: {location['id']}")
        description = location.get("description")
        require(isinstance(description, str) and bool(description.strip()),
                f"Missing full wiki description: {location['id']}")
        require(re.fullmatch(r"[a-f0-9]{64}", location.get("sourcePageSha256", "")),
                f"Missing wiki page provenance hash: {location['id']}")
        source = https_url(location.get("sourceUrl"), f"Source for {location['id']}")
        require(source.netloc == "defaulter444.github.io" and source.path.startswith("/cyberpunk-wiki/"),
                f"Description must be sourced from the user's wiki: {location['id']}")
        require(isinstance(location.get("aliases"), list), f"Aliases must be an array: {location['id']}")
        require(isinstance(location.get("originalMapReferences"), list),
                f"Original map references must be an array: {location['id']}")
        for marker in location.get("mapMarkers", []):
            code = marker.get("code")
            require(bool(re.fullmatch(r"[A-X][1-9]\d*", code or "")), f"Invalid map code: {code}")
            require(code not in codes, f"Official marker {code} assigned to multiple records")
            require(marker.get("kind") == "official", f"Source marker is not labelled official: {code}")
            for axis in ("x", "y"):
                coordinate = marker.get(axis)
                require(isinstance(coordinate, (int, float)) and not isinstance(coordinate, bool)
                        and math.isfinite(coordinate) and 0 <= coordinate <= 1,
                        f"Out-of-bounds normalized {axis} for {code}")
            codes[code] = location
    require(len(codes) == 156, f"Expected 156 unique verified map points, found {len(codes)}")
    require(len([location for location in locations if location.get("mapMarkers")]) == 156,
            "All official markers must retain their own sourced place records")
    require(codes["B1"]["name"] == "Посмертие", "B1 must identify Посмертие")
    require(any(reference.get("number") == 75 for reference in codes["B1"]["originalMapReferences"]),
            "Verified original map alias 75 -> B1 is missing")
    require(codes["F4"]["wikiSectionRef"] == "F11",
            "Official code F4 must not be confused with wiki section F11")
    require("University" in codes["F4"]["name"], "F4 must identify Night City University")
    require("Palm Grove" in codes["T3"]["name"] and codes["T10"]["name"] == "Xanadu",
            "Named places T3 and T10 must not be merged into Woodland Park")
    require(codes["T9"]["id"] not in (codes["T3"]["id"], codes["T10"]["id"]),
            "Woodland Park must have an independent record")
    image = data.get("map", {})
    image_file = local_file(image.get("path"))
    expected_hash = next((source.get("sha256") for source in data.get("provenance", {}).get("sources", [])
                          if source.get("role") == "module_display"), None)
    require(expected_hash == "6c0602bb6daac577da1df745db3792341b3d9e4d1e98efc421c28330dfc9a352",
            "Bundled display map must retain the image selected by the user")
    require(hashlib.sha256(image_file.read_bytes()).hexdigest() == expected_hash,
            "Bundled display map SHA-256 does not match provenance")
    try:
        from PIL import Image
        with Image.open(image_file) as opened:
            require(opened.size == (image.get("width"), image.get("height")) == (1200, 1855),
                    "Selected display image dimensions changed")
            opened.verify()
    except ImportError:
        # The checksum protects the exact bytes even without the optional Pillow decoder.
        require((image.get("width"), image.get("height")) == (1200, 1855),
                "Selected display image metadata dimensions changed")
    print("PASS: 549 full sourced descriptions; 156 unique bounded official points; numbering distinctions; selected map hash")


def check_reference_descriptions(directory: Path):
    locations = load_json(ROOT / "data" / "locations.json")["locations"]
    by_id = {location["id"]: location for location in locations}
    reference = load_json(directory / "wiki-location-content.json")
    require(len(reference["locations"]) == 546, "Original wiki catalog no longer contains 546 records")
    for source in reference["locations"]:
        exported = by_id.get(source["id"])
        require(exported is not None, f"Wiki location was dropped from the module: {source['id']}")
        require(exported["description"] == source["description"],
                f"Full wiki section was changed or truncated: {source['id']}")
        require(exported["sourcePageSha256"] == source["source_page_sha256"],
                f"Wiki page provenance was changed: {source['id']}")
    matched = load_json(directory / "display-map-wiki-matches.json")["markers"]
    for marker in matched:
        exported = next(location for location in locations
                        if any(point["code"] == marker["code"] for point in location["mapMarkers"]))
        if exported["descriptionScope"] != "full_location_section":
            require(exported["description"] == marker["wiki_description"],
                    f"Supplementary named place description changed: {marker['code']}")
    print("PASS: all 546 catalog descriptions and 3 supplementary place descriptions equal their full saved wiki source")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
