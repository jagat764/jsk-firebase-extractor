# Deploy LinkScope to Netlify

You do **not** need to rebuild anything. The tool is a prebuilt static site: plain HTML, a compiled local Tailwind CSS file, and vanilla JavaScript. No server, no API keys, no environment variables.

## Option 1 — Netlify Drop (fastest, ~30 seconds)

1. Download **`linkscope-netlify.zip`** from the workspace.
2. Extract it. You will get a folder named `linkscope-netlify/`.
3. Open <https://app.netlify.com/drop> in Chrome/Edge (or another Chromium browser).
4. Drag the **`linkscope-netlify/` folder** onto the drop zone.
   - You can also drag the ZIP file directly; Netlify Drop accepts folders, files, and ZIPs.
   - Make sure `index.html` is at the **root** of the folder you drop.
5. Netlify publishes it instantly and shows a preview URL ending in `.netlify.app`.
6. **Sign in / claim the site** so it is not treated as a temporary anonymous deploy.
7. Optional: in **Site configuration → Site details**, change the site name, e.g. `linkscope-decoder.netlify.app`.
8. Optional: add a custom domain under **Domain management**.

### Update the site later
Open the site in Netlify → **Deploys** → drag the updated `linkscope-netlify/` folder onto the deploy dropzone. The same `.netlify.app` URL stays live.

## Option 2 — Import from GitHub / GitLab / Bitbucket

1. Push this project to a new Git repository.
2. In Netlify, choose **Add new site → Import an existing project**.
3. Pick your Git provider and repository.
4. Netlify reads `netlify.toml` automatically:
   - **Build command:** `echo 'LinkScope uses prebuilt static assets — no build step required.'`
   - **Publish directory:** `.`
5. Click **Deploy**. Every future `git push` triggers a new deploy.

## Option 3 — Netlify CLI

```bash
npm install -g netlify-cli
netlify login
cd firebase-link-decoder
netlify deploy --dir=. --prod
```

If you want the CLI to manage the site settings, run `netlify init` once and follow the prompts.

## What gets deployed

```text
linkscope-netlify/
├── index.html              # Main app (uses local Tailwind CSS file)
├── standalone.html         # Single-file version, also deployable
├── assets/
│   └── tailwind.css        # Compiled Tailwind CSS (local)
├── decoder.js              # Decoder core
├── app.js                  # UI logic
├── netlify.toml            # Build + security headers
├── sample-links.txt        # Example links
├── README.md
└── DEPLOY.md               # This file
```

## After deployment

- Open `https://<your-site>.netlify.app/` — Single mode is selected by default.
- Paste one encoded URL and tap **Decode & inspect**, or switch to **Bulk** and paste/drop a list.
- Share auto-decoding links like:
  `https://<your-site>.netlify.app/?s=<BASE64_VALUE>`
- `standalone.html` is also available at `https://<your-site>.netlify.app/standalone.html`.

## Notes

- Netlify recommends deploys under **50 MB**; this package is far below that.
- The CSP in `netlify.toml` sets `connect-src 'none'`, so the deployed tool cannot make network requests to Firebase or anywhere else.
- If the page looks unstyled after a manual upload, confirm that the `assets/` folder was included next to `index.html`.
- No build step is required because `assets/tailwind.css` is already compiled. If you edit `src/input.css`, run `npm run build` locally first, then redeploy.
