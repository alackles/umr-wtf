# umr-wtf

A medical plan chooser that shows the trade, not a verdict.

Answer a short questionnaire (or import a table of real claim lines) and it replays your
year under each plan's rules: premiums only, a typical year, a catastrophic year, and the
worst case. It flags any plan that is not the cheapest in any of those years, and says
what the extra premium on the others buys.

One self-contained HTML page. It makes no network requests, and carries a
Content-Security-Policy that tells the browser to block any.

## Layout

| Path | What it is |
|---|---|
| `src/plans.js` | Plan configuration schema and helpers |
| `src/engine.js` | The replay engine: a generic interpreter of cost-sharing rules |
| `src/estimator.js` | Backs charges out of "deductible met" and "out-of-pocket met" |
| `src/household.js` | Questionnaire answers, or an imported table, to line items |
| `src/outlook.js` | Scenarios, take-home and raw views, the never-cheapest rule, break-even |
| `src/importer.js` | CSV and JSON import |
| `src/seal.js` | Encrypts and decrypts the plan data (WebCrypto: PBKDF2-SHA-256, AES-GCM) |
| `src/ui/` | The page |
| `demo/plans.demo.json` | Invented plans, for the demo build and the tests |
| `build.js` | Builds the single file |
| `seal.js` | Seals a plan configuration with a passphrase, for the public site |
| `site/plans.sealed.json` | The sealed plan data the public site is built from |

## Use

    npm test            # node --test, no dependencies (Node 18+)
    npm run build       # demo plans -> dist/index.html
    node build.js --config path/to/plans.json --out path/to/page.html

## The public site

The site on GitHub Pages carries the real plan data only in encrypted form, behind a
passphrase box. The passphrase decrypts it in the browser; nothing is sent anywhere.
Capitals and extra spaces in the passphrase don't matter.

    node seal.js --config path/to/plans.json     # asks for the passphrase; writes site/plans.sealed.json
    node build.js --sealed site/plans.sealed.json --out _site/index.html

Sealing is a separate step from building, run only when the plans change. On every push to
`main`, `.github/workflows/pages.yml` runs the tests, builds the sealed page, and publishes it.

The plans in `demo/` are invented. Real plan data is kept out of this repository except as
ciphertext.
Unofficial; estimates only.
