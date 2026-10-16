"""Apply reviewed, factual book references without bundling the source PDF."""
from pathlib import Path
import json
import math

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / 'references/night-city-2045-book.json'


def apply_book_reference(data):
    reference = json.loads(REFERENCE.read_text(encoding='utf-8'))
    by_id = {location['id']: location for location in data['locations']}
    seen = set()
    for entry in reference['locations']:
        location = by_id[entry['locationId']]
        code = entry['atlasCode']
        if code in seen:
            raise ValueError(f'Duplicate reviewed map code: {code}')
        seen.add(code)
        if [marker['code'] for marker in location['mapMarkers']] != [code]:
            raise ValueError(f'Reviewed code no longer identifies its original place: {code}')
        location['bookReference'] = dict(entry['bookReference'])
        corrections = entry.get('descriptionCorrections', [])
        for correction in corrections:
            if correction['from'] in location['description']:
                location['description'] = location['description'].replace(correction['from'], correction['to'])
            elif correction['to'] not in location['description']:
                raise ValueError(f'Reviewed source phrase no longer matches: {code}')
        if corrections:
            location['descriptionCorrections'] = corrections
        position = entry.get('position')
        if position:
            if not all(isinstance(position[key], (int, float)) and math.isfinite(position[key])
                       and 0 <= position[key] <= 1 for key in ('x', 'y')):
                raise ValueError(f'Invalid reviewed position: {code}')
            marker = location['mapMarkers'][0]
            marker.update({key: position[key] for key in ('x', 'y')})
            marker['coordinateSource'] = position['source']
    if len(seen) != 156:
        raise ValueError(f'Expected all 156 reviewed places, found {len(seen)}')
    data['provenance']['bookReview'] = reference['source']
    map_image = reference['mapImage']
    data['map'] = {key: map_image[key] for key in ('path', 'width', 'height', 'imageWidth', 'imageHeight')}
    for source in data['provenance']['sources']:
        if source.get('role') == 'module_display' and source.get('sha256') != map_image['sha256']:
            source['role'] = 'legacy_module_display'
    if not any(source.get('role') == 'module_display' for source in data['provenance']['sources']):
        data['provenance']['sources'].append({'role': 'module_display', 'url': map_image['sourceUrl'],
            'sha256': map_image['sha256'], 'archiveEntry': map_image['archiveEntry'],
            'sourceImageSHA256': map_image['sourceImageSHA256'], 'rendering': map_image['rendering']})
    data['provenance']['coordinateMeaning'] = '154 centers of Night City 2045 (2026) map labels projected onto the common basemap; 2 Atlas 2025 area references. These are map-label anchors, not surveyed entrances.'
    data['provenance']['descriptionSource'] = 'Full wiki sections, with three explicitly recorded phrase corrections checked against Night City 2045 (2026); named-place paragraphs for T3/T10 and full park article for W5.'
    return data


if __name__ == '__main__':
    target = ROOT / 'data/locations.json'
    data = apply_book_reference(json.loads(target.read_text(encoding='utf-8')))
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('Applied 156 reviewed Night City 2045 book references.')
