# Excel-as-DB POC — People Dashboard

## 1. Purpose

Answer one question: **can I edit an Excel workbook in OneDrive, refresh a static website, and see the new data without rebuilding or redeploying?**

Dummy data only. No auth, backend, database, Entra, or Microsoft Graph.

> ⚠️ **Security warning**
> This POC uses an anonymously accessible OneDrive workbook.
> Do not use this architecture for confidential, customer,
> financial, SAP, AR, or production data.

## 2. Architecture

Next.js (App Router, TypeScript, Tailwind) with `output: "export"` → static files in `out/`, hosted on Cloudflare Pages. No API routes, server actions, SSR, or middleware. The Excel file is never touched at build time; the **browser** fetches it at runtime.

```
OneDrive → fetch (browser) → ArrayBuffer → XLSX.read → worksheet → JSON → React state → HTML table
```

## 3–4. Retrieval and parsing

`src/lib/excel.ts`:

- `fetchWorkbook()` – `fetch(url + "&_=" + Date.now(), { cache: "no-store" })`, 15 s timeout.
- `parseWorkbook()` – checks the `PK` zip signature (rejects HTML viewer/login pages), then `XLSX.read`.
- `normalizeRows()` – maps headers case-insensitively (not row-number based), drops empty rows, defaults missing cells to `""`.
- `loadPeople()` – runs the whole pipeline.

Fallback demo rows exist (`DEMO_ROWS`) but are shown only when the user clicks "Show demo data", and are labeled as demo.

## 5–6. Run and build

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # generates ./out
```

## 7. Cloudflare Pages

Connect the GitHub repo. Production branch: `master` (this repo uses `master`; use `main` if you rename it). Build command: `npm run build`. Build output directory: `out`.

## 8. Changing the Excel URL

Edit `src/lib/config.ts`, or set `NEXT_PUBLIC_EXCEL_URL` (see `.env.example`; set it in Cloudflare Pages env vars). Only the URL is baked in at build time, never the data.

## 9–10. OneDrive public-link findings and CORS

Investigated on 2026-09-29 with `curl` (a real-browser test was not possible: the Chrome extension was not connected). Each step below was observed:

1. `https://1drv.ms/x/c/...?e=...` → **301** to `onedrive.live.com/:x:/g/personal/...` → **302** to the Excel web viewer (`Doc.aspx`). Not XLSX bytes.
2. Appending `?download=1` → 301 → **302 to `/personal/<cid>/Documents/People.xlsx?redeem=...`** → **200 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`**. A real XLSX (5 columns, header + 3 rows) is obtainable, **but only when cookies are carried across the redirects**: the middle hop sets a `FedAuth` cookie that the final hop requires. Without a cookie jar the chain ends at a Microsoft login redirect / 403.
3. **No `Access-Control-Allow-Origin` header on any hop** (1drv.ms, the redirect hops, or the final file response).
4. Anonymous `api.onedrive.com/v1.0/shares/u!.../root/content` returns `401 unauthenticated` for this link (it does send `access-control-allow-origin: *`, but requires auth). `graph.microsoft.com` returns `InvalidAuthenticationToken`.

**Conclusion (expected, not yet browser-verified):** a cross-origin browser `fetch` from your Cloudflare Pages origin will fail. The browser requires CORS headers on the response (and on redirect hops), none are sent, and the required `FedAuth` cookie is a third-party cookie that cross-site `fetch` will not send or store by default. The app will show "blocked by CORS / network error" and the Debug panel will report `NETWORK_OR_CORS`. **Please confirm by deploying/running and opening Debug Information** — if it unexpectedly works, the POC succeeds as built.

The app does not fake success: if the fetch fails you see an error, and demo data is only shown on explicit request, labeled.

### Relay Worker (implemented)

Because direct browser access is blocked, `worker/` contains a small Cloudflare Worker that downloads the workbook server-side (following redirects and keeping the `FedAuth` cookie) and returns it with CORS headers. The site fetches from the Worker instead of OneDrive. Verified locally with `wrangler dev`: returns a valid XLSX with `Access-Control-Allow-Origin`. The OneDrive URL is fixed in `worker/wrangler.toml` (not accepted from the request, so it is not an open proxy).

Local:
```bash
npm run worker:dev   # terminal 1 → http://localhost:8787
npm run dev          # terminal 2 → http://localhost:3000
```
Deploy:
```bash
npx wrangler login
npm run worker:deploy            # prints https://poc-hazel-excel-relay.<sub>.workers.dev
```
Then set `NEXT_PUBLIC_EXCEL_URL` to that URL in Cloudflare Pages → Settings → Environment variables, redeploy the site once, and set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your Pages URL. This relies on undocumented OneDrive redirect behavior and the file is still publicly readable, so the security warning still applies.

### Alternatives considered

Authenticated access via Microsoft Graph is the supported route (below). If you only need a public, CORS-enabled file for the POC, host the exported file somewhere that sends CORS headers (e.g. SharePoint anonymous links from a work/school tenant are also not CORS-enabled; an Azure Blob/Cloudflare R2 public object with a CORS rule is), at the cost of an upload step, which defeats the "just edit in OneDrive" goal. A backend/Worker proxy would work technically but was deliberately not added.

## 11. Production direction

```
Microsoft Entra ID
        ↓
Authenticated application
        ↓
Microsoft Graph
        ↓
SharePoint / OneDrive for Business
        ↓
Excel
        ↓
Dashboard
```

## Notes

- `xlsx@0.18.5` (npm) has known advisories (prototype pollution, ReDoS) with the fix only in SheetJS's own CDN builds. Acceptable for a dummy-data POC; switch to the SheetJS CDN package before real use.
- Future: AR Aging & Collections Dashboard (SAP FBL5N / DZ payments). `src/lib/excel.ts` and `src/types/` are the extension points; not implemented now.
