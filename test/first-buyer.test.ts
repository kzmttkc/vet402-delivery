import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { PAYER_ADDRESS, SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";
import type { PayDeps } from "../src/pay.js";
import type { HostPlan, CensusCandidate } from "../src/census.js";
import type { Rpc } from "../src/chain.js";
import { usdcAta } from "../src/txcheck.js";
import {
  FB_MAX_PER_MONTH_ATOMIC,
  FB_MAX_PER_PURCHASE_ATOMIC,
  FB_MAX_PER_RUN_ATOMIC,
  FB_NOTE,
} from "../src/first-buyer/constants.js";
import { FirstBuyerBudget } from "../src/first-buyer/budget.js";
import { FirstBuyerLedger, eligibility, type SellerEntry } from "../src/first-buyer/ledger.js";
import { checkOutsideReceipts, receiptOf, type ReceiptCheck } from "../src/first-buyer/receipts.js";
import { choosePerPayTo, isTempHost, ownPayTosFromListings, parseOptOut, preselectHosts, recordSeen, emptySeen } from "../src/first-buyer/select.js";
import { buyAll, type BuyDeps, type FirstBuyerTarget } from "../src/first-buyer/run.js";
import { publicRows, walletsJson } from "../src/first-buyer/publish.js";

const S1 = (await generateKeyPairSigner()).address;
const S2 = (await generateKeyPairSigner()).address;
const S3 = (await generateKeyPairSigner()).address;
const OUTSIDER = (await generateKeyPairSigner()).address;
const FACILITATOR = (await generateKeyPairSigner()).address;
const SIG = "5".repeat(88);
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-05T00:00:00Z");

const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "fb-")), name);
const refusedWord = (r: unknown) => (r as { refused?: string }).refused;

function target(host: string, payTo: string, amount = "10000"): FirstBuyerTarget {
  return {
    host,
    requestUrl: `https://${host}/x`,
    exampleInput: null,
    lock: { payTo, amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: FACILITATOR },
    url: `https://${host}/x`,
    source: "payai",
    sources: ["payai"],
    declared: {},
    priceAtomic: amount,
    lastUpdated: "2026-10-01T00:00:00Z",
  };
}

const none = (payTo: string): ReceiptCheck => ({ payTo, verdict: "none", ataExists: true, accounts: [], signatures: 0, parsed: 0, ownReceipts: 0, outside: null, detail: "" });

/** Sellers that answer 402 for (payTo, amount) by host, 200 JSON when paid. Counts signatures and paid requests. */
function world(sellers: Record<string, { payTo: string; amount: string }>) {
  let signerCalls = 0;
  let paidRequests = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    const s = sellers[host]!;
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE")) {
      paidRequests++;
      return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    }
    const pr = {
      x402Version: 2,
      resource: { url },
      accepts: [{ scheme: "exact", network: SOLANA_MAINNET, amount: s.amount, asset: USDC_MINT, payTo: s.payTo, extra: { feePayer: FACILITATOR } }],
    };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  const pay: BuyDeps["pay"] = {
    fetch: f,
    payer: PAYER_ADDRESS,
    createPayment: async () => {
      signerCalls++;
      return { headers: { "PAYMENT-SIGNATURE": "signed" }, txBase64: "AAAA" };
    },
    checkTx: async (_tx, a) => ({ ok: true, facts: { feePayer: FACILITATOR, destinationAta: "x", amount: a.amount, memo: "m" } }),
    readBalances: async () => ({ lamports: 100_000_000n, usdcAtomic: 50_000_000n }),
    waitForSettlement: async (_s, _m, payTo) => {
      const amt = Object.values(sellers).find((x) => x.payTo === payTo)!.amount;
      return { signature: SIG, found: true, confirmed: true, err: null, memo: "m", payToDeltaAtomic: amt, payerDeltaAtomic: `-${amt}`, payerLamportsDelta: "0", feePayer: FACILITATOR };
    },
  } satisfies Omit<PayDeps, "budget">;
  return { pay, counts: () => ({ signerCalls, paidRequests }) };
}

function deps(pay: BuyDeps["pay"], over: Partial<BuyDeps> = {}): BuyDeps {
  return {
    pay,
    budget: new FirstBuyerBudget(null),
    ledger: new FirstBuyerLedger(null),
    own: new Set([PAYER_ADDRESS]),
    optOut: new Set(),
    checkReceipts: async (p) => none(p),
    now: () => T0,
    ...over,
  };
}

