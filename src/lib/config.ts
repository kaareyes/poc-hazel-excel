/**
 * OneDrive "Anyone with the link" URL. `?download=1` asks OneDrive to redirect to the
 * raw file instead of the Excel viewer. Override with NEXT_PUBLIC_EXCEL_URL.
 * See README: this URL is NOT expected to pass browser CORS checks.
 */
export const EXCEL_URL =
  process.env.NEXT_PUBLIC_EXCEL_URL ||
  "https://1drv.ms/x/c/a4d9313be8d6b81a/IQDiwWxFT9eWRLKZAllU9cm-AXKorc9P20HWcL8Pq3SnfGg?download=1";

export const FETCH_TIMEOUT_MS = 15_000;
