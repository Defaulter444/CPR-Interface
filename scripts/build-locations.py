#!/usr/bin/env python3
"""Build the module's curated location catalog from reviewed external references.

No network access or coordinate guesses are made here. The large reference archive
is deliberately kept outside the module repository and release archive.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import runpy


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def supplemental_id(marker):
    identity = marker["wiki_source_url"] + "\n" + marker["wiki_name"]
    return "wiki-place-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]


def add_alias(record, alias):
    if alias and alias != record["name"] and alias not in record["aliases"]:
        record["aliases"].append(alias)


def build(reference_root, output_root):
    content_path = reference_root / "wiki-location-content.json"
    matches_path = reference_root / "display-map-wiki-matches.json"
    crosswalk_path = reference_root / "map-location-crosswalk.json"
    assets_path = reference_root / "maps/map-assets.json"
    content = read_json(content_path)
    matches = read_json(matches_path)
    crosswalk = read_json(crosswalk_path)
    assets = read_json(assets_path)
    selected_image = next(a for a in assets if a["role"] == "module_display")
    image_path = reference_root / "maps/night-city-2045-display.jpg"
    if sha256(image_path) != selected_image["sha256"]:
        raise ValueError("The selected display image differs from its reviewed source hash")
    if (selected_image["width"], selected_image["height"]) != (1200, 1855):
        raise ValueError("Unexpected selected display-map dimensions")

    records = []
    by_id = {}
    for location in content["locations"]:
        record = {
            "id": location["id"],
            "name": location["name"],
            "district": location["district"],
            "districtLetter": location["district_letter"],
            "description": location["description"],
            "sourceUrl": location["effective_source_url"],
            "sourceCitation": location["source_citation"],
            "aliases": [],
            "originalMapReferences": [],
            "mapMarkers": [],
            "wikiSectionRef": location["wiki_section_reference"],
            "sourcePageSha256": location["source_page_sha256"],
            "descriptionScope": "full_location_section",
            "sourceCorrectionUsed": location["source_correction_used"],
        }
        if record["id"] in by_id:
            raise ValueError("Duplicate source ID: " + record["id"])
        records.append(record)
        by_id[record["id"]] = record

    by_map_code = {}
    for marker in matches["markers"]:
        if marker["match_status"] != "matched":
            raise ValueError("Unreviewed map marker: " + marker["code"])
        scope = marker["description_scope"]
        if scope in ("named_sublocation_paragraph", "full_wiki_article_section"):
            # A grove and a club have distinct map positions even though the wiki
            # describes them inside Woodland Park. The park's T9 is retained on
            # the base record; T3 and T10 belong only to these separate records.
            record = {
                "id": supplemental_id(marker),
                "name": marker["wiki_name"],
                "district": marker["wiki_district"],
                "districtLetter": marker["code"][0],
                "description": marker["wiki_description"],
                "sourceUrl": marker["wiki_source_url"],
                "sourceCitation": marker["wiki_source_citation"],
                "aliases": [],
                "originalMapReferences": [],
                "mapMarkers": [],
                "wikiSectionRef": (
                    by_id[marker["wiki_id"]]["wikiSectionRef"]
                    if marker["wiki_id"] in by_id else None
                ),
                "sourcePageSha256": marker["wiki_source_page_sha256"],
                "descriptionScope": scope,
                "parentWikiId": marker["wiki_id"],
                "sourceCorrectionUsed": False,
            }
            if record["id"] in by_id:
                raise ValueError("Duplicate supplementary place ID")
            records.append(record)
            by_id[record["id"]] = record
        else:
            record = by_id[marker["wiki_id"]]
            if record["description"] != marker["wiki_description"]:
                raise ValueError("Reviewed marker description differs from full source section")
        coordinates = marker["coordinates"]
        if coordinates["unit"] != "normalized" or coordinates["origin"] != "top-left":
            raise ValueError("Unsupported marker coordinate convention")
        x, y = coordinates["x"], coordinates["y"]
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ValueError("Marker coordinates outside the image")
        code = marker["code"]
        if code in by_map_code:
            raise ValueError("Duplicate official marker code: " + code)
        record["mapMarkers"].append({"code": code, "x": x, "y": y, "kind": "official"})
        add_alias(record, marker["atlas_name"])
        by_map_code[code] = record

    verified_original_count = 0
    for original in crosswalk["first_map_places"]:
        if original["match_status"] != "matched_both_maps":
            continue
        verified_original_count += 1
        for code in original["display_codes"]:
            record = by_map_code[code]
            source_id = record.get("parentWikiId") or record["id"]
            if source_id not in original["wiki_ids"]:
                raise ValueError("Original-map match differs from the reviewed physical place: " + code)
            record["originalMapReferences"].append({
                "number": original["number"], "name": original["name"]
            })
            add_alias(record, original["name"])

    # Preserve the catalog's source ordering and append the reviewed supplementary
    # places in map order. This is stable across runs and independent of timestamps.
    mapped_count = sum(bool(r["mapMarkers"]) for r in records)
    expected = (len(content["locations"]), len(records), len(by_map_code), verified_original_count)
    if expected != (546, 549, 156, 24):
        raise ValueError("Unexpected reviewed reference counts: " + repr(expected))
    woodland = by_map_code["T9"]
    if [m["code"] for m in woodland["mapMarkers"]] != ["T9"]:
        raise ValueError("Woodland Park must not absorb the grove or club markers")
    if len({by_map_code[c]["id"] for c in ("T3", "T9", "T10")}) != 3:
        raise ValueError("The three Woodland Park places must have separate IDs")
    if any(not r["description"] or not r["sourceUrl"].startswith("https://") for r in records):
        raise ValueError("A location is missing its source description or HTTPS citation")

    data = {
        "schemaVersion": 1,
        "map": {"path": "assets/night-city-2045.jpg", "width": 1200, "height": 1855},
        "stats": {
            "wikiCatalogLocations": len(content["locations"]),
            "supplementaryLocations": len(records) - len(content["locations"]),
            "totalLocations": len(records),
            "officialMarkers": len(by_map_code),
            "mappedLocations": mapped_count,
            "unmappedLocations": len(records) - mapped_count,
            "cityDistricts": 24,
            "wikiDistrictGroups": len({r["district"] for r in records}),
            "originalMapPlaces": len(crosswalk["first_map_places"]),
            "originalMapVerifiedMatches": verified_original_count,
            "originalMapAmbiguous": crosswalk["summary"]["ambiguous"],
            "originalMapUnresolved": crosswalk["summary"]["unresolved"],
        },
        "provenance": {
            "wikiUrl": "https://defaulter444.github.io/cyberpunk-wiki/",
            "descriptionSource": "Full wiki sections; exact named-place paragraphs for T3/T10; full park article for W5.",
            "coordinateConvention": "Normalized 0–1 coordinates, top-left origin.",
            "coordinateMeaning": "Centers of printed official PDF map labels, not surveyed entrances or building footprints.",
            "numberingRule": "Official Atlas codes, original fan-map numbers and wiki section numbers are separate systems.",
            "sources": [
                {"file": path.relative_to(reference_root).as_posix(), "sha256": sha256(path)}
                for path in (content_path, matches_path, crosswalk_path, assets_path)
            ] + [
                {"role": a["role"], "url": a["url"], "sha256": a["sha256"]}
                for a in assets if a["role"] in ("module_display", "marker_coordinate_source", "marker_name_reference")
            ],
        },
        "locations": records,
    }
    apply_review = runpy.run_path(str(Path(__file__).with_name('apply-book-reference.py')))['apply_book_reference']
    data = apply_review(data)
    output_path = output_root / "data/locations.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    image_output = output_root / data["map"]["path"]
    image_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(image_path, output_root / 'assets/night-city-2045.jpg')
    reviewed_image = Path(__file__).resolve().parents[1] / data['map']['path']
    if reviewed_image.resolve() != image_output.resolve():
        shutil.copyfile(reviewed_image, image_output)
    reviewed_hash = next(source['sha256'] for source in data['provenance']['sources'] if source.get('role') == 'module_display')
    if sha256(image_output) != reviewed_hash:
        raise ValueError("Copied image failed SHA-256 verification")
    print(f"Built {len(records)} wiki places, {len(by_map_code)} official markers and {verified_original_count} original-map references.")
    print(f"Unmapped source places: {len(records) - mapped_count}. Reviewed book references and clean map applied.")
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references", type=Path, default=Path("/workspace/cpr-dev-environment/references"))
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    build(args.references.resolve(), args.output_root.resolve())