// ---------- 2. never the same payTo twice ----------

test("lifetime once: a payTo bought in an earlier run (ledger on disk) is skipped before signing", async () => {
  const file = tmp("ledger.json");
  const w = world({ "a.example": { payTo: S1, amount: "10000" } });
  const r1 = await buyAll([target("a.example", S1)], deps(w.pay, { ledger: new FirstBuyerLedger(file) }));
  assert.equal(r1.rows[0]!.outcome, "sent");
  assert.equal(r1.rows[0]!.settled, true);
  const r2 = await buyAll([target("a.example", S1)], deps(w.pay, { ledger: new FirstBuyerLedger(file), now: () => new Date(T0.getTime() + 400 * DAY) }));
  assert.equal(r2.rows[0]!.outcome, "skipped");
  assert.equal(r2.rows[0]!.reason, "already_bought");
  assert.deepEqual(w.counts(), { signerCalls: 1, paidRequests: 1 });
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.sellers[S1].attempts.length, 1);
  assert.equal(onDisk.sellers[S1].note, FB_NOTE);
});

test("lifetime once: the same payTo twice in one run, and under another host/URL, is bought once", async () => {
  const w = world({ "a.example": { payTo: S1, amount: "10000" }, "b.example": { payTo: S1, amount: "5000" } });
  // buyAll alone (no selection step) refuses the second one through the ledger
  const r = await buyAll([target("a.example", S1), target("b.example", S1, "5000"), target("a.example", S1)], deps(w.pay));
  assert.deepEqual(r.rows.map((x) => [x.host, x.outcome, x.reason]), [
    ["a.example", "sent", "delivered"],
    ["b.example", "skipped", "already_bought"],
    ["a.example", "skipped", "already_bought"],
  ]);
  assert.deepEqual(w.counts(), { signerCalls: 1, paidRequests: 1 });
  // the selection step keeps one per payTo (the cheaper) and names the other
  const c = choosePerPayTo([target("a.example", S1), target("b.example", S1, "5000")], { own: new Set(), optOut: new Set(), ledger: () => ({ ok: true, retry: false }) });
  assert.deepEqual(c.kept.map((t) => t.host), ["b.example"]);
  assert.deepEqual(c.excluded.map((e) => [e.host, e.reason]), [["a.example", "same_payto"]]);
});

test("the attempt is on disk before the signer is called; an unfinished attempt is never retried", async () => {
  const w = world({ "a.example": { payTo: S1, amount: "10000" } });
  // a run that died after recording the attempt: begin, no finish
  const file = tmp("ledger.json");
  assert.ok("index" in new FirstBuyerLedger(file).begin(S1, { host: "a.example", requestUrl: "https://a.example/x", amountAtomic: "10000" }, T0));
  const r = await buyAll([target("a.example", S1)], deps(w.pay, { ledger: new FirstBuyerLedger(file), now: () => new Date(T0.getTime() + 60 * DAY) }));
  assert.equal(r.rows[0]!.reason, "money_may_have_moved");
  assert.equal(w.counts().signerCalls, 0);
  // in a normal run the pending record is on disk when the signer is called
  const file2 = tmp("ledger.json");
  let pendingOnDisk = false;
  const pay2 = {
    ...w.pay,
    createPayment: async (...a: Parameters<BuyDeps["pay"]["createPayment"]>) => {
      const l = JSON.parse(readFileSync(file2, "utf8"));
      pendingOnDisk = l.sellers[S1].attempts[0].state === "pending";
      return w.pay.createPayment(...a);
    },
  };
  await buyAll([target("a.example", S1)], deps(pay2, { ledger: new FirstBuyerLedger(file2) }));
  assert.equal(pendingOnDisk, true);
});

