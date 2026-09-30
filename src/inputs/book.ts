/**
 * The input book: for each remeasure target whose request needs a look (a placeholder in it, or an earlier paid
 * answer of 400, 404 or 422), what the seller says the endpoint takes, read once from a public catalog or the
 * seller's own document and kept in src/inputs/book.json. scripts/inputs-book.ts writes it (read-only GETs);
 * remeasure reads it (src/inputs/repair.ts). A book older than BOOK_MAX_AGE_DAYS is refused, so a stale spec
 * does not keep being used silently.
 */
import { readFileSync } from "node:fs";
import { normUrl } from "../discovery.js";
import type { EndpointSpec } from "./spec.js";

export interface BookEntry {
  chain: "solana" | "tempo";
  /** Tempo service id; null on Solana. */
  service: string | null;
  /** The target's catalog URL (Target.url). */
  url: string;
  /** Status of the earlier paid answer to this request (the census row or the Tempo ledger), null when not known. */
  lastStatus: number | null;
  /** null when no catalog or seller document describes the endpoint: only placeholders are filled, by name. */
  spec: EndpointSpec | null;
  /** Where vet402 looked, including the places that had nothing. */
  looked: string[];
}

export interface InputBook {
  kind: "vet402-input-book";
  version: 1;
  createdAt: string;
  entries: BookEntry[];
}

export const BOOK_MAX_AGE_DAYS = 14;

export function bookKey(e: { chain: string; service: string | null; url: string }): string {
  return `${e.chain} ${e.service ?? ""} ${normUrl(e.url)}`;
}

export function parseBook(json: unknown, now: Date): InputBook {
  const b = json as InputBook;
  if (!b || b.kind !== "vet402-input-book" || b.version !== 1 || !Array.isArray(b.entries)) throw new Error("not a vet402-input-book v1");
  const at = Date.parse(b.createdAt);
  if (!Number.isFinite(at)) throw new Error("input book: bad createdAt");
  const ageDays = (now.getTime() - at) / 86_400_000;
  if (ageDays > BOOK_MAX_AGE_DAYS) throw new Error(`input book is ${Math.floor(ageDays)} days old (max ${BOOK_MAX_AGE_DAYS}): run scripts/inputs-book.ts again`);
  const seen = new Set<string>();
  for (const e of b.entries) {
    if ((e.chain !== "solana" && e.chain !== "tempo") || typeof e.url !== "string") throw new Error(`input book: bad entry ${JSON.stringify(e).slice(0, 120)}`);
    const k = bookKey(e);
    if (seen.has(k)) throw new Error(`input book: duplicate entry ${k}`);
    seen.add(k);
  }
  return b;
}

export function readBook(path: string, now: Date): InputBook {
  return parseBook(JSON.parse(readFileSync(path, "utf8")), now);
}
