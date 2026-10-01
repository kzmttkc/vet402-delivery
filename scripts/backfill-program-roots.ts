/**
 * Name the observation-roots program's day account in data/records/index.json (days[].programRoot) for
 * days whose root was posted before anchor-receipts --post-root --send recorded it. Reads the chain only:
 * signs nothing, sends nothing, reads no key.
 *
 *   npx tsx scripts/backfill-program-roots.ts            # read and compare, write nothing
 *   npx tsx scripts/backfill-program-roots.ts --write    # ... and write the index when every day agrees
 *   npx tsx scripts/backfill-program-roots.ts --check    # also read again every programRoot the index already
 *                                                        # names; writes nothing, exit 1 on any difference
 *   [--records <dir>] (default data/records)  [--day YYYY-MM-DD] (only that day)
 *
 * For each anchored day of the index that has no programRoot yet, the day's account must be the
 * program's and hold exactly the index line's root, count (inRoot), sequence range and observer, and
 * one successful transaction paid by the pinned posting key must have created it in the slot the
 * account names (src/receipt/roots-index.ts, dayRootOnChain). Any difference stops the run and nothing
 * is written. A day with no account yet is reported and left as it is.
 *
 * RPC: VET402_ROOTS_RPC, else SOLANA_RPC_URL, else mainnet. The cluster must be mainnet (genesis hash),
 * since the index names mainnet only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRpc, type Rpc } from "../src/chain.js";
import { loadPublishedRecords, type DayEntry, type RecordIndex } from "../src/receipt/publish.js";
import { dayRootOnChain, type ProgramRootEntry } from "../src/receipt/roots-index.js";
import { MAINNET_GENESIS, ROOTS_DEPLOYMENTS_BY_GENESIS } from "../src/receipt/roots-program.js";

/** The index line with its programRoot placed after the memo anchor (the order publish-records writes). */
export function withProgramRoot(d: DayEntry, programRoot: ProgramRootEntry): DayEntry {
  const { tempoAnchor, programRoot: _old, ...rest } = d;
  return { ...rest, programRoot, ...(tempoAnchor ? { tempoAnchor } : {}) };
}

export interface BackfillResult {
  index: RecordIndex;
  filled: { day: string; entry: ProgramRootEntry }[];
  notPosted: string[];
  /** Days whose programRoot was already in the index and was read again (check: true). */
  checked: string[];
}

const sameEntry = (a: ProgramRootEntry, b: ProgramRootEntry) => a.network === b.network && a.program === b.program && a.account === b.account && a.tx === b.tx && a.slot === b.slot;

/** Check every open day against the chain. Throws on the first difference; returns the new index otherwise. */
export async function backfillProgramRoots(rpc: Rpc, index: RecordIndex, opts: { day?: string; check?: boolean; log?: (l: string) => void } = {}): Promise<BackfillResult> {
  const genesis = (await rpc("getGenesisHash", [])) as string;
  if (genesis !== MAINNET_GENESIS) throw new Error(`the RPC is not Solana mainnet (genesis ${genesis}); the index names mainnet only`);
  const dep = ROOTS_DEPLOYMENTS_BY_GENESIS[MAINNET_GENESIS]!;
  const filled: BackfillResult["filled"] = [];
  const notPosted: string[] = [];
  const checked: string[] = [];
  const days: DayEntry[] = [];
  for (const d of index.days) {
    if (d.programRoot && opts.check && (!opts.day || d.day === opts.day)) {
      // Read again: the account must still hold the index line's values and name the same transaction and slot.
      const want = { day: d.day, root: d.root as `0x${string}`, count: d.inRoot, seqStart: d.sequenceRange[0], seqEnd: d.sequenceRange[1], observer: d.observerAddress as `0x${string}` };
      const now = await dayRootOnChain(rpc, { program: dep.program, poster: dep.poster }, want);
      if (!sameEntry(now, d.programRoot)) throw new Error(`${d.day}: the index names ${JSON.stringify(d.programRoot)}, the chain ${JSON.stringify(now)}`);
      opts.log?.(`${d.day}: programRoot in the index agrees with the chain (${now.account}, ${now.tx}, slot ${now.slot})`);
      checked.push(d.day);
    }
    if (d.programRoot || (opts.day && d.day !== opts.day) || d.anchor.status !== "anchored") {
      days.push(d);
      continue;
    }
    const want = { day: d.day, root: d.root as `0x${string}`, count: d.inRoot, seqStart: d.sequenceRange[0], seqEnd: d.sequenceRange[1], observer: d.observerAddress as `0x${string}` };
    let entry: ProgramRootEntry;
    try {
      entry = await dayRootOnChain(rpc, { program: dep.program, poster: dep.poster }, want);
    } catch (e) {
      if (/no account at/.test(String(e))) {
        notPosted.push(d.day);
        opts.log?.(`${d.day}: not in the program yet; left as it is`);
        days.push(d);
        continue;
      }
      throw e;
    }
    opts.log?.(`${d.day}: ${entry.account} holds root ${d.root}, count ${d.inRoot}, sequence ${d.sequenceRange[0]}-${d.sequenceRange[1]}, observer ${d.observerAddress}; posted in ${entry.tx} (slot ${entry.slot})`);
    filled.push({ day: d.day, entry });
    days.push(withProgramRoot(d, entry));
  }
  return { index: { ...index, days }, filled, notPosted, checked };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const argValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const dir = resolve(argValue("--records") ?? join(ROOT, "data", "records"));
  const day = argValue("--day");
  if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day needs YYYY-MM-DD");
  const check = args.includes("--check");
  if (check && args.includes("--write")) throw new Error("--check only reads; run --write separately");
  const index = (await loadPublishedRecords(dir)).index; // the index as the site build accepts it
  const rpc = jsonRpc(process.env.VET402_ROOTS_RPC ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
  let r: BackfillResult;
  try {
    r = await backfillProgramRoots(rpc, index, { day, check, log: (l) => console.log(l) });
  } catch (e) {
    console.error(`refused, nothing written: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (check) console.log(`checked ${r.checked.length} programRoot entr${r.checked.length === 1 ? "y" : "ies"} against the chain; nothing written`);
  if (r.filled.length === 0) {
    console.log("nothing to fill");
  } else if (!args.includes("--write") || check) {
    console.log(`read only: ${r.filled.length} day(s) agree with the chain (pass --write to put them in ${join(dir, "index.json")})`);
  } else {
    const path = join(dir, "index.json");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, `${JSON.stringify(r.index, null, 2)}\n`);
    try {
      await loadPublishedRecords(dir);
    } catch (e) {
      writeFileSync(path, before);
      console.error(`the new index does not pass the site build's check; put back as it was:\n${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    console.log(`wrote ${r.filled.map((f) => f.day).join(", ")} into ${path}`);
  }
}