test("no money moved: retried at +7 and +30 days, then never again", () => {
  const e: SellerEntry = {
    payTo: S1,
    note: FB_NOTE,
    firstAttemptAt: T0.toISOString(),
    attempts: [],
    reciprocal: { boughtFromVet402WithinDays: 90, value: false, checkedAt: null },
  };
  const att = (state: "refused" | "not_sent" | "sent" | "pending") => ({
    at: T0.toISOString(), host: "a", requestUrl: "u", amountAtomic: "1", state, moneyMayHaveMoved: state === "sent" || state === "pending",
    tx: null, settled: null, delivered: null, reason: null, category: null, detail: null,
  });
  const at = (d: number) => new Date(T0.getTime() + d * DAY);
  assert.deepEqual(eligibility(undefined, T0), { ok: true, retry: false });
  e.attempts = [att("refused")];
  assert.equal((eligibility(e, at(6.99)) as { reason: string }).reason, "retry_not_due");
  assert.deepEqual(eligibility(e, at(7)), { ok: true, retry: true });
  e.attempts = [att("refused"), att("not_sent")];
  assert.equal((eligibility(e, at(29)) as { reason: string }).reason, "retry_not_due");
  assert.deepEqual(eligibility(e, at(30)), { ok: true, retry: true });
  e.attempts = [att("refused"), att("not_sent"), att("refused")];
  assert.equal((eligibility(e, at(400)) as { reason: string }).reason, "retries_exhausted");
  e.attempts = [att("refused"), att("sent")];
  assert.equal((eligibility(e, at(400)) as { reason: string }).reason, "already_bought");
  e.attempts = [att("pending")];
  assert.equal((eligibility(e, at(400)) as { reason: string }).reason, "money_may_have_moved");
});

test("a malformed ledger stops the run instead of starting from empty", () => {
  const file = tmp("ledger.json");
  writeFileSync(file, "{not json");
  assert.throws(() => new FirstBuyerLedger(file), /not valid JSON/);
  writeFileSync(file, JSON.stringify({ kind: "vet402-first-buyer-ledger", sellers: { [S1]: { payTo: S2, attempts: [] } } }));
  assert.throws(() => new FirstBuyerLedger(file), /malformed/);
});

test("a dry-run ledger (read-only) never writes its file", async () => {
  const file = tmp("ledger.json");
  const w = world({ "a.example": { payTo: S1, amount: "10000" } });
  await buyAll([target("a.example", S1)], deps({ ...w.pay, dryRun: true, signerAddress: FACILITATOR }, { ledger: new FirstBuyerLedger(file, true) }));
  assert.throws(() => readFileSync(file));
});

// ---------- 3. caps: 0.10 per purchase, 5 per run, 20 per month ----------

test("caps are 0.10 / 5 / 20 USDC", () => {
  assert.equal(FB_MAX_PER_PURCHASE_ATOMIC, 100_000n);
  assert.equal(FB_MAX_PER_RUN_ATOMIC, 5_000_000n);
  assert.equal(FB_MAX_PER_MONTH_ATOMIC, 20_000_000n);
});

test("per purchase: 0.100000 passes, 0.100001 is refused", () => {
  const b = new FirstBuyerBudget(null);
  assert.ok("ok" in b.reserve(100_000n, "a"));
  assert.equal(refusedWord(b.reserve(100_001n, "b")), "price_over_cap");
});

test("per run: exactly 5.000000 passes, one more atomic unit is refused; a release gives the share back", () => {
  const b = new FirstBuyerBudget(null);
  for (let i = 0; i < 49; i++) assert.ok("ok" in b.reserve(100_000n, `h${i}`));
  assert.ok("ok" in b.reserve(99_999n, "h49"));
  const last = b.reserve(1n, "h50");
  assert.ok("ok" in last);
  assert.equal(b.runSpentAtomic, 5_000_000n);
  assert.equal(refusedWord(b.reserve(1n, "h51")), "total_cap_reached");
  b.release((last as { id: string }).id);
  assert.equal(b.runSpentAtomic, 4_999_999n);
  assert.ok("ok" in b.reserve(1n, "h52"));
});

test("per month: persisted across runs; exactly 20.000000 passes, one more unit is refused", () => {
  const file = tmp("budget-2026-10.json");
  for (let run = 0; run < 4; run++) {
    const b = new FirstBuyerBudget(file); // a new run: run cap resets, month file carries over
    for (let i = 0; i < 50; i++) {
      const r = b.reserve(100_000n, `r${run}-h${i}`);
      assert.ok("ok" in r, `run ${run} purchase ${i}`);
      b.commit((r as { id: string }).id);
    }
  }
  const b5 = new FirstBuyerBudget(file);
  assert.equal(b5.spent, 20_000_000n);
  assert.equal(refusedWord(b5.reserve(1n, "one-more")), "total_cap_reached");
});

test("month cap also counts what the chain says left the payer (existing Budget baseline)", () => {
  const b = new FirstBuyerBudget(null);
  b.setBaselineIfMissing(50_000_000n);
  assert.equal(refusedWord(b.reserve(100_000n, "x", 30_000_000n)), "total_cap_reached"); // 20.00 already left
  assert.ok("ok" in b.reserve(100_000n, "y", 30_100_000n));
});

