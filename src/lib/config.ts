/**
 * URL the browser fetches the workbook from: the relay Worker in /worker (see README).
 * Direct OneDrive links are blocked by CORS, so they are not used.
 *  - dev:  local `wrangler dev` on :8787
 *  - prod: set NEXT_PUBLIC_EXCEL_URL to the deployed Worker URL (only the URL is baked in, never data)
 */
const DEV_RELAY = "http://localhost:8787";

export const EXCEL_URL =
  process.env.NEXT_PUBLIC_EXCEL_URL ||
  (process.env.NODE_ENV === "development" ? DEV_RELAY : "");

export const FETCH_TIMEOUT_MS = 15_000;
