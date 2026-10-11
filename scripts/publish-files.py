#!/usr/bin/env python3
"""Prepare immutable public GitHub files; does not perform network writes."""
import hashlib
import json
from pathlib import Path

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'module.json').read_text())
identifier,version=manifest['id'],manifest['version']
output=root/'releases'/f'v{version}'
output.mkdir(parents=True,exist_ok=True)
for name in ('module.json',f'{identifier}-{version}.zip','SHA256SUMS.txt'):
    source=root/'dist'/name
    raw=source.read_bytes()
    target=output/name
    if target.exists() and target.read_bytes()!=raw:
        raise SystemExit(f'Refusing to overwrite an existing release with different bytes: {target}. Increment the module version.')
    if not target.exists(): target.write_bytes(raw)
    print(f'{name}: {len(raw)} bytes; SHA-256 {hashlib.sha256(raw).hexdigest()}')
