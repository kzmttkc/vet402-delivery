/**
 * Keeta seller catalog fetch (redirect manual, no cross-host redirects).
 */
import type { KeetaCatalog } from "./challenge.js";

export async function fetchCatalog(url: string, fetchImpl: typeof fetch): Promise<KeetaCatalog> {
  const r = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  if (r.status >= 300 && r.status < 400) {
    throw new Error(`catalog ${url} redirect ${r.status}`);
  }
  if (!r.ok) throw new Error(`catalog ${url} returned ${r.status}`);
  let host: string;
  try {
    host = new URL(r.url).host;
  } catch {
    throw new Error(`catalog response url is not parseable`);
  }
  const sellerHost = new URL(url).host;
  if (host !== sellerHost) {
    throw new Error(`catalog fetch followed or redirected to host ${host}, expected ${sellerHost}`);
  }
  const body = (await r.json()) as KeetaCatalog & { body?: KeetaCatalog };
  return (body.body as KeetaCatalog) ?? body;
}