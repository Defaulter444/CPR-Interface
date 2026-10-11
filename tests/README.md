# Validation scope

The package checker validates the installable archive and the bundled source data.
The Node tests execute the actual module entry point with small Foundry v12 API
mocks. The browser tests compile the real Handlebars template, load the actual
map controller and stylesheet, and drive Chromium with Playwright.

These checks do not claim a licensed Foundry server integration test. A GM must
also install the release in Foundry v12, activate it in a Cyberpunk RED world,
open the atlas, and verify persistent world settings after a server restart.

Test servers bind to localhost, use an ephemeral port, and are stopped in
`finally` blocks. The browser harness is a development test only and is excluded
from the distributable module.

Run `npm ci --ignore-scripts`, `npm test`, `npm run check`, and `npm run build`.
Then run `python3 scripts/check-package.py --package dist/night-city-2045-atlas-0.1.0.zip`.
Pass `--references /path/to/references` to also compare all 549 descriptions with
the saved full wiki source records. The browser suite additionally needs the
Python `playwright` package and a Chromium binary; run `npm run test:browser`.
Set `CHROMIUM` or pass `--chromium` when it is not installed at
`/usr/bin/chromium`. Handlebars comes from the locked development dependency;
`--handlebars` can identify an existing browser bundle in a different setup.