test("buyAll stops at the run cap before recording an attempt", async () => {
  const sellers: Record<string, { payTo: string; amount: string }> = {};
  const ts: FirstBuyerTarget[] = [];
  for (let i = 0; i < 52; i++) {
    const p = (await generateKeyPairSigner()).address;
    sellers[`s${i}.example`] = { payTo: p, amount: "100000" };
    ts.push(target(`s${i}.example`, p, "100000"));
  }
  const w = world(sellers);
  const led = new FirstBuyerLedger(null);
  const r = await buyAll(ts, deps(w.pay, { ledger: led }));
  assert.equal(r.rows.filter((x) => x.outcome === "sent").length, 50);
  assert.equal(r.stopped, "cap reached");
  assert.equal(r.rows.at(-1)!.reason, "total_cap_reached");
  assert.equal(Object.keys(led.data.sellers).length, 50);
  assert.equal(w.counts().signerCalls, 50);
});

// ---------- 4. who is never bought ----------

test("outside receipts, unverified receipts, opt-out and own payTo are skipped before signing", async () => {
  const w = world({ "a.example": { payTo: S1, amount: "10000" }, "b.example": { payTo: S2, amount: "10000" }, "c.example": { payTo: S3, amount: "10000" }, "d.example": { payTo: PAYER_ADDRESS, amount: "10000" }, "e.example": { payTo: OUTSIDER, amount: "10000" } });
  const r = await buyAll(
    [target("a.example", S1), target("b.example", S2), target("c.example", S3), target("d.example", PAYER_ADDRESS), target("e.example", OUTSIDER)],
    deps(w.pay, {
      optOut: new Set([S3]),
      checkReceipts: async (p) =>
        p === S1 ? { ...none(p), verdict: "outside", detail: "USDC 5 received" } : p === S2 ? { ...none(p), verdict: "unverified", detail: "rpc: rate limited" } : none(p),
    }),
  );
  assert.deepEqual(r.rows.map((x) => [x.host, x.outcome, x.reason]), [
    ["a.example", "skipped", "outside_receipts"],
    ["b.example", "skipped", "receipts_unverified"],
    ["c.example", "skipped", "opted_out"],
    ["d.example", "skipped", "own_payto"],
    ["e.example", "sent", "delivered"],
  ]);
  assert.deepEqual(w.counts(), { signerCalls: 1, paidRequests: 1 });
});

test("a payTo without a USDC account is reported and does not use up its attempt", async () => {
  const w = world({ "a.example": { payTo: S1, amount: "10000" } });
  const led = new FirstBuyerLedger(null);
  const r = await buyAll([target("a.example", S1)], deps(w.pay, { ledger: led, checkReceipts: async (p) => ({ ...none(p), ataExists: false }) }));
  assert.deepEqual([r.rows[0]!.outcome, r.rows[0]!.reason], ["skipped", "payto_no_usdc_account"]);
  assert.equal(w.counts().signerCalls, 0);
  assert.deepEqual(led.data.sellers, {});
});

test("selection: own payTo and opt-out are excluded; the opt-out file reads an array or { payTo: [] }", () => {
  const c = choosePerPayTo([target("a.example", S1), target("b.example", S2), target("c.example", S3)], {
    own: new Set([S2]),
    optOut: new Set(parseOptOut(JSON.stringify({ payTo: [S3] }))),
    ledger: () => ({ ok: true, retry: false }),
  });
  assert.deepEqual(c.kept.map((t) => t.host), ["a.example"]);
  assert.deepEqual(c.excluded.map((e) => e.reason).sort(), ["opted_out", "own_payto"]);
  assert.deepEqual(parseOptOut("[]"), []);
  assert.throws(() => parseOptOut('{"x":1}'));
});

test("own payTos come from listings on vet402's own hosts", () => {
  const l = [
    { resource: "https://vet402.com/api/x", accepts: [{ scheme: "exact", network: "solana", payTo: S1, asset: USDC_MINT, maxAmountRequired: "1" }] },
    { resource: "https://api.vet402.com/y", accepts: [{ scheme: "exact", network: SOLANA_MAINNET, payTo: S2, asset: USDC_MINT, amount: "1" }] },
    { resource: "https://other.example/z", accepts: [{ scheme: "exact", network: SOLANA_MAINNET, payTo: S3, asset: USDC_MINT, amount: "1" }] },
  ];
  assert.deepEqual(ownPayTosFromListings(l), [S1, S2].sort());
});

