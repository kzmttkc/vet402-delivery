/**
 * Where the check reads from, and the one door every read goes through.
 *
 * Only public, free, unauthenticated GETs: the ranking (rank.json) and the signed records on the public
 * site, and the records index in the public repository (the site does not serve index.json). No key, no
 * wallet, no payment, no write. Each source can be pointed at a local file instead (tests, offline use).
 */
import { readFileSync } from "node:fs";

export const PUBLIC_SITE_URL = "https://kzmttkc.github.io/vet402-delivery";
export const PUBLIC_REPO_URL = "https://github.com/kzmttkc/vet402-delivery";
export const RANK_URL = `${PUBLIC_SITE_URL}/rank.json`;
export const RECORDS_INDEX_URL = "https://raw.githubusercontent.com/kzmttkc/vet402-delivery/main/data/records/index.json";
export const RECORDS_BASE_URL = `${PUBLIC_SITE_URL}/records`;
/** The sellers vet402 has told about their results (an "avoid" verdict needs the seller to be on it). */
export const NOTIFIED_URL = "https://raw.githubusercontent.com/kzmttkc/vet402-delivery/main/data/records/notified.json";
/** Arbitrum and Robinhood Chain purchases (one per payTo), as their pages show them. */
export const LANE_URLS = ["arbitrum", "robinhood"].map((l) => `https://raw.githubusercontent.com/kzmttkc/vet402-delivery/main/data/evm/${l}.json`);

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Sources {
  /** rank.json: https URL or local path. */
  rank: string;
  /** data/records/index.json: https URL or local path. */
  recordsIndex: string;
  /** Folder that holds <id>.json: https URL or local path. */
  recordsBase: string;
  /** data/evm/arbitrum.json and robinhood.json: https URLs or local paths. Empty: none read. */
  lanes: string[];
  /** data/records/notified.json: https URL or local path. Empty: no seller counts as told (no "avoid"). */
  notified: string;
}

/** The public sources, unless VET402_CHECK_RANK, VET402_CHECK_RECORDS_INDEX or VET402_CHECK_RECORDS_BASE name others. */
export function defaultSources(env: NodeJS.ProcessEnv = process.env): Sources {
  return {
    rank: env.VET402_CHECK_RANK || RANK_URL,
    recordsIndex: env.VET402_CHECK_RECORDS_INDEX || RECORDS_INDEX_URL,
    recordsBase: env.VET402_CHECK_RECORDS_BASE || RECORDS_BASE_URL,
    notified: env.VET402_CHECK_NOTIFIED !== undefined ? env.VET402_CHECK_NOTIFIED.trim() : NOTIFIED_URL,
    lanes: env.VET402_CHECK_LANES !== undefined ? env.VET402_CHECK_LANES.split(",").map((x) => x.trim()).filter(Boolean) : LANE_URLS,
  };
}

export const RECORD_ID = /^obs_\d{4}-\d{2}-\d{2}_\d{6}$/;

export const MAX_BYTES = { rank: 32_000_000, recordsIndex: 8_000_000, record: 1_000_000, lane: 8_000_000 } as const;

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i;

/** Read one source as text: https (or loopback http) with a timeout and a size cap, or a local file. */
export async function readText(src: string, maxBytes: number, f: Fetch = fetch): Promise<string> {
  if (/^https:\/\//i.test(src) || LOOPBACK.test(src)) {
    const res = await f(src, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${src} answered HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error(`${src}: ${text.length} bytes, more than the ${maxBytes} this check reads`);
    return text;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) throw new Error(`${src}: only https URLs or local files are read`);
  const text = readFileSync(src, "utf8");
  if (text.length > maxBytes) throw new Error(`${src}: ${text.length} bytes, more than the ${maxBytes} this check reads`);
  return text;
}

export function joinSource(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}`;
}

export interface PublicDataOptions {
  sources?: Partial<Sources>;
  fetch?: Fetch;
  /** How long rank.json and the records index are kept in memory. Default 10 minutes. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * The public data, read once and kept for `ttlMs`, so a hook that sees many 402s does not download
 * rank.json for each of them.
 */
export class PublicData {
  readonly sources: Sources;
  private readonly f: Fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(opts: PublicDataOptions = {}) {
    this.sources = { ...defaultSources(), ...opts.sources };
    this.f = opts.fetch ?? fetch;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  rank(): Promise<unknown> {
    return this.cached("rank", async () => JSON.parse(await readText(this.sources.rank, MAX_BYTES.rank, this.f)) as unknown);
  }

  recordsIndex(): Promise<unknown> {
    return this.cached("recordsIndex", async () => JSON.parse(await readText(this.sources.recordsIndex, MAX_BYTES.recordsIndex, this.f)) as unknown);
  }

  /** The Arbitrum and Robinhood Chain files. One that cannot be read is left out (the rest still answers). */
  lanes(): Promise<unknown[]> {
    return this.cached("lanes", async () => {
      const got = await Promise.all(
        this.sources.lanes.map((src) =>
          readText(src, MAX_BYTES.lane, this.f)
            .then((t) => JSON.parse(t) as unknown)
            .catch(() => null),
        ),
      );
      return got.filter((x) => x !== null);
    });
  }

  /** notified.json, or null when there is none or it cannot be read (then no seller counts as told). */
  notified(): Promise<unknown> {
    return this.cached("notified", async () => {
      if (!this.sources.notified) return null;
      return readText(this.sources.notified, MAX_BYTES.lane, this.f)
        .then((t) => JSON.parse(t) as unknown)
        .catch(() => null);
    });
  }

  /** Where the record with this id is read from. */
  recordLocation(id: string): string {
    if (!RECORD_ID.test(id)) throw new Error(`${id}: not a record id (obs_YYYY-MM-DD_NNNNNN)`);
    return joinSource(this.sources.recordsBase, `${id}.json`);
  }

  /** One published record by id, parsed, kept in memory like rank.json (a published record does not change). */
  recordJson(id: string): Promise<unknown> {
    return this.cached(`record:${id}`, async () => JSON.parse((await this.recordText(id)).text) as unknown);
  }

  /** The record's bytes as published: a record id, an https URL, or a local file. */
  recordText(ref: string): Promise<{ location: string; text: string }> {
    const location = RECORD_ID.test(ref) ? this.recordLocation(ref) : ref;
    return readText(location, MAX_BYTES.record, this.f).then((text) => ({ location, text }));
  }
}
