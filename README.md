# AR Intelligence — web

Next.js static dashboard with an Upload files button (reads .xlsx/.csv in the browser), deployed to Cloudflare.

    npm install && npm run dev      # http://localhost:3000
    npm test && npm run typecheck
    npm run deploy                  # build + wrangler deploy (needs `wrangler login`)

Backend lives in the separate `backend` repo. `src/lib/core` is a temporary copy of the backend's pure logic.
