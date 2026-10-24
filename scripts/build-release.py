#!/usr/bin/env python3
"""Build a deterministic Foundry package with only explicit runtime files."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'module.json').read_text())
# --preview builds the test channel served from the development branch; that ZIP embeds the preview manifest.
PREVIEW = '--preview' in sys.argv
PREVIEW_URL = 'https://raw.githubusercontent.com/Defaulter444/CPR-Interface/refs/heads/claude/pensive-rubin-8opsg3/distribution/preview/'
version = manifest['version']
module_id = manifest['id']
assert json.loads((ROOT / 'package.json').read_text())['version'] == version
files = ['module.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE.md']
files += [path.relative_to(ROOT).as_posix() for folder in ('scripts', 'styles', 'templates', 'data', 'assets')
          for path in sorted((ROOT / folder).rglob('*'))
          if path.is_file() and path.suffix in ('.js', '.css', '.hbs', '.json', '.jpg', '.webp', '.png', '.svg')]
# LevelDB compendium: data, manifest and journal files; locks and debug logs stay out.
files += [path.relative_to(ROOT).as_posix() for path in sorted((ROOT / 'packs').rglob('*'))
          if path.is_file() and path.name not in ('LOCK', 'LOG', 'LOG.old')]
assert 'scripts/main.js' in files and 'data/locations.json' in files
out = ROOT / 'distribution' / 'preview' if PREVIEW else ROOT / 'dist'
out.mkdir(parents=True, exist_ok=True)
if PREVIEW:
    manifest |= {'manifest': PREVIEW_URL + 'module.json', 'download': PREVIEW_URL + f'{module_id}-{version}.zip'}
manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8') if PREVIEW else (ROOT / 'module.json').read_bytes()
archive = out / f'{module_id}-{version}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for filename in sorted(files):
        raw = manifest_bytes if filename == 'module.json' else (ROOT / filename).read_bytes()
        info = zipfile.ZipInfo(f'{module_id}/{filename}', date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, raw)
(out / 'module.json').write_bytes(manifest_bytes)
checksums = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (archive, out / 'module.json')}
(out / 'SHA256SUMS.txt').write_text(''.join(f'{digest}  {name}\n' for name, digest in checksums.items()))
print(json.dumps({'archive': str(archive), 'runtime_files': len(files), 'bytes': archive.stat().st_size, 'sha256': checksums[archive.name]}))
