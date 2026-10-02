/**
 * The observation-roots day account in the records index (days[].programRoot) and on the record pages:
 *  - the backfill reads the chain only, and refuses any account or transaction that differs from the index
 *  - the published index's programRoot entries are what the backfill makes from the chain state
 *  - a record page names the program account and the Tempo memo only when the index names them
 *  - the site build's check refuses a malformed programRoot
 *  - post_root is not signed when the posting key cannot pay one more day
 *  - verify-receipt's program check passes only on the program's answer for this very record (the program
 *    itself, with tampered records, runs in solana-program/tests on a local validator)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddressEncoder, address } from "@solana/kit";
import { hexToBytes, type Hex } from "viem";
import type { Rpc } from "../src/chain.js";
import { renderObservationPage } from "../src/receipt/html.js";
import { loadPublishedRecords, type RecordIndex } from "../src/receipt/publish.js";
import { observationDigest } from "../src/receipt/eip712.js";
import { carryProgramRoot, programRootFromIndex, programRootOfDay, programRootShape, programVerify, ROOTS_INDEX_NETWORK, type ProgramRootEntry } from "../src/receipt/roots-index.js";
import { planPostRoot, PosterBalanceTooLow } from "../src/receipt/roots-post.js";
import { accountDiscriminator, configPda, dayRootPda, MAINNET_GENESIS, ROOTS_DEPLOYMENTS_BY_GENESIS, ROOTS_PROGRAM } from "../src/receipt/roots-program.js";
import { backfillProgramRoots } from "../scripts/backfill-program-roots.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDS = join(ROOT, "data", "records");
const POSTER = ROOTS_DEPLOYMENTS_BY_GENESIS[MAINNET_GENESIS]!.poster;

function le(n: bigint, bytes: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** A DayRoot account's bytes, as the program writes them. */
function dayRootBytes(a: { day: string; root: string; count: number; seqStart: number; seqEnd: number; observer: string; slot: number }): string {
  const b = [
    ...accountDiscriminator("DayRoot"),
    ...le(BigInt(a.day.replaceAll("-", "")), 4),
    ...hexToBytes(a.root as Hex),
    ...le(BigInt(a.count), 4),
    ...le(BigInt(a.seqStart), 8),
    ...le(BigInt(a.seqEnd), 8),
    ...hexToBytes(a.observer.toLowerCase() as Hex),
    ...le(BigInt(a.slot), 8),
    ...le(1790821282n, 8),
    255,
  ];
  return Buffer.from(Uint8Array.from(b)).toString("base64");
}

interface ChainDay {
  day: string;
  root: string;
  count: number;
  seqStart: number;
  seqEnd: number;
  observer: string;
  slot: number;
  account: string;
  tx: string;
  owner?: string;
  payer?: string;
  extraSigsAtSlot?: number;
}

/** A read-only mainnet stand-in: the day accounts, their signatures and transactions. Fails on any write. */
function fakeChain(days: ChainDay[], genesis = MAINNET_GENESIS): { rpc: Rpc; calls: string[] } {
  const calls: string[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    const p = params as [string, ...unknown[]];
    const d = days.find((x) => x.account === p[0] || x.tx === p[0]);
    switch (method) {
      case "getGenesisHash":
        return genesis;
      case "getAccountInfo":
        return { value: d ? { data: [dayRootBytes(d), "base64"], owner: d.owner ?? ROOTS_PROGRAM, lamports: 1244600 } : null };
      case "getSignaturesForAddress":
        if (!d) return [];
        return [
          { signature: d.tx, slot: d.slot, err: null },
          ...Array.from({ length: d.extraSigsAtSlot ?? 0 }, (_, i) => ({ signature: `${d.tx.slice(0, -1)}${i}`, slot: d.slot, err: null })),
          { signature: "5".repeat(88), slot: d.slot + 10, err: { InstructionError: [0, "Custom"] } },
        ];
      case "getTransaction":
        if (!d) return null;
        return { slot: d.slot, meta: { err: null }, transaction: { message: { accountKeys: [d.payer ?? POSTER, d.account, "4VBEbnK1JRPgwLX9xcbvyc4CTtqJUiQZnHx6nUWJKyU9", "11111111111111111111111111111111", ROOTS_PROGRAM] } } };
      default:
        throw new Error(`the backfill must only read; it called ${method}`);
    }
  };
  return { rpc, calls };
}

