# LinkScope — Firebase Link Decoder

A fast, Android-friendly, **100% offline** web tool that decodes `?s=`-style encoded share links, breaks the payload into labelled fields, and extracts Firebase URLs. Supports **single links** and **mass/bulk lists**.

> **Privacy / safety:** this is a text parser only. It never fetches a Firebase database, never tests credentials, never sends pasted data anywhere, and makes no network requests at runtime.

---

## What it decodes

The `s=` parameter in the example links is UTF-8 Base64. Decoded, it has this shape:

```text
FIREBASE_URL | CREDENTIAL | EXPIRY_MS | OPTIONAL_DEVICE_ID

https://project-default-rtdb.firebaseio.com | KEY | 1793105515015 | device-123
```

Fields can be separated by a single `|` or by the older triple `|||` separator.
Both forms are recognised, and empty fields (which `|||` produces) are skipped
while the remaining fields keep their original position and labels.

Some apps wrap the same details as Base64 over XOR-encoded JSON instead. The
**VANTAGE** share links, for example, decode to:

```json
{"u":"https://project-default-rtdb.firebaseio.com","k":"CREDENTIAL","l":"Connected","e":0}
```

`u` is the database URL, `k` the credential, `l` a label and `e` an expiry in
milliseconds (`0` means the link is permanent). LinkScope detects this layout
automatically and reports it as a **VANTAGE share link**.

The tool also accepts:

- full share URLs such as `https://example.net/?s=BASE64`
- raw `s=BASE64` values
- raw Base64 (standard **and** URL-safe `-` / `_`)
- double Base64 encoding
- already-decoded `|` (single-pipe) and `|||` (triple-pipe) payloads
- VANTAGE share links — Base64 over XOR-encoded JSON (`u` / `k` / `l` / `e`)
- direct Firebase URLs, with or without `https://`
- JSON objects and URL-encoded query-string payloads
- `.txt`, `.csv`, `.json`, `.log` file uploads and drag-and-drop
- markdown links, comma-separated lists, and mixed text

Recognised Firebase hosts include `*.firebaseio.com`, `*.firebasedatabase.app`, `*.firebaseapp.com`, `*.firebasestorage.app`, `*.appspot.com`, and `*.web.app`.

---

## Features

- **Single mode** — live decode, status badge, project ID, host type, region, expiry, masked credential, device ID, full field breakdown, raw payload, copy buttons.
- **Bulk mode** — check thousands of items, duplicate detection, search, status filters, progressive rendering, unique-URL count, API-key count.
- **Exports** — copy unique Firebase URLs, copy JSON, download CSV, download JSON.
- **Android-first UI** — 44px+ tap targets, 16px inputs to prevent zoom, safe-area bottom bar, no hover-only actions, reduced-motion support, high-contrast dark theme.
- **Tailwind CSS file** — `assets/tailwind.css` is a compiled, local Tailwind build. No CDN, no external fonts, no runtime dependencies.
- **Standalone build** — `standalone.html` inlines the CSS and JS into one file for easy sharing.

---

## Quick start

```bash
cd firebase-link-decoder
npm install          # only needed to rebuild CSS
npm start            # serves on http://0.0.0.0:8080
```

Or simply open `index.html` / `standalone.html` directly in a browser — both work without a server.

### Rebuild after editing styles or scripts

```bash
npm run build        # recompiles Tailwind CSS and regenerates standalone.html
node tests/decode-s.test.js   # runs the decoder test suite
```

---

## Command-line decoder (`decode-s.js`)

`decode-s.js` is a dependency-free Node script for `?s=` links — both the
single-pipe payloads and VANTAGE share links (Base64 + XOR JSON). It accepts a
full share URL, a bare `s=` value, an `s=...` assignment, or `-` to read one
value per line from stdin, and prints the Firebase URL to paste into
`panels.txt`.

```bash
node decode-s.js "https://site.netlify.app/?s=XXXX"
node decode-s.js XXXX
node decode-s.js "s=XXXX"
node decode-s.js XXXX --quiet    # print only the Firebase URL
node decode-s.js XXXX --json     # print the full decoded result as JSON
cat links.txt | node decode-s.js - --quiet
```

Output:

```text
============================================================
input      : https://site.netlify.app/?s=XXXX
raw        : https://project-default-rtdb.firebaseio.com|KEY|1793105515015|device-123
firebase   : https://project-default-rtdb.firebaseio.com/
trailing   : KEY | 1793105515015 | device-123
============================================================

→ drop this in panels.txt:
   https://project-default-rtdb.firebaseio.com/
```

It pads missing Base64 padding, switches to the URL-safe alphabet
(`-` / `_`) when needed, ignores empty `|||` fields, and exits non-zero
(`1` usage, `3` decode failure) when nothing usable was found. VANTAGE links also
report their credential, label and expiry (`permanent` when `e` is `0`):

```bash
node decode-s.js "https://vantagepanel.netlify.app/?s=XXXX" --json
```

In the browser and bulk modes the same formats are handled by `decoder.js`,
which reports them as **Pipe-delimited payload** or **VANTAGE share link**.

---

## File structure

```text
firebase-link-decoder/
├── index.html              # Main app (uses local CSS + JS files)
├── standalone.html         # Generated single-file version
├── assets/
│   └── tailwind.css        # Compiled Tailwind CSS (local file)
├── src/
│   └── input.css           # Tailwind source + component styles
├── tailwind.config.js      # Tailwind content scanning config
├── decoder.js              # Pure JS decoding core (browser + Node/UMD)
├── decode-s.js             # CLI for single-pipe payloads (?s= → Firebase URL)
├── app.js                  # UI logic (no network calls)
├── server.js               # Zero-dependency static preview server
├── build-standalone.js     # Generates standalone.html
├── sample-links.txt        # The two example links from the request
├── tests/
│   └── decode-s.test.js    # CLI + decoder-core unit tests
├── netlify.toml            # Optional Netlify deploy config + CSP
└── README.md
```

---

## Deploy to Netlify

The project is a static site. A ready-to-upload package is provided as **`linkscope-netlify.zip`** (see `DEPLOY.md` for the full walkthrough).

Fastest path — **Netlify Drop**:

1. Download `linkscope-netlify.zip` and extract it, or drag the ZIP directly.
2. Go to <https://app.netlify.com/drop>.
3. Drag the extracted `linkscope-netlify/` folder (or the ZIP) onto the drop zone.
4. Netlify gives you a live `https://<name>.netlify.app` URL immediately.
5. Sign in / claim the site so it persists, then optionally rename it or add a custom domain.

For a Git-connected deploy, import the repository into Netlify. Build command: `echo 'LinkScope uses prebuilt static assets — no build step required.'`; publish directory: `.` (already set in `netlify.toml`).

`netlify.toml` is included with:

- `connect-src 'none'` in the CSP — enforces the no-network promise.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- no external asset dependencies.

After deployment you can share links like `https://<your-site>.netlify.app/?s=<BASE64>` and the tool auto-decodes them on load.

---

## Notes

- Credentials and API keys are **masked by default**. Use **Reveal keys** to show them.
- Bulk mode reports unrecognised lines as `Invalid` so nothing is silently skipped.
- `Hide duplicates` removes repeated Firebase endpoints from the visible list while still counting them in stats. The **Duplicates** filter still shows them.
- Large inputs are capped at 1.5 MB / 20,000 items to keep the UI responsive.
- Expiry timestamps support milliseconds, seconds, and ISO date strings.

---

Built for Arena.ai Agent Mode. No analytics, no telemetry, no tracking.
