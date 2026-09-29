/**
 * Relay Worker: downloads the shared OneDrive workbook server-side and returns it with CORS headers.
 * OneDrive's download link needs a FedAuth cookie set mid-redirect, which browsers won't do cross-origin.
 * The source URL is fixed in config (ONEDRIVE_URL) so this cannot be used as an open proxy.
 */
export interface Env {
  ONEDRIVE_URL: string;
  ALLOWED_ORIGIN: string; // e.g. https://your-site.pages.dev ("*" allowed for local dev)
}

const MAX_HOPS = 10;

function cors(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGIN === "*" || origin === env.ALLOWED_ORIGIN || /^http:\/\/localhost:\d+$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? (env.ALLOWED_ORIGIN === "*" ? "*" : origin) : env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

async function download(startUrl: string): Promise<Response> {
  const jar = new Map<string, string>();
  let url = startUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; excel-poc-relay)",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (!loc) break;
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  return new Response("Too many redirects or missing Location", { status: 502 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const headers = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers });

    try {
      const upstream = await download(env.ONEDRIVE_URL);
      if (!upstream.ok) return new Response(`Upstream HTTP ${upstream.status}`, { status: 502, headers });
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response("Relay failed to reach OneDrive", { status: 502, headers });
    }
  },
};