function hp(host: string, lastUpdated: string | undefined, placeholderOnly = false): HostPlan {
  const c: CensusCandidate = {
    source: "payai",
    sources: ["payai"],
    url: `https://${host}/x`,
    host,
    requestUrl: `https://${host}/x`,
    exampleScore: placeholderOnly ? 0 : 1,
    exampleInput: null,
    priceAtomic: 10_000n,
    declaredAccept: null,
    declared: {},
    ...(lastUpdated ? { lastUpdated } : {}),
  };
  return { host, hostSources: ["payai"], candidates: placeholderOnly ? [] : [c], placeholder: placeholderOnly ? [c] : [] };
}

test("hosts: tunnel hosts, placeholder-only, not new since, and undated are excluded", () => {
  assert.equal(isTempHost("abc-def.trycloudflare.com"), true);
  assert.equal(isTempHost("x.ngrok-free.app"), true);
  assert.equal(isTempHost("trycloudflare.com.evil.example"), false);
  const hosts = [
    hp("new.example", "2026-09-25T10:00:00Z"),
    hp("edge.example", "2026-09-21T00:00:00Z"),
    hp("old.example", "2026-09-20T23:59:59Z"),
    hp("undated.example", undefined),
    hp("x.trycloudflare.com", "2026-09-28T00:00:00Z"),
    hp("ph.example", "2026-09-28T00:00:00Z", true),
  ];
  const r = preselectHosts(hosts, { since: "2026-09-21" });
  assert.equal(r.basis, "catalog_lastUpdated");
  assert.deepEqual(r.keep.map((h) => h.host), ["new.example", "edge.example"]);
  assert.deepEqual(Object.fromEntries(r.excluded.map((e) => [e.host, e.reason])), {
    "old.example": "not_new_since",
    "undated.example": "no_listing_date",
    "x.trycloudflare.com": "temporary_host",
    "ph.example": "placeholder_unfillable",
  });
});

test("hosts: once a run older than --since exists, new means not seen before --since", () => {
  let seen = recordSeen(emptySeen(), ["old.example", "undated.example"], "2026-09-28");
  seen = recordSeen(seen, ["old.example", "fresh.example"], "2026-10-02");
  const r = preselectHosts([hp("old.example", "2026-10-03T00:00:00Z"), hp("fresh.example", undefined), hp("brand-new.example", undefined)], { since: "2026-09-29", seen });
  assert.equal(r.basis, "seen_snapshot");
  assert.deepEqual(r.keep.map((h) => h.host), ["fresh.example", "brand-new.example"]);
  assert.deepEqual(r.excluded.map((e) => [e.host, e.reason]), [["old.example", "not_new_since"]]);
});

// ---------- outside receipts on chain (mocked RPC) ----------

function tb(owner: string, amount: string) {
  return { owner, mint: USDC_MINT, uiTokenAmount: { amount } };
}

function rpcWith(sigs: string[], opts: { fail?: boolean } = {}): Rpc {
  return async (method) => {
    if (opts.fail) throw new Error("rpc getSignaturesForAddress: rate limited");
    if (method === "getTokenAccountsByOwner") return { value: [] };
    if (method === "getSignaturesForAddress") return sigs.map((signature) => ({ signature, err: null }));
    if (method === "getTransaction") return null;
    throw new Error(method);
  };
}

function rpcTx(sigs: string[], txs: Record<string, unknown>): Rpc {
  return async (method, params) => {
    if (method === "getTokenAccountsByOwner") return { value: [] };
    if (method === "getSignaturesForAddress") return sigs.map((signature) => ({ signature, err: null }));
    if (method === "getTransaction") return txs[params[0] as string] ?? null;
    throw new Error(method);
  };
}

test("receiptOf: a USDC increase is a receipt, with the owners whose USDC went down", () => {
  const tx = { meta: { err: null, preTokenBalances: [tb(S1, "0"), tb(OUTSIDER, "100")], postTokenBalances: [tb(S1, "10"), tb(OUTSIDER, "90")] } };
  assert.deepEqual(receiptOf(tx, S1), { amount: 10n, fromOwners: [OUTSIDER] });
  assert.equal(receiptOf({ meta: { err: null, preTokenBalances: [tb(S1, "10")], postTokenBalances: [tb(S1, "0")] } }, S1), null);
  assert.equal(receiptOf({ meta: { err: { x: 1 }, preTokenBalances: [], postTokenBalances: [tb(S1, "10")] } }, S1), null);
});