/** The chain state the published index names, read back from data/records/index.json. */
function chainOfIndex(index: RecordIndex): ChainDay[] {
  return index.days
    .filter((d) => d.programRoot)
    .map((d) => ({
      day: d.day,
      root: d.root,
      count: d.inRoot,
      seqStart: d.sequenceRange[0],
      seqEnd: d.sequenceRange[1],
      observer: d.observerAddress,
      slot: d.programRoot!.slot,
      account: d.programRoot!.account,
      tx: d.programRoot!.tx,
    }));
}

function withoutProgramRoots(index: RecordIndex): RecordIndex {
  return { ...index, days: index.days.map(({ programRoot: _p, ...d }) => d) };
}

test("index: 2026-09-28 to 2026-09-30 name their observation-roots account, and each is the day's PDA of the program", async () => {
  const { index } = await loadPublishedRecords(RECORDS);
  const named = index.days.filter((d) => d.programRoot).map((d) => d.day);
  // The three backfilled days, then every day the daily records run posts (2026-10-01 on): no day from 2026-09-28 is skipped.
  assert.deepEqual(named.slice(0, 3), ["2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.deepEqual(named, index.days.map((d) => d.day).filter((d) => d >= "2026-09-28" && d <= named[named.length - 1]));
  for (const d of index.days.filter((x) => x.programRoot)) {
    assert.equal(d.programRoot!.account, await dayRootPda(ROOTS_PROGRAM, d.day), d.day);
    assert.equal(d.programRoot!.network, ROOTS_INDEX_NETWORK);
    assert.deepEqual(await programRootShape(d.programRoot, d.day), []);
  }
});

test("backfill: from the chain state, the index comes out byte for byte as published, reading only", async () => {
  const text = readFileSync(join(RECORDS, "index.json"), "utf8");
  const index = JSON.parse(text) as RecordIndex;
  const { rpc, calls } = fakeChain(chainOfIndex(index));
  const r = await backfillProgramRoots(rpc, withoutProgramRoots(index));
  assert.deepEqual(r.filled.map((f) => f.day), chainOfIndex(index).map((d) => d.day));
  assert.deepEqual(r.filled.map((f) => f.day).slice(0, 3), ["2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.equal(`${JSON.stringify(r.index, null, 2)}\n`, text);
  assert.ok(calls.every((c) => ["getGenesisHash", "getAccountInfo", "getSignaturesForAddress", "getTransaction"].includes(c)), calls.join(","));
  // A day already named is not read again.
  const again = await backfillProgramRoots(fakeChain([]).rpc, index);
  assert.equal(again.filled.length, 0);
});

test("backfill: an account or transaction that differs from the index is refused, and nothing is filled", async () => {
  const index = JSON.parse(readFileSync(join(RECORDS, "index.json"), "utf8")) as RecordIndex;
  const bare = withoutProgramRoots(index);
  const good = chainOfIndex(index);
  const cases: [string, (d: ChainDay) => ChainDay, RegExp][] = [
    ["root", (d) => ({ ...d, root: `0x${"11".repeat(32)}` }), /differs from the day's root: root/],
    ["count", (d) => ({ ...d, count: d.count + 1 }), /differs from the day's root: count/],
    ["sequence end", (d) => ({ ...d, seqEnd: d.seqEnd - 1 }), /differs from the day's root: sequence/],
    ["sequence start", (d) => ({ ...d, seqStart: d.seqStart + 1 }), /differs from the day's root: sequence/],
    ["observer", (d) => ({ ...d, observer: "0x0000000000000000000000000000000000000001" }), /differs from the day's root: observer/],
    ["owner", (d) => ({ ...d, owner: "11111111111111111111111111111111" }), /is owned by/],
    ["payer", (d) => ({ ...d, payer: "DNkH3i35X29YjALuK7ay2qB95fmduHxfQJkCKqA6Jakh" }), /not the posting key/],
    ["two transactions in the slot", (d) => ({ ...d, extraSigsAtSlot: 1 }), /2 successful transactions/],
  ];
  for (const [what, change, re] of cases) {
    const chain = good.map((d) => (d.day === "2026-09-29" ? change(d) : d));
    await assert.rejects(backfillProgramRoots(fakeChain(chain).rpc, bare), re, what);
  }
  await assert.rejects(backfillProgramRoots(fakeChain(good, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG").rpc, bare), /not Solana mainnet/);
  // A day not posted yet is left as it is, not refused.
  const r = await backfillProgramRoots(fakeChain(good.filter((d) => d.day !== "2026-09-30")).rpc, bare);
  assert.deepEqual(r.notPosted, ["2026-09-30"]);
  assert.equal(r.index.days.find((d) => d.day === "2026-09-30")!.programRoot, undefined);
});

test("record page: the Record row names the program account and the Tempo memo only when the index names them", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  const rec = loaded.records.find((r) => r.entry.id === "obs_2026-09-30_000599")!;
  const day = loaded.index.days.find((d) => d.day === "2026-09-30")!;
  const opts = { jsonHref: "a.json", verifyCommand: "x", site: { nav: "", keyHref: "k" } };
  const program = 'also in the observation_roots program on Solana · <a href="https://solscan.io/account/3yLyvjZNMyrzpCu6MQn8BYnW3Sh4PtweiMLtkfQ7wAfA" rel="noopener noreferrer">3yLyvj…wAfA ↗</a>';
  const tempo = 'and on Tempo · <a href="https://explore.tempo.xyz/tx/0x0729ad5ada8aef918cc395cf847d591c7ca69e2afb7dea93d7214707f5185c36" rel="noopener noreferrer">0x0729…5c36 ↗</a>';

  const both = renderObservationPage(rec.obs, { ...opts, dayRoot: { day: day.day, programRoot: day.programRoot, tempoAnchor: day.tempoAnchor } });
  assert.ok(both.includes(program) && both.includes(tempo));
  assert.ok(both.indexOf(program) < both.indexOf(tempo), "program first, then Tempo");

  const programOnly = renderObservationPage(rec.obs, { ...opts, dayRoot: { day: day.day, programRoot: day.programRoot } });
  assert.ok(programOnly.includes(program) && !programOnly.includes("and on Tempo"));
  const tempoOnly = renderObservationPage(rec.obs, { ...opts, dayRoot: { day: day.day, tempoAnchor: day.tempoAnchor } });
  assert.ok(!tempoOnly.includes("observation_roots") && tempoOnly.includes(tempo));

  for (const html of [
    renderObservationPage(rec.obs, opts),
    renderObservationPage(rec.obs, { ...opts, dayRoot: { day: "2026-09-29", programRoot: day.programRoot, tempoAnchor: day.tempoAnchor } }),
    renderObservationPage({ ...rec.obs, anchor: { ...rec.obs.anchor!, status: "pending", tx: null } }, { ...opts, dayRoot: { day: day.day, programRoot: day.programRoot, tempoAnchor: day.tempoAnchor } }),
  ])
    assert.ok(!html.includes("observation_roots") && !html.includes("and on Tempo"));

  // The published pages: 2026-09-30 has all three places, 2026-09-28 the memo and the program.
  const p30 = readFileSync(join(ROOT, "site", "records", "obs_2026-09-30_000599.html"), "utf8");
  assert.ok(p30.includes(program) && p30.includes(tempo) && p30.includes("https://solscan.io/tx/39kjZkahMrBuEV7nYAVwAEZbSVnbHD7xb6Pb3Ciw5qTPRKLSQB5PebArxwJZpmF8KnyCRE7sC1amBiPBAheZ1Sbn"));
  const p28 = readFileSync(join(ROOT, "site", "records", "obs_2026-09-28_000001.html"), "utf8");
  assert.ok(p28.includes("https://solscan.io/account/ansdE2XrSgMMo3Mb5wwDF2r7xowUU3qTHcv3PShHHfS") && !p28.includes("and on Tempo"));
});

test("site build check: a programRoot that names another day's account, another program or an extra field is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-progroot-"));
  try {
    cpSync(RECORDS, dir, { recursive: true });
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as RecordIndex;
    const other = index.days.find((d) => d.day === "2026-09-28")!.programRoot!;
    const bad: [string, (p: ProgramRootEntry) => unknown][] = [
      ["another day's account", (p) => ({ ...p, account: other.account })],
      ["another program", (p) => ({ ...p, program: "BTVeASLyz5HvRz1eKChUgBj6hFbn89orEyGuTUW2yrUH" })],
      ["devnet", (p) => ({ ...p, network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" })],
      ["extra field", (p) => ({ ...p, root: "0x00" })],
      ["slot", (p) => ({ ...p, slot: "452151199" })],
    ];
    for (const [what, change] of bad) {
      const t = { ...index, days: index.days.map((d) => (d.day === "2026-09-30" ? { ...d, programRoot: change(d.programRoot!) } : d)) };
      writeFileSync(join(dir, "index.json"), `${JSON.stringify(t, null, 2)}\n`);
      await assert.rejects(loadPublishedRecords(dir), /day 2026-09-30: programRoot/, what);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anchor-program-sent.json: read once posted, ignored otherwise, refused when it names another root or another account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-progsent-"));
  try {
    const day = join(dir, "2026-09-30");
    mkdirSync(day);
    const ROOT30 = "0x605514a380fd74ca49b4ad9ea2922df0ec17edb220badcfd2d24c8bda60799c5";
    assert.equal(await programRootOfDay(day, "2026-09-30", ROOT30), null);
    const e = { network: ROOTS_INDEX_NETWORK, program: ROOTS_PROGRAM, account: await dayRootPda(ROOTS_PROGRAM, "2026-09-30"), tx: "3vG7SaQJK8aazchuWshKZdXZM5sJaQAAPBTEV41t6ovCZnuXk99XcBcrnZaUQ3sSQLnR8bZZrv591REUgtSYAN9D", slot: 452151199 };
    const write = (f: object) => writeFileSync(join(day, "anchor-program-sent.json"), JSON.stringify(f));
    write({ status: "posted", day: "2026-09-30", root: ROOT30, ...e });
    assert.deepEqual(await programRootOfDay(day, "2026-09-30", ROOT30), e);
    assert.deepEqual(await programRootOfDay(day, "2026-09-30", ROOT30.toUpperCase().replace("0X", "0x")), e, "the root compares without case");
    write({ status: "sending", day: "2026-09-30", root: ROOT30, ...e });
    assert.equal(await programRootOfDay(day, "2026-09-30", ROOT30), null);
    write({ status: "posted", day: "2026-09-30", root: ROOT30, ...e, account: await dayRootPda(ROOTS_PROGRAM, "2026-09-29") });
    await assert.rejects(programRootOfDay(day, "2026-09-30", ROOT30), /programRoot\.account/);
    write({ status: "posted", day: "2026-09-30", root: `0x${"11".repeat(32)}`, ...e });
    await assert.rejects(programRootOfDay(day, "2026-09-30", ROOT30), /is not the day's root/);
    write({ status: "posted", day: "2026-09-30", ...e });
    await assert.rejects(programRootOfDay(day, "2026-09-30", ROOT30), /is not the day's root/, "a file without its root is refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("carryProgramRoot (publish-records): a) same day and root, no file: kept b) another root: dropped c) another day's account: dropped d) a posted file wins e) memo pending: none", async () => {
  const { index } = await loadPublishedRecords(RECORDS);
  const d30 = index.days.find((d) => d.day === "2026-09-30")!;
  const d28 = index.days.find((d) => d.day === "2026-09-28")!;
  const line = { day: d30.day, root: d30.root, anchor: { status: "anchored" } };
  // a) same day, same root, no anchor-program-sent.json: the index's entry is kept
  assert.deepEqual(await carryProgramRoot(d30, line, null), d30.programRoot);
  // b) the day was rebuilt with another root: the old entry is dropped
  assert.equal(await carryProgramRoot(d30, { ...line, root: `0x${"11".repeat(32)}` }, null), undefined);
  // c) the previous entry names another day's account: dropped
  assert.equal(await carryProgramRoot({ ...d30, programRoot: d28.programRoot }, line, null), undefined);
  // d) anchor-program-sent.json is posted: the file wins over the index
  const fromFile = { ...d30.programRoot!, tx: "5".repeat(88), slot: 452151300 };
  assert.deepEqual(await carryProgramRoot(d30, line, fromFile), fromFile);
  // e) the memo anchor is still pending: no programRoot at all, from the file or the index
  assert.equal(await carryProgramRoot(d30, { ...line, anchor: { status: "pending" } }, fromFile), undefined);
  assert.equal(await carryProgramRoot(d30, { ...line, anchor: { status: "pending" } }, null), undefined);
  // and no previous line at all: nothing
  assert.equal(await carryProgramRoot(undefined, line, null), undefined);
});

test("backfill --check: the entries already in the index are read again; one that names another tx or slot than the chain is refused", async () => {
  const index = JSON.parse(readFileSync(join(RECORDS, "index.json"), "utf8")) as RecordIndex;
  const chain = chainOfIndex(index);
  const ok = await backfillProgramRoots(fakeChain(chain).rpc, index, { check: true });
  assert.deepEqual(ok.checked, chain.map((d) => d.day));
  assert.deepEqual(ok.checked.slice(0, 3), ["2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.equal(ok.filled.length, 0);
  assert.equal(`${JSON.stringify(ok.index, null, 2)}\n`, readFileSync(join(RECORDS, "index.json"), "utf8"), "nothing changes");
  // Without --check the named days are not read at all.
  assert.deepEqual((await backfillProgramRoots(fakeChain([]).rpc, index)).checked, []);
  const wrong = (f: (p: ProgramRootEntry) => ProgramRootEntry): RecordIndex => ({ ...index, days: index.days.map((d) => (d.day === "2026-09-29" ? { ...d, programRoot: f(d.programRoot!) } : d)) });
  await assert.rejects(backfillProgramRoots(fakeChain(chain).rpc, wrong((p) => ({ ...p, tx: "5".repeat(88) })), { check: true }), /2026-09-29: the index names/);
  await assert.rejects(backfillProgramRoots(fakeChain(chain).rpc, wrong((p) => ({ ...p, slot: p.slot + 1 })), { check: true }), /2026-09-29: the index names/);
  // The account on chain no longer holds the index's values: refused as well.
  await assert.rejects(backfillProgramRoots(fakeChain(chain.map((c) => (c.day === "2026-09-30" ? { ...c, count: c.count - 1 } : c))).rpc, index, { check: true }), /differs from the day's root: count/);
});

test("post_root: a posting key that cannot pay one more day and keep the empty account's minimum is not used (nothing simulated or signed)", async () => {
  const program = ROOTS_PROGRAM;
  const cfgAddr = await configPda(program);
  const cfg = Buffer.from(Uint8Array.from([...accountDiscriminator("Config"), ...getAddressEncoder().encode(address(POSTER)), 0, 254, ...new Array(32).fill(0)])).toString("base64"); // None, bump, then the space a Some would take
  const RENT = 1_244_600;
  const KEEP = 650_240;
  const FEE = 5_000;
  const run = async (balance: number) => {
    const calls: string[] = [];
    const rpc: Rpc = async (method, params) => {
      calls.push(method);
      const p = params as unknown[];
      switch (method) {
        case "getAccountInfo":
          return { value: p[0] === cfgAddr ? { data: [cfg, "base64"], owner: program, lamports: 1 } : null };
        case "getLatestBlockhash":
          return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
        case "getMinimumBalanceForRentExemption":
          return p[0] === 0 ? KEEP : RENT;
        case "getFeeForMessage":
          return { value: FEE };
        case "getBalance":
          return { value: balance };
        case "simulateTransaction":
          return { value: { err: null, logs: [], unitsConsumed: 1, accounts: [{ lamports: balance - RENT - FEE }] } };
        default:
          throw new Error(method);
      }
    };
    const args = { day: "2026-10-01", root: `0x${"22".repeat(32)}` as Hex, count: 10, seqStart: 600, seqEnd: 609, observer: "0x6232335B5264f7aa62a51f8ACc4676D22511Ff3C" as Hex };
    const deps = { rpc, program, feePayer: POSTER, loadSigner: async () => { throw new Error("must not load the key"); } };
    return { calls, plan: planPostRoot(deps, args) };
  };
  const low = await run(RENT + FEE + KEEP - 1);
  await assert.rejects(low.plan, (e: unknown) => e instanceof PosterBalanceTooLow && e.needLamports === RENT + FEE + KEEP);
  assert.ok(!low.calls.includes("simulateTransaction"));
  const enough = await run(RENT + FEE + KEEP);
  assert.equal((await enough.plan).state, "ready");
});

test("program check: passes only when the program's answer is this record's day, verdict, sequence and digest", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  const rec = loaded.records.find((r) => r.entry.id === "obs_2026-09-30_000599")!.obs;
  const { entry } = await programRootFromIndex(loaded.index, rec);
  assert.ok(entry);
  const rpc: Rpc = async (m) => {
    if (m === "getGenesisHash") return MAINNET_GENESIS;
    throw new Error(`only the genesis is read here, not ${m}`);
  };
  const answer = (o: { day?: number; verdict?: number; seq?: bigint; digest?: string }) =>
    Uint8Array.from([...le(BigInt(o.day ?? 20260930), 4), o.verdict ?? 0, ...le(o.seq ?? 599n, 8), ...hexToBytes((o.digest ?? observationDigest(rec)) as Hex)]);
  const sim = (r: { err?: unknown; data?: Uint8Array | null; program?: string; logs?: string[] }) => async () => ({ err: r.err ?? null, logs: r.logs ?? [], returnData: r.data === undefined ? answer({}) : r.data, returnProgram: r.program ?? ROOTS_PROGRAM });
  const ok = await programVerify(rpc, entry!, rec, POSTER, { simulate: sim({}) });
  assert.deepEqual(ok.ok, true, ok.detail);
  assert.match(ok.detail, /^verify: DELIVERED \(2026-09-30, sequence 599\); digest 0x[0-9a-f]{64} is the record's/);
  const refused: [string, ReturnType<typeof sim>, RegExp][] = [
    ["program error", sim({ err: { InstructionError: [0, { Custom: 6009 }] }, logs: ["Program EvDMa6KWbFGT48L9oce8U9SwxCWaAKR2aZEJNX8JeZC3 failed: custom program error: 0x1779"] }), /verify refused the record.*0x1779/],
    ["no return data", sim({ data: null }), /returned no data/],
    ["return data from another program", sim({ program: "BTVeASLyz5HvRz1eKChUgBj6hFbn89orEyGuTUW2yrUH" }), /returned no data/],
    ["another verdict", sim({ data: answer({ verdict: 2 }) }), /another record \(verdict NOT_DELIVERED\)/],
    ["another sequence", sim({ data: answer({ seq: 598n }) }), /another record \(sequence 598\)/],
    ["another day", sim({ data: answer({ day: 20260929 }) }), /another record \(day 20260929\)/],
    ["another digest", sim({ data: answer({ digest: `0x${"ab".repeat(32)}` }) }), /another record \(digest 0xabab/],
  ];
  for (const [what, simulate, re] of refused) {
    const r = await programVerify(rpc, entry!, rec, POSTER, { simulate });
    assert.equal(r.ok, false, what);
    assert.match(r.detail, re, what);
  }
  // Not mainnet, or an account of another day: refused before anything is simulated.
  const never = async () => {
    throw new Error("must not simulate");
  };
  assert.equal((await programVerify(async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", entry!, rec, POSTER, { simulate: never })).ok, false);
  const other = loaded.index.days.find((d) => d.day === "2026-09-29")!.programRoot!;
  assert.equal((await programVerify(rpc, { ...entry!, account: other.account }, rec, POSTER, { simulate: never })).ok, false);
  // The index must name the record's own root for the day.
  assert.match((await programRootFromIndex(loaded.index, { anchor: { day: "2026-09-30", root: `0x${"00".repeat(32)}` } })).problem ?? "", /names root/);
  assert.deepEqual(await programRootFromIndex(loaded.index, { anchor: { day: "2026-10-30", root: rec.anchor!.root } }), { entry: null, problem: null });
});
