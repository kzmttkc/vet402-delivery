import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { MEASURE_SPACING_MS, PAYER_ADDRESS, SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";
import { SellerPacer } from "../src/measure.js";
import type { PayDeps } from "../src/pay.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E, FEE_RESERVE_ATOMIC } from "../src/tempo/constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "../src/tempo/challenge.js";
import { Ledger, type LedgerEntry } from "../src/tempo/ledger.js";
import { payOne as tempoPayOne, type PayDeps as TempoPayDeps } from "../src/tempo/pay.js";
import { DAY_LEDGER_INDEX, accountedOutflow, assertCensusLedger, entryOutflow, registerDayLedger, unaccountedChainSpent, TEMPO_KEY_LEDGERS, type KeyLedgerSet } from "../src/tempo/key-ledgers.js";
import type { Signer } from "../src/tempo/chain.js";
import { aggregate, rank } from "../src/rank/score.js";
import type { Attempt } from "../src/rank/types.js";
import { RemeasureBudget, budgetKey } from "../src/remeasure/budget.js";
import { RM_PROD_DIR, RM_SOLANA_MAX_PER_MONTH_ATOMIC, RM_SOLANA_MAX_PER_RUN_ATOMIC, RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../src/remeasure/constants.js";
import { selectSlots, solanaFromCensus, solanaFromGate1, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { dryRunSolana, paySolana } from "../src/remeasure/solana.js";
import { dayLedgerPath, dryRunTempo, firstBlockAtOrAfter, monthCommittedElsewhere, payTempo, type TempoChainView } from "../src/remeasure/tempo.js";
import { reconcileSolana, reconcileTempo } from "../src/remeasure/reconcile.js";
import type { Slot } from "../src/remeasure/loop.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import { resultFilesUpTo, runDirs, type RemeasureRow, type ResultFile } from "../src/remeasure/results.js";
import { isMonthCapStop, runOutcome } from "../src/daily/steps.js";

const FACILITATOR = (await generateKeyPairSigner()).address;
const P1 = (await generateKeyPairSigner()).address;
const P2 = (await generateKeyPairSigner()).address;
const P3 = (await generateKeyPairSigner()).address;
const OTHER_SOL = (await generateKeyPairSigner()).address;
const SIG = "5".repeat(88);
const DATE = "2026-10-01";
const tmp = () => mkdtempSync(join(tmpdir(), "rm-"));
const read = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", p), "utf8"));

// ---------- targets from the published data ----------

test("targets: settled purchases only, one slot per payTo, cheapest resource first", () => {
  const sol = [...solanaFromCensus(read("solana/census-2026-09-28.json"), "c"), ...solanaFromGate1(read("solana/gate1-2026-09-29.json"), "g")];
  assert.equal(sol.length, 96);
  assert.ok(sol.every((t) => t.solana!.lock.payTo === t.payTo && /^\d+$/.test(t.amountAtomic) && BigInt(t.amountAtomic) <= 100_000n));
  const s = selectSlots(sol, 1);
  assert.equal(s.payTos, 94);
  assert.equal(s.slots.length, 94);
  assert.equal(new Set(s.slots.map((x) => x.target.payTo)).size, 94);

  const tem = tempoFromLedger(read("tempo/ledger.json"), read("tempo/census-plan-2026-09-28.json"), "t");
  // 72: the census's 70 settled purchases plus goflightlabs and modal, found settled on chain by the chain check (2026-09-30)
  assert.equal(tem.length, 72);
  const ts = selectSlots(tem, 1);
  assert.equal(ts.payTos, 35);
  // their recipient (the mpp.tempo.xyz proxy) already had a slot; its cheapest resource is now modal (100 atomic)
  assert.equal(ts.slots.find((x) => x.target.payTo === "0xca4e835f803cb0b7c428222b3a3b98518d4779fe")!.target.service, "modal");
  // the payTo that fronts 28 services gets one slot, always the same (cheapest, then URL)
  const locus = tem.filter((t) => t.payTo === "0x060b0fb0be9d90557577b3aee480711067149ff0");
  assert.equal(locus.length, 28);
  const chosen = ts.slots.find((x) => x.target.payTo === "0x060b0fb0be9d90557577b3aee480711067149ff0")!.target;
  assert.equal(BigInt(chosen.amountAtomic), locus.reduce((m, t) => (BigInt(t.amountAtomic) < m ? BigInt(t.amountAtomic) : m), 10n ** 18n));
  assert.deepEqual(selectSlots(tem, 1).slots.map((x) => x.target.service), ts.slots.map((x) => x.target.service));
});

test("targets: vet402's own hosts and payers are never selected; slots go round by payTo", () => {
  const t = (host: string, payTo: string, amount = "1000"): Target => ({
    chain: "solana", host, service: null, url: `https://${host}/x`, requestUrl: `https://${host}/x`, payTo, amountAtomic: amount, from: "t",
    solana: { lock: { payTo, amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: FACILITATOR } },
  });
  const s = selectSlots([t("vet402.com", P1), t("a.example", PAYER_ADDRESS), t("b.example", P2), t("c.example", P2, "500"), t("d.example", P3)], 3);
  assert.deepEqual(s.excluded.map((e) => e.reason).sort(), ["own_host", "own_payto"]);
  assert.equal(s.slots.length, 6);
  // round 0 covers every payTo before round 1 starts
  assert.deepEqual(new Set(s.slots.slice(0, 2).map((x) => x.target.payTo)), new Set([P2, P3]));
  // P2: c (cheaper) then b then c again
  assert.deepEqual(s.slots.filter((x) => x.target.payTo === P2).map((x) => x.target.host), ["c.example", "b.example", "c.example"]);
});

// ---------- Solana: fake sellers ----------

function solTarget(host: string, payTo: string, amount = "10000"): Target {
  return {
    chain: "solana", host, service: null, url: `https://${host}/x`, requestUrl: `https://${host}/x`, payTo, amountAtomic: amount, from: "test",
    solana: { lock: { payTo, amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: FACILITATOR } },
  };
}

function solWorld(sellers: Record<string, { payTo: string; amount: string }>, clock: { t: number } = { t: 0 }) {
  const signs: { host: string; at: number }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    const s = sellers[host]!;
    if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    const pr = { x402Version: 2, resource: { url }, accepts: [{ scheme: "exact", network: SOLANA_MAINNET, amount: s.amount, asset: USDC_MINT, payTo: s.payTo, extra: { feePayer: FACILITATOR } }] };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  const pay: Omit<PayDeps, "budget"> = {
    fetch: f,
    payer: PAYER_ADDRESS,
    createPayment: async (pr) => {
      signs.push({ host: new URL((pr as { resource: { url: string } }).resource.url).host, at: clock.t });
      return { headers: { "PAYMENT-SIGNATURE": "signed" }, txBase64: "AAAA" };
    },
    checkTx: async (_tx, a) => ({ ok: true, facts: { feePayer: FACILITATOR, destinationAta: "x", amount: a.amount, memo: "m" } }),
    readBalances: async () => ({ lamports: 100_000_000n, usdcAtomic: 50_000_000n }),
    waitForSettlement: async (_s, _m, payTo) => {
      const amt = Object.values(sellers).find((x) => x.payTo === payTo)!.amount;
      return { signature: SIG, found: true, confirmed: true, err: null, memo: "m", payToDeltaAtomic: amt, payerDeltaAtomic: `-${amt}`, payerLamportsDelta: "0", feePayer: FACILITATOR };
    },
  };
  return { pay, signs, clock };
}

function fakeTime() {
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    now: () => new Date(clock.t),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    pacer: () => new SellerPacer(5, MEASURE_SPACING_MS, () => clock.t),
  };
}

test("solana: one purchase per payTo per run by default; the budget file is written before signing", async () => {
  const dir = tmp();
  const ft = fakeTime();
  const w = solWorld({ "a.example": { payTo: P1, amount: "10000" }, "b.example": { payTo: P1, amount: "20000" }, "c.example": { payTo: P2, amount: "10000" } }, ft.clock);
  const budget = new RemeasureBudget(join(dir, "budget.json"));
  let fileAtFirstSign: string | null = null;
  const pay: Omit<PayDeps, "budget"> = {
    ...w.pay,
    createPayment: async (pr, a) => ((fileAtFirstSign ??= readFileSync(join(dir, "budget.json"), "utf8")), w.pay.createPayment(pr, a)),
  };
  const sel = selectSlots([solTarget("a.example", P1), solTarget("b.example", P1, "20000"), solTarget("c.example", P2)], 1);
  const res = await paySolana(sel.slots, pay, { date: DATE, budget, now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(res.stopped, null);
  // P1 has a (0.01) and b (0.02): only a, the cheaper one, is bought
  assert.deepEqual(res.rows.map((r) => [r.host, r.outcome, r.settled, r.delivered]).sort(), [["a.example", "sent", true, true], ["c.example", "sent", true, true]]);
  assert.equal(w.signs.length, 2);
  assert.match(fileAtFirstSign!, new RegExp(`${DATE}\\|`));
  assert.equal(budget.runSpentAtomic, 20_000n);
});

test("solana: the same payTo twice in one run waits MEASURE_SPACING_MS between purchases", async () => {
  const ft = fakeTime();
  const w = solWorld({ "a.example": { payTo: P1, amount: "10000" } }, ft.clock);
  const sel = selectSlots([solTarget("a.example", P1)], 3);
  const res = await paySolana(sel.slots, w.pay, { date: DATE, budget: new RemeasureBudget(null), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(res.rows.length, 3);
  assert.equal(w.signs.length, 3);
  for (let i = 1; i < w.signs.length; i++) assert.ok(w.signs[i]!.at - w.signs[i - 1]!.at >= MEASURE_SPACING_MS, `gap ${w.signs[i]!.at - w.signs[i - 1]!.at}`);
  assert.deepEqual(ft.sleeps, [MEASURE_SPACING_MS, MEASURE_SPACING_MS]);
});

test("solana: more than MEASURE_MAX_PER_SELLER slots for one payTo are skipped, never signed", async () => {
  const ft = fakeTime();
  const w = solWorld({ "a.example": { payTo: P1, amount: "1000" } }, ft.clock);
  const slots = Array.from({ length: 7 }, (_, i) => ({ target: solTarget("a.example", P1, "1000"), slot: i }));
  const res = await paySolana(slots, w.pay, { date: DATE, budget: new RemeasureBudget(null), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w.signs.length, 5);
  assert.deepEqual(res.skipped.map((s) => s.reason), ["per_payto_limit", "per_payto_limit"]);
});

test("solana: run cap boundary: exactly the cap is bought, one atomic unit more stops before signing", async () => {
  // 3 USDC run cap: 30 purchases of 0.10 fit exactly; the 31st does not.
  const sellers: Record<string, { payTo: string; amount: string }> = {};
  const targets: Target[] = [];
  for (let i = 0; i < 31; i++) {
    const payTo = (await generateKeyPairSigner()).address;
    sellers[`s${i}.example`] = { payTo, amount: "100000" };
    targets.push(solTarget(`s${i}.example`, payTo, "100000"));
  }
  const ft = fakeTime();
  const w = solWorld(sellers, ft.clock);
  const budget = new RemeasureBudget(null);
  const res = await paySolana(selectSlots(targets, 1).slots, w.pay, { date: DATE, budget, now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w.signs.length, 30);
  assert.equal(budget.runSpentAtomic, RM_SOLANA_MAX_PER_RUN_ATOMIC);
  assert.match(res.stopped!, /^total_cap_reached: run 3000000 \+ 100000 > 3000000/);
  // the Budget itself (inside payOne) holds the same line
  const b = new RemeasureBudget(null, 30_000n);
  assert.ok("ok" in b.reserve(30_000n, "k1"));
  assert.equal((b.reserve(1n, "k2") as { refused: string }).refused, "total_cap_reached");
});

test("solana: month cap boundary, persisted: what is left is bought, then the run stops before signing; a second run the same day cannot rebuy", async () => {
  const dir = tmp();
  const file = join(dir, "budget-solana-2026-10.json");
  // 29.99 USDC already spent this month
  writeFileSync(file, JSON.stringify({ baselineAtomic: null, spentAtomic: (RM_SOLANA_MAX_PER_MONTH_ATOMIC - 10_000n).toString(), purchases: [] }));
  const ft = fakeTime();
  const w = solWorld({ "a.example": { payTo: P1, amount: "10000" }, "b.example": { payTo: P2, amount: "10000" } }, ft.clock);
  const slots = selectSlots([solTarget("a.example", P1), solTarget("b.example", P2)], 1).slots;
  const res = await paySolana(slots, w.pay, { date: DATE, budget: new RemeasureBudget(file), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w.signs.length, 1);
  assert.match(res.stopped!, /^total_cap_reached: month 30000000 \+ 10000 > 30000000/);
  assert.equal(new RemeasureBudget(file).spent, RM_SOLANA_MAX_PER_MONTH_ATOMIC);

  // same day, fresh month budget with room: the key <date>|<payTo>|<slot> is already in the file
  const dir2 = tmp();
  const f2 = join(dir2, "budget.json");
  const w2 = solWorld({ "a.example": { payTo: P1, amount: "10000" } }, ft.clock);
  const one = selectSlots([solTarget("a.example", P1)], 1).slots;
  await paySolana(one, w2.pay, { date: DATE, budget: new RemeasureBudget(f2), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  const again = await paySolana(one, w2.pay, { date: DATE, budget: new RemeasureBudget(f2), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w2.signs.length, 1);
  assert.equal(again.rows[0]!.reason, "already_bought");
  assert.equal(again.rows[0]!.outcome, "refused");
  // the next day it may be bought again
  await paySolana(one, w2.pay, { date: "2026-10-02", budget: new RemeasureBudget(f2), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w2.signs.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f2, "utf8")).purchases.map((p: { key: string }) => p.key), [budgetKey(DATE, P1, 0), budgetKey("2026-10-02", P1, 0)]);
});

test("solana: a live 402 naming another payTo is not paid and is recorded as pay_to_changed", async () => {
  const ft = fakeTime();
  const w = solWorld({ "a.example": { payTo: OTHER_SOL, amount: "10000" } }, ft.clock);
  const budget = new RemeasureBudget(null);
  const res = await paySolana(selectSlots([solTarget("a.example", P1)], 1).slots, w.pay, { date: DATE, budget, now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w.signs.length, 0);
  assert.equal(budget.spent, 0n);
  const r = res.rows[0]!;
  assert.deepEqual([r.outcome, r.reason, r.payTo, r.expectedPayTo], ["refused", "pay_to_changed", OTHER_SOL, P1]);
  const a = normalizeRemeasure(fileOf("solana", [r]), "remeasure/solana-2026-10-01")[0]!;
  assert.deepEqual([a.category, a.tried, a.payTo, a.expectedPayTo], ["payto_changed", false, OTHER_SOL, P1]);
  // dry run says the same without anything built
  const d = await dryRunSolana(selectSlots([solTarget("a.example", P1)], 1).slots, w.pay.fetch, { date: DATE, budget: new RemeasureBudget(null) });
  assert.equal(d.rows[0]!.reason, "pay_to_changed");
  assert.equal(w.signs.length, 0);
});

test("solana dry run: would_pay within the caps, over-cap slots listed, nothing signed or written", async () => {
  const w = solWorld({ "a.example": { payTo: P1, amount: "10000" }, "b.example": { payTo: P2, amount: "10000" } });
  const res = await dryRunSolana(selectSlots([solTarget("a.example", P1), solTarget("b.example", P2)], 1).slots, w.pay.fetch, {
    date: DATE,
    budget: new RemeasureBudget(null, RM_SOLANA_MAX_PER_RUN_ATOMIC, 10_000n),
  });
  assert.deepEqual(res.rows.map((r) => r.outcome), ["would_pay"]);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.stopped, null);
  assert.equal(w.signs.length, 0);
});

// ---------- Tempo: fake seller and signer ----------

const throwaway = privateKeyToAccount(generatePrivateKey());
const SELLER = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const OTHER = "0x1111111111111111111111111111111111111111";

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const challenge = (recipient: string, amount: string) =>
  `Payment id="abc", realm="svc.example", method="tempo", intent="charge", request="${b64url({ amount, currency: USDC_E, recipient, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;

async function signedTransfer(to: string, amount: bigint): Promise<string> {
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [to as Hex, amount] });
  const tx = { type: "tempo" as const, chainId: 4217, calls: [{ to: USDC_E as Hex, data }], nonce: 0, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonceKey: 2n ** 256n - 1n, validBefore: 1_790_000_000 };
  return throwaway.signTransaction(tx as never, { serializer: Transaction.serialize as never });
}

function tempoTarget(service: string, amount = "6000", recipient = SELLER): Target {
  const payTo = recipient.toLowerCase();
  return {
    chain: "tempo", host: "svc.example", service, url: `https://svc.example/${service}`, requestUrl: `https://svc.example/${service}`, payTo, amountAtomic: amount, from: "test",
    tempo: {
      plan: { serviceId: service, request: { url: `https://svc.example/${service}`, method: "GET", body: null, contentType: null, inputSource: "none" }, lockedRecipient: payTo, lockedAmount: amount, sponsored: false, allowlist: [] },
      feeReserveAtomic: FEE_RESERVE_ATOMIC.toString(),
    },
  };
}

/** A seller, a signer and a chain: every paid request moves amount + a 30 fee out of the key. */
function tempoEnv(o: { censusSlack?: boolean; liveFor?: (url: string) => { recipient: string; amount: string } } = {}) {
  const root = tmp();
  const set: KeyLedgerSet = { census: join(root, "census", "tempo-ledger.json"), remeasureDir: join(root, "rm") };
  const chain = { total: 0n, month: 0n };
  if (o.censusSlack !== false) {
    // The census ledger reserves more than left the key (fee reserve 2,000 vs 30 paid; a transfer never found).
    const c = new Ledger(set.census, throwaway.address, 2_500_000n);
    c.reserve({ key: "old1", url: "u1", recipient: SELLER, amount: 10_000n, sponsored: false });
    c.update("old1", { status: "sent", settled: true, feePaid: "30" });
    c.reserve({ key: "old2", url: "u2", recipient: SELLER, amount: 5_000n, sponsored: false });
    c.update("old2", { status: "sent", settled: false, note: "receipt not found" });
    chain.total += 10_030n;
  }
  const liveFor = o.liveFor ?? (() => ({ recipient: SELLER, amount: "6000" }));
  let signs = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const live = liveFor(url);
    if (new Headers(init?.headers).get("authorization")) {
      const out = BigInt(live.amount) + 30n;
      chain.total += out;
      chain.month += out;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 402, headers: { "www-authenticate": challenge(live.recipient, live.amount) } });
  };
  const signer: Signer = {
    address: throwaway.address,
    async credentialFor(res, _id, recipient) {
      signs++;
      const amount = BigInt(tempoChargeRequest(mppChallengesFromHeader(res.headers.get("www-authenticate"))[0]!)!.amount);
      return { credential: "Payment eyJ4IjoxfQ", serializedTx: await signedTransfer(recipient, amount) };
    },
  };
  const pay: Omit<TempoPayDeps, "ledger" | "chainSpent"> = {
    fetchImpl,
    signer,
    payer: throwaway.address,
    balance: async () => 10_000_000n,
    verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }),
  };
  const view: TempoChainView = { outflowSinceCensusStart: async () => chain.total, outflowSinceMonthStart: async () => chain.month };
  const ft = fakeTime();
  // as the script does: list the day in the index (refused when it was deleted), then open the ledger
  const dayLedger = (date: string) => {
    registerDayLedger(set, date, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
    return new Ledger(dayLedgerPath(set.remeasureDir, date), throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  };
  const run = async (slots: Slot[], date: string, ledger?: Ledger, monthElsewhere = 0n) =>
    payTempo(slots, pay, { date, ledger: ledger ?? dayLedger(date), keyLedgers: set, chain: view, monthElsewhere, now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  return { set, chain, pay, view, fetchImpl, run, dayLedger, signs: () => signs };
}

test("tempo: pays through payOne, one per payTo, and records the paid amount", async () => {
  const e = tempoEnv();
  const res = await e.run(selectSlots([tempoTarget("a"), tempoTarget("b")], 1).slots, DATE);
  assert.equal(e.signs(), 1);
  assert.equal(res.rows.length, 1);
  const r = res.rows[0]!;
  assert.deepEqual([r.outcome, r.settled, r.delivered, r.priceUsdc, r.service, r.bodyBytes, r.key], ["sent", true, true, "0.006000", "a", 11, `${DATE}|${SELLER.toLowerCase()}|0`]);
  assert.equal(normalizeRemeasure(fileOf("tempo", [r]), "x")[0]!.category, "delivered");
});

test("tempo: a changed recipient is refused before signing and recorded as pay_to_changed", async () => {
  const e = tempoEnv({ liveFor: () => ({ recipient: OTHER, amount: "6000" }) });
  const ledger = e.dayLedger(DATE);
  const res = await e.run(selectSlots([tempoTarget("a")], 1).slots, DATE, ledger);
  assert.equal(e.signs(), 0);
  assert.equal(ledger.committed(), 0n);
  const r = res.rows[0]!;
  assert.deepEqual([r.outcome, r.reason, r.payTo, r.expectedPayTo], ["refused", "pay_to_changed", OTHER.toLowerCase(), SELLER.toLowerCase()]);
  const d = await dryRunTempo(selectSlots([tempoTarget("a")], 1).slots, e.fetchImpl, { date: DATE, monthElsewhere: 0n, monthCommittedToday: 0n });
  assert.deepEqual([d.rows[0]!.reason, d.rows[0]!.payTo], ["pay_to_changed", OTHER.toLowerCase()]);
});

test("tempo: run (day ledger) cap and month cap stop before signing, at the boundary; the month is bound by the chain too", async () => {
  // run cap: 1 USDC.e incl. 0.002 fee reserve each. 98,000 + 2,000 = 100,000 per purchase -> 10 fit, the 11th does not.
  const targets = Array.from({ length: 11 }, (_, i) => tempoTarget(`s${i}`, "98000", `0x${(i + 1).toString(16).padStart(40, "a")}`));
  const liveFor = (url: string) => ({ recipient: targets.find((t) => t.requestUrl === url)!.payTo, amount: "98000" });
  const e = tempoEnv({ liveFor });
  const ledger = e.dayLedger(DATE);
  const res = await e.run(selectSlots(targets, 1).slots, DATE, ledger);
  assert.equal(e.signs(), 10);
  assert.equal(ledger.committed(), RM_TEMPO_MAX_PER_RUN_ATOMIC);
  assert.match(res.stopped!, /^total_cap_reached: run\/day 1000000 \+ 100000 > 1000000/);

  // month cap from the ledgers: the month's other day ledgers hold 29.9 USDC.e -> exactly one 0.1 fits
  const e2 = tempoEnv({ liveFor });
  const r2 = await e2.run(selectSlots(targets.slice(0, 2), 1).slots, DATE, e2.dayLedger(DATE), 29_900_000n);
  assert.equal(e2.signs(), 1);
  assert.match(r2.stopped!, /^month_cap_reached: 30000000 /);

  // month cap from the chain: no ledger shows it (files lost), but 29.900001 USDC.e left the key this month. The
  // chain bounds the month all the same, but the stop is money outside the ledgers, not the month's end.
  const e3 = tempoEnv({ liveFor });
  e3.chain.month = 29_900_001n;
  const r3 = await e3.run(selectSlots(targets.slice(0, 2), 1).slots, DATE);
  assert.equal(e3.signs(), 0);
  assert.match(r3.stopped!, /^chain_spend_exceeds_ledger: month outflow on chain 29900001 > ledgers 0; 29900001 \+ 100000 > 30000000/);
});

test("tempo: at the month cap, ledgers that account for the chain's outflow (chain <= ledgers) are the month's end; chain above the ledgers is chain_spend_exceeds_ledger, which the runner halts on", async () => {
  const targets = Array.from({ length: 2 }, (_, i) => tempoTarget(`m${i}`, "98000", `0x${(i + 1).toString(16).padStart(40, "b")}`));
  const liveFor = (url: string) => ({ recipient: targets.find((t) => t.requestUrl === url)!.payTo, amount: "98000" });
  // ledgers 29.95, chain 29.95 (and chain 29.90, below them): the month cap proper
  for (const chain of [29_950_000n, 29_900_000n]) {
    const e = tempoEnv({ liveFor });
    e.chain.month = chain;
    const r = await e.run(selectSlots(targets, 1).slots, DATE, e.dayLedger(DATE), 29_950_000n);
    assert.equal(e.signs(), 0);
    assert.match(r.stopped!, /^month_cap_reached: 29950000 \(ledgers 29950000, chain \d+\) \+ 100000 > 30000000/);
    assert.equal(isMonthCapStop(r.stopped), true);
  }
  // ledgers 29.95, chain 29.950001: one atomic unit left the key outside the ledgers
  const e = tempoEnv({ liveFor });
  e.chain.month = 29_950_001n;
  const r = await e.run(selectSlots(targets, 1).slots, DATE, e.dayLedger(DATE), 29_950_000n);
  assert.equal(e.signs(), 0);
  assert.match(r.stopped!, /^chain_spend_exceeds_ledger: month outflow on chain 29950001 > ledgers 29950000/);
  assert.equal(isMonthCapStop(r.stopped), false, "not an end: the runner halts");
  assert.equal(runOutcome({ runs: [{ startedAt: "2026-10-13T01:17:41.000Z", endedAt: "2026-10-13T01:20:00.000Z", stopped: r.stopped, perPayTo: 1 }], rows: [] }, "2026-10-13T01:17:40.000Z").ok, false);
});

test("tempo B1: deleting the day ledger does not reopen the budget; no second signature", async () => {
  const e = tempoEnv();
  const slots = selectSlots([tempoTarget("a")], 1).slots;
  await e.run(slots, DATE);
  assert.equal(e.signs(), 1);
  // the day ledger is deleted: the index still lists it, so the run refuses to open the day again
  rmSync(dayLedgerPath(e.set.remeasureDir, DATE));
  await assert.rejects(e.run(slots, DATE), /listed in .* but missing/);
  assert.equal(e.signs(), 1);
  // the index is deleted too: the chain check alone stops it (6,030 left the key, no ledger accounts for it)
  rmSync(join(e.set.remeasureDir, DAY_LEDGER_INDEX));
  const again = await e.run(slots, DATE);
  assert.equal(e.signs(), 1);
  assert.equal(again.rows[0]!.reason, "chain_spend_exceeds_ledger");
  assert.equal(again.stopped, "chain_spend_exceeds_ledger");
  // the census slack (19,000 reserved, 10,030 left) is not room: reservations of other ledgers do not hide the loss
  assert.equal(new Ledger(e.set.census, throwaway.address, 2_500_000n).committed(), 19_000n);
});

test("tempo B1: deleting a past day ledger stops the next day's run before signing", async () => {
  const e = tempoEnv();
  const slots = selectSlots([tempoTarget("a")], 1).slots;
  await e.run(slots, "2026-10-01");
  await e.run(slots, "2026-10-02");
  assert.equal(e.signs(), 2);
  rmSync(dayLedgerPath(e.set.remeasureDir, "2026-10-01"));
  const r = await e.run(slots, "2026-10-03");
  assert.equal(e.signs(), 2);
  assert.match(r.stopped!, /^key_ledger_missing: .*2026-10-01/);
  // the census check sees it too: its chainSpent throws before payOne reserves or signs
  const censusCheck = unaccountedChainSpent(e.set.census, e.view.outflowSinceCensusStart, throwaway.address, e.set);
  await assert.rejects(censusCheck(), /missing: 2026-10-01/);
});

test("tempo Q3: a small past day hidden by this ledger's unused fee reserves is still caught by the index", async () => {
  // day 1: one purchase of 0.0001 (130 left the key). Day 2: two purchases reserve 2 x 2,000 fee but pay 2 x 30,
  // so the day-2 ledger has 3,940 of room: the chain check alone would not notice day 1 missing.
  const e = tempoEnv({ liveFor: (url) => ({ recipient: url.endsWith("/tiny") ? OTHER : SELLER, amount: url.endsWith("/tiny") ? "100" : "6000" }) });
  await e.run([{ target: tempoTarget("tiny", "100", OTHER), slot: 0 }], "2026-10-01");
  const day2 = e.dayLedger("2026-10-02");
  await e.run([{ target: tempoTarget("a"), slot: 0 }, { target: tempoTarget("b"), slot: 1 }], "2026-10-02", day2);
  assert.equal(e.signs(), 3);
  rmSync(dayLedgerPath(e.set.remeasureDir, "2026-10-01"));
  const own = unaccountedChainSpent(dayLedgerPath(e.set.remeasureDir, "2026-10-02"), e.view.outflowSinceCensusStart, throwaway.address, {
    ...e.set,
    remeasureDir: e.set.remeasureDir,
  });
  await assert.rejects(own(), /missing: 2026-10-01/);
  // what the chain check alone would have said: 12,190 unaccounted <= 16,000 committed (hidden)
  assert.equal(e.chain.total - 10_030n, 130n + 6_030n * 2n);
  assert.ok(e.chain.total - 10_030n <= day2.committed());
  const r = await e.run([{ target: tempoTarget("a"), slot: 2 }], "2026-10-02", day2);
  assert.equal(e.signs(), 3);
  assert.match(r.stopped!, /^key_ledger_missing/);
});

test("tempo Q2: another ledger's reservation that was never signed counts as 0, so it cannot hide a lost ledger", async () => {
  const e = tempoEnv();
  const slots = selectSlots([tempoTarget("a")], 1).slots;
  await e.run(slots, DATE);
  assert.equal(e.signs(), 1);
  // the census run crashed after reserving 6,000 + 2,000 and before signing: nothing left the key for it
  const c = new Ledger(e.set.census, throwaway.address, 2_500_000n);
  c.reserve({ key: "crashed", url: "u3", recipient: SELLER, amount: 6_000n, sponsored: false });
  assert.equal(entryOutflow(c.entries().at(-1)!), 0n);
  // remeasure's day ledger and its index are both lost: only the chain check is left, and it holds
  rmSync(dayLedgerPath(e.set.remeasureDir, DATE));
  rmSync(join(e.set.remeasureDir, DAY_LEDGER_INDEX));
  const again = await e.run(slots, DATE);
  assert.equal(e.signs(), 1);
  assert.equal(again.stopped, "chain_spend_exceeds_ledger");
});

test("tempo Q1: a census --pay ledger other than the key's census ledger is refused", async () => {
  // reproduce: an empty ledger elsewhere, with the real census ledger counted as "another ledger", passes
  const e = tempoEnv({ liveFor: () => ({ recipient: SELLER, amount: "50000" }) });
  await e.run(selectSlots([tempoTarget("a", "50000")], 1).slots, DATE);
  const elsewhere = join(tmp(), "tempo-ledger.json");
  const censusAccounted = accountedOutflow(e.set.census, throwaway.address);
  const dayAccounted = accountedOutflow(dayLedgerPath(e.set.remeasureDir, DATE), throwaway.address);
  assert.equal(e.chain.total - censusAccounted - dayAccounted, 0n); // what the old wiring gave the empty ledger: room for a second census
  // the fix: such a ledger is not a ledger of this key
  assert.throws(() => assertCensusLedger(elsewhere, e.set), /would count it as another ledger/);
  assert.throws(() => unaccountedChainSpent(elsewhere, e.view.outflowSinceCensusStart, throwaway.address, e.set), /not a ledger of this key/);
  assert.doesNotThrow(() => assertCensusLedger(e.set.census, e.set));
  // the script: --pay with the default ledger of this checkout, or any other --ledger, exits 2 before reading the plan or the key
  const script = join(import.meta.dirname, "..", "scripts", "tempo-census.ts");
  for (const extra of [[], ["--ledger", elsewhere]]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--pay", "--plan", "/nonexistent", ...extra], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /would count it as another ledger/);
  }
});

test("tempo B1: the census check still passes after remeasure pays from the same key", async () => {
  const e = tempoEnv({ liveFor: () => ({ recipient: SELLER, amount: "50000" }) });
  await e.run(selectSlots([tempoTarget("a", "50000")], 1).slots, DATE);
  assert.equal(e.signs(), 1);
  // on chain now: 10,030 (census) + 50,030 (remeasure) = 60,060 > the census ledger's 19,000
  assert.equal(e.chain.total, 60_060n);
  const census = new Ledger(e.set.census, throwaway.address, 2_500_000n);
  const entry = { ...tempoTarget("next", "50000").tempo!.plan, serviceId: "next" };
  const shared = unaccountedChainSpent(e.set.census, e.view.outflowSinceCensusStart, throwaway.address, e.set);
  assert.equal(await shared(), 10_030n);
  const o = await tempoPayOne(entry, { ...e.pay, ledger: census, chainSpent: shared });
  assert.equal(o.result, "sent");
  assert.equal(e.signs(), 2);
  // the old census wiring (all outflow since the census start against the census ledger alone) stops here
  const old = await tempoPayOne({ ...entry, serviceId: "next2" }, { ...e.pay, ledger: census, chainSpent: e.view.outflowSinceCensusStart });
  assert.equal(old.refusal?.refused, "chain_spend_exceeds_ledger");
});

test("tempo B1: other ledgers count what left the key; on the census ledger this equals the chain (read 2026-09-29)", () => {
  const l = read("tempo/ledger.json") as { entries: LedgerEntry[] };
  assert.equal(l.entries.reduce((s, x) => s + entryOutflow(x), 0n), 1_570_786n);
});

test("tempo W2: the same-day key is the payTo, not the service", async () => {
  const e = tempoEnv();
  await e.run([{ target: tempoTarget("a"), slot: 0 }], DATE);
  const r = await e.run([{ target: tempoTarget("b"), slot: 0 }], DATE);
  assert.equal(e.signs(), 1);
  assert.equal(r.rows[0]!.reason, "already_bought");
  // another day: allowed
  await e.run([{ target: tempoTarget("b"), slot: 0 }], "2026-10-02");
  assert.equal(e.signs(), 2);
});

test("tempo W3: a purchase in the ledger without a result row becomes unknown_after_sign, and is not paid again", async () => {
  const e = tempoEnv();
  const t = tempoTarget("a");
  const key = budgetKey(DATE, t.payTo, 0);
  // a run was killed after the credential left: ledger says sent, the chain moved, no result file
  const l = e.dayLedger(DATE);
  l.reserve({ key, url: t.requestUrl, recipient: t.payTo, amount: 6_000n, sponsored: false });
  l.update(key, { status: "sent" });
  e.chain.total += 6_030n;
  const added = reconcileTempo(e.set.remeasureDir, [t], throwaway.address);
  assert.deepEqual(added.map((r) => [r.outcome, r.key, r.service]), [["unknown_after_sign", key, "a"]]);
  const f = JSON.parse(readFileSync(join(e.set.remeasureDir, `tempo-${DATE}.json`), "utf8")) as ResultFile;
  assert.equal(f.rows.length, 1);
  const again = await e.run([{ target: t, slot: 0 }], DATE);
  assert.equal(e.signs(), 0);
  assert.equal(again.rows[0]!.reason, "already_bought");
  assert.equal(reconcileTempo(e.set.remeasureDir, [t], throwaway.address).length, 0);
  const a = normalizeRemeasure(f, "remeasure/tempo")[0]!;
  assert.deepEqual([a.category, a.tried, a.rawReason], ["unconfirmed_server_error", true, "unknown_after_sign"]);
});

test("solana W3: a reservation without a result row becomes unknown_after_sign, and is not paid again", async () => {
  const dir = tmp();
  const file = join(dir, "budget-solana-2026-10.json");
  const key = budgetKey(DATE, P1, 0);
  writeFileSync(file, JSON.stringify({ baselineAtomic: null, spentAtomic: "10000", purchases: [{ key, amount: "10000", at: "2026-10-01T01:00:00.000Z" }] }));
  const t = solTarget("a.example", P1);
  const added = reconcileSolana(file, dir, [t], PAYER_ADDRESS);
  assert.deepEqual(added.map((r) => [r.outcome, r.key, r.host, r.priceUsdc]), [["unknown_after_sign", key, "a.example", "0.010000"]]);
  assert.equal(reconcileSolana(file, dir, [t], PAYER_ADDRESS).length, 0);
  const ft = fakeTime();
  const w = solWorld({ "a.example": { payTo: P1, amount: "10000" } }, ft.clock);
  const r = await paySolana([{ target: t, slot: 0 }], w.pay, { date: DATE, budget: new RemeasureBudget(file), now: ft.now, sleep: ft.sleep, pacer: ft.pacer() });
  assert.equal(w.signs.length, 0);
  assert.equal(r.rows[0]!.reason, "already_bought");
});

test("W1: --pay keeps ledgers only in the production folder and refuses --out", () => {
  assert.throws(() => runDirs({ pay: true, out: "/tmp/x", root: "/r" }), /--out is not accepted with --pay/);
  assert.equal(runDirs({ pay: true, out: undefined, root: "/r" }).ledgers, RM_PROD_DIR);
  assert.deepEqual(runDirs({ pay: false, out: "/tmp/x", root: "/r" }), { ledgers: RM_PROD_DIR, dryRunOut: "/tmp/x" });
  assert.equal(RM_PROD_DIR, join(homedir(), "vet402-solana", "results", "remeasure"));
  assert.equal(TEMPO_KEY_LEDGERS.remeasureDir, RM_PROD_DIR);
  const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "remeasure.ts"), "--chain", "tempo", "--pay", "--out", tmp()], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out is not accepted with --pay/);
});

test("tempo: month ledgers are summed; the month's first block is found by block time", async () => {
  const dir = tmp();
  for (const [d, amt] of [["2026-10-01", 50_000n], ["2026-10-02", 70_000n], ["2026-09-30", 999_000n]] as const) {
    const l = new Ledger(dayLedgerPath(dir, d), "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51", RM_TEMPO_MAX_PER_RUN_ATOMIC);
    l.reserve({ key: "k", url: "u", recipient: SELLER, amount: amt, sponsored: true });
  }
  assert.equal(monthCommittedElsewhere(dir, "2026-10", "2026-10-02"), 50_000n);
  assert.equal(monthCommittedElsewhere(dir, "2026-10", "2026-10-03"), 120_000n);
  const ts = async (b: bigint) => b * 10n; // block n at time 10n
  assert.equal(await firstBlockAtOrAfter(1_000n, 5n, 500n, ts), 100n);
  assert.equal(await firstBlockAtOrAfter(1_001n, 5n, 500n, ts), 101n);
  assert.equal(await firstBlockAtOrAfter(10n, 5n, 500n, ts), 5n);
});

// ---------- rank reads remeasure files as more days ----------

function fileOf(chain: "solana" | "tempo", rows: RemeasureRow[], date = DATE): ResultFile {
  return { kind: "vet402-remeasure", version: 1, chain, date, payer: "p", note: "n", runs: [], rows };
}

function earlier(host: string, i: number): Attempt {
  return {
    chain: "solana", source: "solana/census-2026-09-28", host, service: null, url: `https://${host}/x`, payTo: P1, expectedPayTo: null,
    at: `2026-09-28T0${i % 10}:00:00.000Z`, tried: true, settled: true, delivered: true, category: "delivered", rawReason: "delivered",
    detail: null, tx: SIG, priceUsdc: "0.010000", httpStatus: 200, declaredMatch: null, bodyChecked: true, feedbackTx: null,
  };
}

function remeasureRow(host: string, over: Partial<RemeasureRow> = {}): RemeasureRow {
  return {
    at: "2026-09-30T10:00:00.000Z", chain: "solana", host, service: null, url: `https://${host}/x`, requestUrl: `https://${host}/x`,
    payTo: P1, expectedPayTo: P1, outcome: "sent", reason: "sent", detail: "{}", settled: true, delivered: true, httpStatus: 200,
    bodyBytes: null, tx: SIG, priceUsdc: "0.010000", slot: 0, key: `2026-09-30|${P1}|0`, ...over,
  };
}

test("rank: a remeasure file on a second day turns measuring sellers into ranked ones", () => {
  // two sellers with 10 counted purchases, all on 2026-09-28: enough purchases, one day -> measuring
  const day1 = [...Array.from({ length: 10 }, (_, i) => earlier("a.example", i)), ...Array.from({ length: 10 }, (_, i) => earlier("b.example", i))];
  const before = rank(aggregate(day1));
  assert.equal(before.filter((s) => s.rank !== null).length, 0);
  // one remeasure purchase each on 2026-09-30 (a seller-side failure for b still counts, and still makes a day)
  const day2 = normalizeRemeasure(
    fileOf("solana", [remeasureRow("a.example"), remeasureRow("b.example", { delivered: false, httpStatus: 500, detail: "boom" })], "2026-09-30"),
    "remeasure/solana-2026-09-30",
  );
  const after = rank(aggregate([...day1, ...day2]));
  const ranked = after.filter((s) => s.rank !== null);
  assert.equal(ranked.length, 2);
  assert.deepEqual(after.find((s) => s.key === "a.example")!.days, ["2026-09-28", "2026-09-30"]);
  assert.equal(after.find((s) => s.key === "b.example")!.counted, 11);
  // a remeasure row the rank cannot count (payTo changed) adds no day
  const changed = normalizeRemeasure(fileOf("solana", [remeasureRow("a.example", { outcome: "refused", reason: "pay_to_changed", payTo: OTHER_SOL, settled: null, delivered: null, tx: null })]), "x");
  assert.equal(rank(aggregate([...day1, ...changed])).filter((s) => s.rank !== null).length, 0);
});

test("rank: Tempo remeasure rows join the host#service seller and use the body length", () => {
  const rows = normalizeRemeasure(
    fileOf("tempo", [
      remeasureRow("svc.example", { chain: "tempo", service: "a", bodyBytes: 0 }),
      remeasureRow("svc.example", { chain: "tempo", service: "b", bodyBytes: null }),
      remeasureRow("svc.example", { chain: "tempo", service: "c", outcome: "unknown", reason: "unknown", settled: null, delivered: null, detail: "The operation was aborted due to timeout" }),
    ]),
    "remeasure/tempo-2026-10-01",
  );
  assert.deepEqual(rows.map((r) => [r.category, r.bodyChecked]), [["settled_empty_body", true], ["delivered", false], ["unconfirmed_server_error", true]]);
  const keys = aggregate(rows).map((s) => s.key).sort();
  assert.deepEqual(keys, ["svc.example#a", "svc.example#b", "svc.example#c"]);
});

test("rank input: unknown refusal words and dry-run rows are refused loudly", () => {
  assert.throws(() => normalizeRemeasure(fileOf("solana", [remeasureRow("a.example", { outcome: "refused", reason: "made_up" })]), "x"), /unknown remeasure refusal/);
  assert.throws(() => normalizeRemeasure(fileOf("solana", [remeasureRow("a.example", { outcome: "would_pay", reason: "would_pay" })]), "x"), /does not belong/);
  assert.throws(() => normalizeRemeasure({ kind: "other" }, "x"), /expected a vet402-remeasure/);
});

test("rank input: only <chain>-YYYY-MM-DD.json up to the report date, oldest first", () => {
  const dir = tmp();
  for (const n of ["solana-2026-09-30.json", "tempo-2026-09-30.json", "solana-2026-10-01.json", "solana-2026-10-02.json", "solana-2026-10-01.dry-run.json", "tempo-ledger-2026-10-01.json", "budget-solana-2026-10.json"]) {
    writeFileSync(join(dir, n), "{}");
  }
  assert.deepEqual(resultFilesUpTo(dir, "2026-10-01").map((f) => f.name), ["solana-2026-09-30.json", "tempo-2026-09-30.json", "solana-2026-10-01.json"]);
  assert.deepEqual(resultFilesUpTo(join(dir, "missing"), "2026-10-01"), []);
});

test("tempo W1: a missing index next to existing day ledgers is refused before the index is rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-idx-"));
  try {
    const set = { ...TEMPO_KEY_LEDGERS, remeasureDir: dir };
    writeFileSync(join(dir, "tempo-ledger-2026-10-01.json"), JSON.stringify({ version: 1, payer: "0x0", capAtomic: "1000000", entries: [] }));
    assert.throws(() => registerDayLedger(set, "2026-10-02", "0x0", 1_000_000n), /is missing but day ledgers exist/);
    assert.equal(existsSync(join(dir, "tempo-ledger-index.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tempo 2026-10-01: an unknown outcome the chain check found paid counts as a rebuy purchase, never as the seller's failure", () => {
  const SELLER_T = "0xbb06ad903e615cc1a50421b60d70e47b11a5677f";
  const base = { at: "2026-10-01T01:34:09.506Z", chain: "tempo" as const, host: "mpp.t.example", service: "s", url: "https://mpp.t.example/s", requestUrl: "https://mpp.t.example/s", payTo: null, expectedPayTo: SELLER_T, priceUsdc: "0.100000", slot: 0, httpStatus: null, bodyBytes: null, answer: null, delivered: null };
  const found = { ...base, key: `2026-10-01|${SELLER_T}|0`, outcome: "unknown", reason: "unknown", detail: "The operation was aborted due to timeout; settled on chain (found by the post-run chain check)", settled: true, tx: "0x5a8d" } as unknown as RemeasureRow;
  const lost = { ...base, key: `2026-10-01|${SELLER_T}|1`, outcome: "unknown", reason: "unknown", detail: "The operation was aborted due to timeout", settled: null, tx: null } as unknown as RemeasureRow;
  const [a, b] = normalizeRemeasure(fileOf("tempo", [found, lost], "2026-10-01"), "remeasure/tempo-2026-10-01");
  assert.deepEqual([a!.category, a!.settled, a!.paidOnChain, a!.tx], ["unconfirmed_server_error", null, true, "0x5a8d"]);
  assert.deepEqual([b!.category, b!.settled, "paidOnChain" in b!], ["unconfirmed_server_error", null, false]);
  const s = aggregate([a!, b!])[0]!;
  assert.deepEqual(s.rebuy, { days: ["2026-10-01"], purchases: { tempo: 1 } });
  assert.equal(s.paidButNotDelivered, 0);
  assert.equal(s.lastFailure, null);
});

test("2026-10-01: the daily rebuy waits 180 s for a paid answer on both chains; proxy-buy keeps the 90 s default", async () => {
  const { RM_PAID_TIMEOUT_MS } = await import("../src/remeasure/constants.js");
  assert.equal(RM_PAID_TIMEOUT_MS, 180_000);
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  for (const p of ["remeasure/solana.ts", "remeasure/tempo.ts"]) assert.match(src(p), /payOne\(.*paidTimeoutMs: pay\.paidTimeoutMs \?\? RM_PAID_TIMEOUT_MS/, p);
  assert.match(src("pay.ts"), /AbortSignal\.timeout\(deps\.paidTimeoutMs \?\? 90_000\)/);
  assert.match(src("tempo/pay.ts"), /AbortSignal\.timeout\(deps\.paidTimeoutMs \?\? PAID_TIMEOUT_MS\)/);
  for (const p of ["proxy-buy/solana.ts", "proxy-buy/tempo.ts"]) assert.doesNotMatch(src(p), /paidTimeoutMs|RM_PAID_TIMEOUT_MS/, p);
});