test("checkOutsideReceipts: none / only vet402 / outside / unverified", async () => {
  const own = new Set([PAYER_ADDRESS]);
  assert.equal((await checkOutsideReceipts(rpcTx([], {}), S1, own)).verdict, "none");
  const fromUs = { meta: { err: null, preTokenBalances: [tb(PAYER_ADDRESS, "100")], postTokenBalances: [tb(S1, "10"), tb(PAYER_ADDRESS, "90")] } };
  const fromOut = { meta: { err: null, preTokenBalances: [tb(OUTSIDER, "100")], postTokenBalances: [tb(S1, "10"), tb(OUTSIDER, "90")] } };
  const created = { meta: { err: null, preTokenBalances: [], postTokenBalances: [tb(S1, "0")] } };
  const c1 = await checkOutsideReceipts(rpcTx(["a", "b"], { a: fromUs, b: created }), S1, own);
  assert.deepEqual([c1.verdict, c1.ownReceipts], ["only_own", 1]);
  const c2 = await checkOutsideReceipts(rpcTx(["a", "b"], { a: fromUs, b: fromOut }), S1, own);
  assert.equal(c2.verdict, "outside");
  assert.equal(c2.outside?.tx, "b");
  const noSender = { meta: { err: null, preTokenBalances: [], postTokenBalances: [tb(S1, "10")] } };
  assert.equal((await checkOutsideReceipts(rpcTx(["a"], { a: noSender }), S1, own)).verdict, "outside"); // unknown sender counts as outside
  assert.equal((await checkOutsideReceipts(rpcWith([], { fail: true }), S1, own)).verdict, "unverified");
  assert.equal((await checkOutsideReceipts(rpcWith(["a"]), S1, own)).verdict, "unverified"); // transaction not returned
  const many = Array.from({ length: 5 }, (_, i) => `s${i}`);
  const txs = Object.fromEntries(many.map((s) => [s, created]));
  assert.equal((await checkOutsideReceipts(rpcTx(many, txs), S1, own, { txLimit: 3 })).verdict, "unverified"); // not read to the end
  assert.equal((await checkOutsideReceipts(rpcTx(many, txs), S1, own, { sigLimit: 5 })).verdict, "unverified"); // more signatures than read
});

test("checkOutsideReceipts reads the associated token account even when the owner lists none", async () => {
  const asked: string[] = [];
  const rpc: Rpc = async (method, params) => {
    if (method === "getTokenAccountsByOwner") return { value: [] };
    if (method === "getSignaturesForAddress") {
      asked.push(params[0] as string);
      return [];
    }
    throw new Error(method);
  };
  const c = await checkOutsideReceipts(rpc, S1, new Set());
  assert.deepEqual(asked, [await usdcAta(S1)]);
  assert.equal(c.ataExists, false);
  const ata = await usdcAta(S1);
  const rpc2: Rpc = async (method) => (method === "getTokenAccountsByOwner" ? { value: [{ pubkey: ata }] } : []);
  assert.equal((await checkOutsideReceipts(rpc2, S1, new Set())).ataExists, true);
});

// ---------- 5. public words ----------

const BAD_WORDS = /\b(we|us|our|ours)\b/i;
const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;
const EM_DASH = /\u2014/;

test("published JSON carries the note and no we/us/our, Japanese or em dash", async () => {
  const w = world({ "a.example": { payTo: S1, amount: "10000" } });
  const led = new FirstBuyerLedger(null);
  await buyAll([target("a.example", S1)], deps(w.pay, { ledger: led }));
  const texts = [JSON.stringify(led.data), JSON.stringify(walletsJson()), JSON.stringify(publicRows(led.data))];
  for (const t of texts) {
    assert.ok(t.includes(FB_NOTE));
    for (const re of [BAD_WORDS, JAPANESE, EM_DASH]) assert.equal(re.test(t.replaceAll(/https?:\/\/[^"]+/g, "")), false, `${re} in ${t.slice(0, 200)}`);
  }
  const rows = publicRows(led.data);
  assert.deepEqual([rows[0]!.payTo, rows[0]!.tx, rows[0]!.settled, rows[0]!.delivered, rows[0]!.failureReason, rows[0]!.reciprocal], [S1, SIG, true, true, null, false]);
});
