/**
 * Vercel Function (Node.js runtime, Web handler): GET /v1/check?url=<seller URL> (rewrite in vercel.json).
 * Free and read-only for the caller: no key, no payment. The answer comes only from the files bundled with
 * the function (vercel.json includeFiles): site/rank.json, data/records/index.json, data/records/notified.json and data/evm/*.json, the
 * same commit as the site. The logic is packages/check/src/http.ts.
 *
 * Each call is also counted in Postgres (src/usage/count.ts: per day, hashed caller, no raw IP). Counting is
 * fail-open: it is waited for at most 150 ms and its errors are ignored, so the answer never depends on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleCheck, type CheckData } from "../packages/check/src/http.js";
import { usageCounter, usageDb, usageKey } from "../src/usage/count.js";

let data: CheckData | null = null;

/** Read once per instance; a failed read is tried again on the next request. */
function load(): CheckData {
  if (!data) {
    const root = process.cwd();
    const json = (...p: string[]) => JSON.parse(readFileSync(join(root, ...p), "utf8")) as unknown;
    data = {
      rank: json("site", "rank.json"),
      recordsIndex: json("data", "records", "index.json"),
      notified: existsSync(join(root, "data", "records", "notified.json")) ? json("data", "records", "notified.json") : null,
      lanes: ["arbitrum", "robinhood"].filter((l) => existsSync(join(root, "data", "evm", `${l}.json`))).map((l) => json("data", "evm", `${l}.json`)),
    };
  }
  return data;
}

const count = usageCounter("check", () => usageDb(), usageKey());

export function GET(request: Request): Promise<Response> {
  return handleCheck(request, load, count);
}

export function HEAD(request: Request): Promise<Response> {
  return handleCheck(request, load, count);
}

export function OPTIONS(request: Request): Promise<Response> {
  return handleCheck(request, load);
}
