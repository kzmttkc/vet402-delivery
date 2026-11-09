/**
 * Strip payer EIP-3009 authorization material from EVM purchase / chain-check lines
 * before they are kept as regression fixtures (no v/r/s, no authorization nonce window).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LONG_HEX = /0x[0-9a-fA-F]{64,}/g;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One jsonl purchase or chain-check object: drop authorization and scrub long hex in strings. */
export function redactEvmPurchaseRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const o = structuredClone(raw) as Record<string, unknown>;
  delete o.authorization;
  scrubLongHex(o);
  return o;
}

function scrubLongHex(v: Json): void {
  if (typeof v === "string") {
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] === "string") v[i] = (v[i] as string).replace(LONG_HEX, "[redacted]");
      else scrubLongHex(v[i]);
    }
    return;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const val = (v as Record<string, Json>)[k]!;
      if (typeof val === "string") (v as Record<string, Json>)[k] = val.replace(LONG_HEX, "[redacted]");
      else scrubLongHex(val);
    }
  }
}

export function redactEvmPurchaseJsonl(text: string): string {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.stringify(redactEvmPurchaseRecord(JSON.parse(line) as Record<string, unknown>)))
    .join("\n")
    .concat("\n");
}

/** Regression fixtures must not ship EIP-3009 signature-sized hex in the jsonl copies. */
export function assertNoLongHexInJsonl(dir: string, names: string[]): void {
  for (const name of names) {
    const text = readFileSync(join(dir, name), "utf8");
    const m = text.match(LONG_HEX);
    if (m?.length) throw new Error(`${name}: long hex remains (${m[0].slice(0, 18)}…)`);
  }
}

/** Walk fixture tree under `base` and assert every *.jsonl under results/evm passes. */
export function assertRobinhoodFixtureJsonlClean(base: string): void {
  const evm = join(base, "results", "evm");
  for (const f of readdirSync(evm)) {
    if (!f.endsWith(".jsonl") || !statSync(join(evm, f)).isFile()) continue;
    assertNoLongHexInJsonl(evm, [f]);
  }
}
