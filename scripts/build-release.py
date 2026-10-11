#!/usr/bin/env python3
"""Build a deterministic Foundry package with only explicit runtime files."""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'module.json').read_text())
version = manifest['version']
module_id = manifest['id']
assert json.loads((ROOT / 'package.json').read_text())['version'] == version
files = ['module.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE.md']
files += [str(path.relative_to(ROOT)) for folder in ('scripts', 'styles', 'templates', 'data', 'assets')
          for path in sorted((ROOT / folder).rglob('*'))
          if path.is_file() and path.suffix in ('.js', '.css', '.hbs', '.json', '.jpg', '.webp', '.png', '.svg')]
assert 'scripts/main.js' in files and 'data/locations.json' in files
out = ROOT / 'dist'
out.mkdir(exist_ok=True)
archive = out / f'{module_id}-{version}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for filename in sorted(files):
        raw = (ROOT / filename).read_bytes()
        info = zipfile.ZipInfo(f'{module_id}/{filename}', date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, raw)
shutil.copyfile(ROOT / 'module.json', out / 'module.json')
checksums = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (archive, out / 'module.json')}
(out / 'SHA256SUMS.txt').write_text(''.join(f'{digest}  {name}\n' for name, digest in checksums.items()))
print(json.dumps({'archive': str(archive), 'runtime_files': len(files), 'bytes': archive.stat().st_size, 'sha256': checksums[archive.name]}))
