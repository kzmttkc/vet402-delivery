import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planVerdict } from "../src/daily/steps.js";
import KeetaNet from "@keetanetwork/keetanet-client";
import { encodePaymentResponseHeader } from "@x402/core/http";
import {
  KeetaBudget,
  isKeetaMonthCapRefusal,
  isKeetaRunCapRefusal,
  keetaBudgetKey,
  normalizeKeetaPurchaseUrl,
} from "../src/keeta/budget.js";
import { keetaCandidatesFromCatalog, normalizeKeetaAccept, parseKeeta402, pickKeetaAccept } from "../src/keeta/challenge.js";
import {
  KEETA_CAIP2,
  KEETA_TESTNET_CAIP2,
  KEETA_MAX_PER_PURCHASE_ATOMIC,
  KEETA_MAX_PER_RUN_ATOMIC,
  KEETA_MAX_PER_MONTH_ATOMIC,
  KEETA_MAX_PURCHASES_PER_MONTH,
  KEETA_MAX_PURCHASES_PER_RUN,
  KEETA_SELLERS,
  KEETA_USDC,
  keetaLockPath,
  keetaSellerMaxPerRun,
} from "../src/keeta/constants.js";
import { writeKeetaKey } from "../src/keeta/keygen.js";
import { fenceKeetaSigner, loadKeetaAccount, makeKeetaCreatePayment } from "../src/keeta/sign.js";
import { KEETA_VERIFY_TRIES, publicKeetaReader, readKeetaUsdcBalance, verifyKeetaPayment, withKeetaTimeout, type KeetaLedgerReader } from "../src/keeta/ledger.js";
import type { ClientKeetaSigner } from "@x402/keeta";
import { fetchCatalog } from "../src/keeta/catalog.js";
import { probePayable } from "../src/keeta/probe.js";
import {
  buyKeetaOne,
  emptyKeetaResult,
  readKeetaPayPlan,
  readKeetaResultFile,
  type KeetaBuyDeps,
  type KeetaResultFile,
} from "../src/keeta/buy.js";
import { buildKeetaPlan } from "../src/keeta/plan.js";
import { runKeetaPayRun } from "../src/keeta/pay-run.js";
import { acquireRunLock } from "../src/first-buyer/lock.js";
import { PayloadNotCreatedError } from "../src/guard.js";

const ROOT = join(import.meta.dirname, "..");
const FIX = join(ROOT, "test", "fixtures", "keeta");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

const pulse = JSON.parse(readFileSync(join(FIX, "keespecs-pulse-402.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(FIX, "keespecs-catalog.json"), "utf8"));
const ktaCatalog = JSON.parse(readFileSync(join(FIX, "kta-oracle-catalog.json"), "utf8"));
const probe = JSON.parse(readFileSync(join(FIX, "keespecs-probe-2026-11-15.json"), "utf8"));

const PAYTO = KEETA_SELLERS[0]!.payTo;
const KTA_ORACLE = KEETA_SELLERS[1]!;
const KTA_PAYTO = KTA_ORACLE.payTo;
const lock = { payTo: PAYTO, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC };

test("keeta: the real keespecs 402 (fixture) parses to one exact accept on keeta:21378 for 0.01 USDC to the pinned payTo", () => {
  const h = pulse.headers as Record<string, string>;
  const prH = parseKeeta402((n) => (n.toLowerCase() === "payment-required" ? (h["payment-required"] ?? null) : (h[n] ?? null)), undefined);
  const prB = parseKeeta402(() => null, pulse.body);
  for (const pr of [prH, prB]) {
    const accepts = (pr.accepts as unknown as Record<string, unknown>[]).map(normalizeKeetaAccept);
    assert.equal(accepts.length, 1);
    const picked = pickKeetaAccept(accepts, lock);
    assert.ok("accept" in picked);
    assert.equal(picked.accept.network, KEETA_CAIP2);
    assert.equal(picked.accept.amount, "10000");
    assert.equal(picked.accept.payTo, PAYTO);
    assert.equal(picked.accept.asset, KEETA_USDC);
  }
});

test("keeta: pickKeetaAccept chooses Keeta USDC, not KTA, when both are listed", () => {
  const ktaAsset = "keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg";
  const accepts = [
    normalizeKeetaAccept({
      scheme: "exact",
      network: KEETA_CAIP2,
      amount: "1000000000000000",
      asset: ktaAsset,
      payTo: KTA_PAYTO,
    }),
    normalizeKeetaAccept({
      scheme: "exact",
      network: KEETA_CAIP2,
      amount: "1000",
      asset: KEETA_USDC,
      payTo: KTA_PAYTO,
    }),
  ];
  const picked = pickKeetaAccept(accepts, { payTo: KTA_PAYTO, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC });
  assert.ok("accept" in picked);
  assert.equal(picked.accept.asset, KEETA_USDC);
  assert.equal(picked.accept.amount, "1000");
});

test("keeta: kta-oracle catalog yields GET routes with USDC accepts only", () => {
  const routes = keetaCandidatesFromCatalog(ktaCatalog, KTA_ORACLE);
  assert.ok(routes.length >= 3);
  for (const r of routes) assert.equal(new URL(r.url).host, "kta-oracle.top");
  assert.equal(routes[0]!.accept.asset, KEETA_USDC);
});

test("keeta: keetaSellerMaxPerRun keeps 12 + 3 = 15 across sellers", () => {
  assert.equal(keetaSellerMaxPerRun(KEETA_SELLERS[0]!), 12);
  assert.equal(keetaSellerMaxPerRun(KTA_ORACLE), 3);
  assert.equal(keetaSellerMaxPerRun(KEETA_SELLERS[0]!) + keetaSellerMaxPerRun(KTA_ORACLE), KEETA_MAX_PURCHASES_PER_RUN);
});

test("keeta: a testnet accept (keeta:1413829460), another asset, another payTo, a bad amount and a price over the cap are refused before any signer is touched", async () => {
  const cases: { a: Record<string, unknown>; want: string }[] = [
    { a: { scheme: "permit", network: KEETA_CAIP2, amount: "10000", asset: KEETA_USDC, payTo: PAYTO }, want: "scheme_mismatch" },
    { a: { scheme: "exact", network: "keeta:1413829460", amount: "10000", asset: KEETA_USDC, payTo: PAYTO }, want: "testnet_chain" },
    { a: { scheme: "exact", network: KEETA_CAIP2, amount: "10000", asset: "keeta_other", payTo: PAYTO }, want: "mint_mismatch" },
    { a: { scheme: "exact", network: KEETA_CAIP2, amount: "10000", asset: KEETA_USDC, payTo: "keeta_other" }, want: "payto_mismatch" },
    { a: { scheme: "exact", network: KEETA_CAIP2, amount: "0", asset: KEETA_USDC, payTo: PAYTO }, want: "bad_amount" },
    { a: { scheme: "exact", network: KEETA_CAIP2, amount: "010000", asset: KEETA_USDC, payTo: PAYTO }, want: "bad_amount" },
    { a: { scheme: "exact", network: KEETA_CAIP2, amount: "25000", asset: KEETA_USDC, payTo: PAYTO }, want: "price_over_cap" },
  ];
  for (const c of cases) {
    const r = pickKeetaAccept([normalizeKeetaAccept(c.a)], lock);
    assert.ok("refused" in r, JSON.stringify(c.a));
    assert.equal(r.refused, c.want);
  }
  const testnetAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_TESTNET_CAIP2,
    amount: "10000",
    asset: KEETA_USDC,
    payTo: PAYTO,
  });
  const mainnetLock = { payTo: PAYTO, amount: "10000", asset: KEETA_USDC, network: KEETA_CAIP2, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC };
  const inner: ClientKeetaSigner = {
    async computePaymentBlock() {
      throw new Error("should not sign");
    },
    destroy: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
  const fenced = fenceKeetaSigner(inner, mainnetLock);
  await assert.rejects(
  () =>
      fenced.computePaymentBlock(
        testnetAccept.network as never,
        { publicKeyString: PAYTO } as never,
        10_000n,
        { publicKeyString: KEETA_USDC } as never,
      ),
    /network/,
  );
});

test("keeta: the catalog fixture gives GET routes on keespecs.xyz only (no POST, no other host), and the probe fixture leaves 15 payable routes for 0.17 USDC", () => {
  const seller = KEETA_SELLERS[0]!;
  const routes = keetaCandidatesFromCatalog(catalog.body, seller);
  for (const r of routes) assert.equal(new URL(r.url).host, "keespecs.xyz");
  const methods = (catalog.body.resources as { method?: string; url: string }[]).filter((x) => (x.method ?? "GET").toUpperCase() === "POST");
  assert.ok(methods.length >= 1);
  const payable = (probe.rows as { url: string; status: number }[]).filter((x) => x.status === 402);
  assert.equal(payable.length, 15);
  const urls = new Set(routes.map((r) => r.url));
  let sum = 0n;
  for (const p of payable) {
    assert.ok(urls.has(p.url), p.url);
    const cat = (catalog.body.resources as { url: string; accepts: { amount: string }[] }[]).find((x) => x.url === p.url);
    sum += BigInt(cat!.accepts[0]!.amount);
  }
  assert.equal(sum, 170_000n);
});

test("keeta: KeetaBudget refuses over the per-purchase cap, the run cap, the run count and the month cap, and the same URL twice on one UTC day", () => {
  const b = new KeetaBudget(null);
  const day = "2026-11-15";
  const url = "https://keespecs.xyz/api/pulse";
  const key = keetaBudgetKey(day, url);
  assert.ok("refused" in b.reserve(25_000n, key, null));
  const ok = b.reserve(10_000n, key, null);
  assert.ok("ok" in ok);
  b.commit(ok.id);
  assert.ok("refused" in b.reserve(10_000n, key, null));
  const b2 = new KeetaBudget(null, 10_000n, 1);
  const k2 = keetaBudgetKey(day, "https://keespecs.xyz/api/status");
  const r1 = b2.reserve(10_000n, k2, null);
  assert.ok("ok" in r1);
  b2.commit(r1.id);
  assert.ok("refused" in b2.reserve(1n, keetaBudgetKey(day, "https://keespecs.xyz/api/prices"), null));
  const monthDir = mkdtempSync(join(tmpdir(), "keeta-budget-"));
  const monthFile = join(monthDir, "m.json");
  writeFileSync(monthFile, JSON.stringify({ baselineAtomic: null, spentAtomic: KEETA_MAX_PER_MONTH_ATOMIC.toString(), purchases: [] }) + "\n");
  const month = new KeetaBudget(monthFile);
  assert.ok("refused" in month.reserve(1n, keetaBudgetKey(day, "https://keespecs.xyz/api/a"), null));
  rmSync(monthDir, { recursive: true });
});

test("keeta: setBaselineIfMissing records the payer balance on the month ledger before reserve", () => {
  const day = "2026-11-15";
  const dir = mkdtempSync(join(tmpdir(), "keeta-base-"));
  const file = join(dir, "b.json");
  const b = new KeetaBudget(file, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, day);
  b.setBaselineIfMissing(100_000n);
  const state = JSON.parse(readFileSync(file, "utf8")) as { baselineAtomic?: string };
  assert.equal(state.baselineAtomic, "100000");
  rmSync(dir, { recursive: true });
});

test("keeta: KeetaBudget month purchase_count_reached is not a run-cap detail", () => {
  const day = "2026-11-15";
  const dir = mkdtempSync(join(tmpdir(), "keeta-monthcnt-"));
  const file = join(dir, "m.json");
  const purchases = Array.from({ length: KEETA_MAX_PURCHASES_PER_MONTH }, (_, i) => ({
    key: `2026-10-0${(i % 9) + 1}|https://keespecs.xyz/api/r${i}`,
    amount: "1",
    at: "2026-10-01T00:00:00.000Z",
  }));
  writeFileSync(file, JSON.stringify({ baselineAtomic: "0", spentAtomic: purchases.length.toString(), purchases }) + "\n");
  const b = new KeetaBudget(file, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, day);
  const r = b.reserve(10_000n, keetaBudgetKey(day, "https://keespecs.xyz/api/new"), null);
  assert.ok("refused" in r);
  assert.equal(r.refused, "purchase_count_reached");
  assert.ok(!r.detail?.startsWith("run:"));
  rmSync(dir, { recursive: true });
});

test("keeta: KeetaBudget seeds the UTC day run cap from committed purchases in the month ledger", () => {
  const day = "2026-11-15";
  const dir = mkdtempSync(join(tmpdir(), "keeta-daycap-"));
  const file = join(dir, "budget.json");
  const url = "https://keespecs.xyz/api/pulse";
  const spent = KEETA_MAX_PER_RUN_ATOMIC - 5_000n;
  writeFileSync(
    file,
    JSON.stringify({
      baselineAtomic: "1000000",
      spentAtomic: spent.toString(),
      purchases: [{ key: keetaBudgetKey(day, url), amount: spent.toString(), at: "2026-11-15T01:00:00.000Z" }],
    }) + "\n",
  );
  const b = new KeetaBudget(file, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, day);
  const key2 = keetaBudgetKey(day, "https://keespecs.xyz/api/status");
  assert.ok("refused" in b.reserve(10_000n, key2, null));
  rmSync(dir, { recursive: true });
});

test("keeta: KeetaBudget refuses the 601st purchase in a month (600 purchases on earlier days in the month ledger file)", () => {
  const day = "2026-11-16";
  const month = day.slice(0, 7);
  const dir = mkdtempSync(join(tmpdir(), "keeta-601-"));
  const file = join(dir, `budget-keeta-${month}.json`);
  const purchases = Array.from({ length: KEETA_MAX_PURCHASES_PER_MONTH }, (_, i) => {
    const d = `2026-11-${String((i % 15) + 1).padStart(2, "0")}`;
    return { key: `${d}|https://keespecs.xyz/api/r${i}`, amount: "1", at: `${d}T00:00:00.000Z` };
  });
  writeFileSync(file, JSON.stringify({ baselineAtomic: "0", spentAtomic: purchases.length.toString(), purchases }) + "\n");
  const before = readFileSync(file, "utf8");
  const b = new KeetaBudget(file, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, day);
  const r = b.reserve(1n, keetaBudgetKey(day, "https://keespecs.xyz/api/pulse"), null);
  assert.ok("refused" in r);
  assert.equal(r.refused, "purchase_count_reached");
  assert.ok(!r.detail?.startsWith("run:"));
  assert.equal(readFileSync(file, "utf8"), before);
  rmSync(dir, { recursive: true });
});

test("keeta: the reservation is on the ledger file before the signer is called", async () => {
  const day = "2026-11-15";
  const url = "https://keespecs.xyz/api/pulse";
  const key = keetaBudgetKey(day, url);
  const dir = mkdtempSync(join(tmpdir(), "keeta-resv-"));
  const file = join(dir, "ledger.json");
  const budget = new KeetaBudget(file, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, day);
  const payer = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 22).toString("hex"), 0).publicKeyString.toString();
  const blockHash = "bh_reserve";
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    },
    payer,
    createPayment: async () => {
      signed++;
      const state = JSON.parse(readFileSync(file, "utf8")) as { purchases: { key: string }[] };
      assert.ok(state.purchases.some((p) => p.key === key), "reservation must be on the ledger before signing");
      return { headers: { "payment-signature": "x" }, blockHash, blockBase64: "eA==" };
    },
    reader: {
      getBlock: async (hash) =>
        hash === blockHash
          ? { account: payer, network: "0x5382", hash, operations: [{ type: "SEND", to: PAYTO, amount: "10000", token: KEETA_USDC }] }
          : null,
      onLedger: async (hash) => hash === blockHash,
      destroy: async () => undefined,
    },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    sleep: async () => undefined,
  };
  await buyKeetaOne({ url, host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, day, 1);
  assert.equal(signed, 1);
  rmSync(dir, { recursive: true });
});

test("keeta: keetaBudgetKey normalizes URLs so trailing slash matches bare path but query is kept; fragment is dropped", () => {
  const day = "2026-11-15";
  assert.equal(
    keetaBudgetKey(day, "https://keespecs.xyz/api/pulse/"),
    keetaBudgetKey(day, "https://keespecs.xyz/api/pulse"),
  );
  assert.notEqual(
    keetaBudgetKey(day, "https://keespecs.xyz/api/pulse"),
    keetaBudgetKey(day, "https://keespecs.xyz/api/pulse?x=1"),
  );
  assert.equal(normalizeKeetaPurchaseUrl("https://keespecs.xyz/api/pulse?x=1#frag"), "https://keespecs.xyz/api/pulse?x=1");
});

test("keeta: buyKeetaOne never calls the signer when the budget refuses, and releases the reservation when the payment could not be built", async () => {
  const budget = new KeetaBudget(null, 0n);
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async () =>
      new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } }),
    payer: "keeta_payer",
    createPayment: async () => {
      signed++;
      return { headers: {}, blockHash: "h", blockBase64: "eA==" };
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const row = (await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1)).row;
  assert.equal(row.outcome, "refused");
  assert.equal(signed, 0);
  const b2 = new KeetaBudget(null);
  const deps2: KeetaBuyDeps = {
    fetch: deps.fetch,
    payer: deps.payer,
    reader: deps.reader,
    balance: deps.balance,
    now: deps.now,
    sleep: deps.sleep,
    budget: b2,
    createPayment: async () => {
      signed++;
      throw new PayloadNotCreatedError("build failed");
    },
  };
  const row2 = (await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps2, "2026-11-16", 1)).row;
  assert.equal(row2.outcome, "not_sent");
  assert.equal(row2.reason, "payload_not_created");
  assert.equal(signed, 1);
});

test("keeta: the fenced signer refuses a block for another recipient, amount, token or network", async () => {
  const inner: ClientKeetaSigner = {
    async computePaymentBlock() {
      return {} as never;
    },
    destroy: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
  const lock = { payTo: PAYTO, amount: "10000", asset: KEETA_USDC, network: KEETA_CAIP2, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC };
  const f = fenceKeetaSigner(inner, lock);
  const recipient = { publicKeyString: "keeta_other" };
  const token = { publicKeyString: KEETA_USDC };
  await assert.rejects(() => f.computePaymentBlock("keeta:1", { publicKeyString: PAYTO } as never, 10000n, token as never), /network/);
  await assert.rejects(() => f.computePaymentBlock(KEETA_CAIP2, { publicKeyString: "keeta_x" } as never, 10000n, token as never), /recipient/);
  await assert.rejects(() => f.computePaymentBlock(KEETA_CAIP2, { publicKeyString: PAYTO } as never, 9999n, token as never), /amount/);
  await assert.rejects(() => f.computePaymentBlock(KEETA_CAIP2, { publicKeyString: PAYTO } as never, 10000n, { publicKeyString: "keeta_x" } as never), /token/);
});

test("keeta: the settlement is read back from the ledger by vet402's own block hash: settled, mismatched (false), not found (null, the run stops); the seller's transaction field is not trusted", async () => {
  const reader: KeetaLedgerReader = {
    async getBlock(hash) {
      if (hash === "good") return { account: "keeta_p", network: "0x5382", operations: [{ type: "SEND", to: PAYTO, amount: "10000", token: KEETA_USDC }] };
      if (hash === "bad") return { account: "keeta_p", network: "0x5382", operations: [{ type: "SEND", to: "keeta_x", amount: "1", token: KEETA_USDC }] };
      return null;
    },
    onLedger: async (h) => h === "good" || h === "bad",
    destroy: async () => undefined,
  };
  const base = { payer: "keeta_p", payTo: PAYTO, amount: "10000", asset: KEETA_USDC };
  const ok = await verifyKeetaPayment(reader, { ...base, blockHash: "good" }, { tries: 1, waitMs: 0, sleep: async () => undefined });
  assert.deepEqual(ok, { settled: true });
  const no = await verifyKeetaPayment(reader, { ...base, blockHash: "bad" }, { tries: 1, waitMs: 0, sleep: async () => undefined });
  assert.equal(no.settled, false);
  const miss = await verifyKeetaPayment(reader, { ...base, blockHash: "missing" }, { tries: 2, waitMs: 1, sleep: async () => undefined });
  assert.equal(miss.settled, null);
  assert.ok("notFound" in miss && miss.notFound);
});

test("keeta: verifyKeetaPayment rejects when the ledger block hash does not match the payment block hash", async () => {
  const reader: KeetaLedgerReader = {
    async getBlock() {
      return {
        account: "keeta_p",
        network: "0x5382",
        hash: "LedgerHashABC",
        operations: [{ type: "SEND", to: PAYTO, amount: "10000", token: KEETA_USDC }],
      };
    },
    onLedger: async () => true,
    destroy: async () => undefined,
  };
  const r = await verifyKeetaPayment(
    reader,
    { blockHash: "expectedHash", payer: "keeta_p", payTo: PAYTO, amount: "10000", asset: KEETA_USDC },
    { tries: 1, waitMs: 0, sleep: async () => undefined },
  );
  assert.equal(r.settled, false);
  assert.match("detail" in r ? r.detail : "", /hash/i);
});

test("keeta: verifyKeetaPayment retries when the block exists but vote staple is not on ledger yet", async () => {
  let stapleCalls = 0;
  const reader: KeetaLedgerReader = {
    async getBlock() {
      return { account: "keeta_p", network: "0x5382", operations: [{ type: "SEND", to: PAYTO, amount: "10000", token: KEETA_USDC }] };
    },
    async onLedger() {
      stapleCalls++;
      return stapleCalls >= 2;
    },
    destroy: async () => undefined,
  };
  const r = await verifyKeetaPayment(
    reader,
    { blockHash: "h", payer: "keeta_p", payTo: PAYTO, amount: "10000", asset: KEETA_USDC },
    { tries: 3, waitMs: 0, sleep: async () => undefined },
  );
  assert.deepEqual(r, { settled: true });
  assert.equal(stapleCalls, 2);
});

test("keeta: isKeetaMonthCapRefusal distinguishes month cap from run cap on total_cap_reached", () => {
  assert.ok(isKeetaMonthCapRefusal({ refused: "total_cap_reached", detail: "spent 1 + 2 > total cap 3" }));
  assert.ok(!isKeetaMonthCapRefusal({ refused: "total_cap_reached", detail: "run: spent 0 + 1 > run cap 2" }));
  assert.ok(isKeetaRunCapRefusal({ refused: "total_cap_reached", detail: "run: spent 0 + 1 > run cap 2" }));
});

async function sealedKeetaBlock(
  payer: InstanceType<typeof KeetaNet.lib.Account>,
  opts: { network?: bigint; to?: string; amount?: bigint; token?: string; extraOp?: boolean; external?: string } = {},
): Promise<InstanceType<typeof KeetaNet.lib.Block>> {
  const network = opts.network ?? 21378n;
  const to = KeetaNet.lib.Account.fromPublicKeyString(opts.to ?? PAYTO);
  const token = KeetaNet.lib.Account.fromPublicKeyString(opts.token ?? KEETA_USDC);
  const ops: { type: number; to: unknown; amount: bigint; token: unknown; external?: string }[] = [
    {
      type: KeetaNet.lib.Block.OperationType.SEND,
      to,
      amount: opts.amount ?? 10_000n,
      token,
      ...(opts.external !== undefined ? { external: opts.external } : {}),
    },
  ];
  if (opts.extraOp) {
    ops.push({ type: KeetaNet.lib.Block.OperationType.SEND, to, amount: 1n, token });
  }
  return new KeetaNet.lib.Block.Builder({
    previous: KeetaNet.lib.Block.NO_PREVIOUS,
    account: payer,
    network,
    signer: payer as never,
    operations: ops as never,
  }).seal();
}

test("keeta: makeKeetaCreatePayment accepts a fixture-built mainnet block and rejects wrong network, recipient, amount, token, payer or operation count", async () => {
  // Fixed test vector with no funds. Not a live payer key.
  const payerAcct = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 7).toString("hex"), 0);
  const payer = payerAcct.publicKeyString.toString();
  const pr = parseKeeta402(() => null, pulse.body);
  const accept = pickKeetaAccept((pr.accepts as unknown as Record<string, unknown>[]).map(normalizeKeetaAccept), lock);
  assert.ok("accept" in accept);
  const good = await sealedKeetaBlock(payerAcct);
  const signerOk: ClientKeetaSigner = {
    computePaymentBlock: async () => good,
    destroy: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
  const created = await makeKeetaCreatePayment(signerOk, payer)(pr, accept.accept);
  assert.equal(created.blockHash, good.hash.toString());
  assert.ok(created.headers["payment-signature"] || created.headers["PAYMENT-SIGNATURE"]);

  const cases: { name: string; block: Promise<InstanceType<typeof KeetaNet.lib.Block>> }[] = [
    { name: "network", block: sealedKeetaBlock(payerAcct, { network: 1413829460n }) },
    {
      name: "recipient",
      block: sealedKeetaBlock(payerAcct, { to: KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 8).toString("hex"), 0).publicKeyString.toString() }),
    },
    { name: "amount", block: sealedKeetaBlock(payerAcct, { amount: 20_000n }) },
    {
      name: "token",
      block: sealedKeetaBlock(payerAcct, { token: KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 10).toString("hex"), 0).publicKeyString.toString() }),
    },
    { name: "two-ops", block: sealedKeetaBlock(payerAcct, { extraOp: true }) },
  ];
  for (const c of cases) {
    const signer: ClientKeetaSigner = {
      computePaymentBlock: async () => c.block,
      destroy: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };
    await assert.rejects(() => makeKeetaCreatePayment(signer, payer)(pr, accept.accept));
  }
  const otherPayer = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 9).toString("hex"), 0);
  const wrongAcct = await sealedKeetaBlock(otherPayer);
  await assert.rejects(
    () =>
      makeKeetaCreatePayment(
        { computePaymentBlock: async () => wrongAcct, destroy: async () => undefined, [Symbol.asyncDispose]: async () => undefined },
        payer,
      )(pr, accept.accept),
    /payer/,
  );

  const pulseAccept = (pulse.body as { accepts: Record<string, unknown>[] }).accepts[0]!;
  const extAcceptRaw = { ...pulseAccept, extra: { external: "ext-good" } };
  const prExt = { ...pr, accepts: [extAcceptRaw as Record<string, unknown>] } as typeof pr;
  const extPicked = pickKeetaAccept([normalizeKeetaAccept(extAcceptRaw)], lock);
  assert.ok("accept" in extPicked);
  const withExt = extPicked.accept;
  const extBad = await sealedKeetaBlock(payerAcct, { external: "ext-wrong" });
  await assert.rejects(
    () =>
      makeKeetaCreatePayment(
        { computePaymentBlock: async () => extBad, destroy: async () => undefined, [Symbol.asyncDispose]: async () => undefined },
        payer,
      )(prExt, withExt),
    /external/,
  );
  const extUnexpected = await sealedKeetaBlock(payerAcct, { external: "surprise" });
  await assert.rejects(
    () =>
      makeKeetaCreatePayment(
        { computePaymentBlock: async () => extUnexpected, destroy: async () => undefined, [Symbol.asyncDispose]: async () => undefined },
        payer,
      )(pr, accept.accept),
    /external/,
  );
});

test("keeta: buyKeetaOne returns a sent row and stop when the ledger never shows the block hash", async () => {
  const budget = new KeetaBudget(null);
  let tries = 0;
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    },
    payer: KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 7).toString("hex"), 0).publicKeyString.toString(),
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash: "bh1", blockBase64: "eA==" }),
    reader: {
      getBlock: async () => null,
      onLedger: async () => false,
      destroy: async () => undefined,
    },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => {
      tries++;
    },
  };
  const out = await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1);
  assert.equal(out.row.outcome, "sent");
  assert.equal(out.row.settled, null);
  assert.equal(out.row.tx, "bh1");
  assert.match(out.stop ?? "", /^keeta_tx_not_found:/);
  assert.equal(tries, KEETA_VERIFY_TRIES - 1);
});

test("keeta: loadKeetaAccount matches .pub with publicKeyString.toString(), not object identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-load-"));
  const acct = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 11).toString("hex"), 0);
  const addr = acct.publicKeyString.toString();
  writeFileSync(join(dir, "keeta-payer.json"), JSON.stringify({ seed: Buffer.alloc(32, 11).toString("hex"), index: 0 }) + "\n");
  chmodSync(join(dir, "keeta-payer.json"), 0o600);
  const loaded = await loadKeetaAccount(join(dir, "keeta-payer.json"), addr);
  assert.equal(loaded.publicKeyString.toString(), addr);
  rmSync(dir, { recursive: true });
});

test("keeta: readKeetaResultFile refuses wrong kind, chain, date or payer", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-res-"));
  const file = join(dir, "keeta-2026-11-15.json");
  writeFileSync(file, JSON.stringify({ kind: "vet402-remeasure", chain: "keeta", version: 1, network: KEETA_CAIP2, date: "2026-11-15", payer: "keeta_a", note: "n", runs: [], rows: [] }));
  assert.ok(readKeetaResultFile(file, "2026-11-15", "keeta_a").chain === "keeta");
  assert.throws(() => readKeetaResultFile(file, "2026-11-16", "keeta_a"), /2026-11-16/);
  assert.throws(() => readKeetaResultFile(file, "2026-11-15", "keeta_other"), /another payer/);
  writeFileSync(file, JSON.stringify({ kind: "other", chain: "keeta", date: "2026-11-15", payer: "keeta_a", runs: [], rows: [] }));
  assert.throws(() => readKeetaResultFile(file, "2026-11-15", "keeta_a"), /not a keeta/);
  rmSync(dir, { recursive: true });
});

test("keeta keygen: .pub is written with O_EXCL and a too-open key dir is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-key2-"));
  chmodSync(dir, 0o755);
  assert.throws(() => writeKeetaKey({ dir, generateSeed: () => "aa", addressOf: () => "keeta_x" }), /700/);
  chmodSync(dir, 0o700);
  writeKeetaKey({ dir, generateSeed: () => "aa", addressOf: () => "keeta_testaddr2" });
  assert.throws(() => writeKeetaKey({ dir, generateSeed: () => "bb", addressOf: () => "keeta_y" }), /already exists/);
  rmSync(dir, { recursive: true });
});

test("keeta plan: no key leaves Keeta out today (skip, exit 11); a short balance skips; over a cap stops; within the caps pays; solana and tempo verdicts unchanged", () => {
  const keetaPlan = () => ({
    kind: "vet402-remeasure-dry-run",
    chain: "keeta",
    createdAt: "2026-10-01T01:18:00.000Z",
    perPayTo: 1,
    caps: { perRun: "0.250000", monthLeft: "6.000000" },
    summary: { would: 1, estimate: "0.010000", payerUsdcBefore: "1.000000" },
    rows: [{ key: "2026-10-01|https://keespecs.xyz/api/pulse", outcome: "would_pay", priceUsdc: "0.010000" }],
    signer: { problem: "no Keeta purchase key (keeta-payer.pub not found in the key folder)" },
  });
  const skip = planVerdict(keetaPlan(), "keeta", "2026-10-01", 1);
  assert.equal(skip.skip, true);
  assert.match(skip.line, /not buying today/);
  const short = planVerdict({ ...keetaPlan(), signer: {}, summary: { would: 1, estimate: "0.010000", payerUsdcBefore: "0.001000" } }, "keeta", "2026-10-01", 1);
  assert.equal(short.skip, true);
  const over = planVerdict({ ...keetaPlan(), signer: {}, caps: { perRun: "0.005000", monthLeft: "6.000000" } }, "keeta", "2026-10-01", 1);
  assert.equal(over.stop, true);
  const pay = planVerdict({ ...keetaPlan(), signer: {} }, "keeta", "2026-10-01", 1);
  assert.equal(pay.pay, true);
  const sol = planVerdict(
    { kind: "vet402-remeasure-dry-run", chain: "solana", createdAt: "2026-10-01T01:18:00.000Z", perPayTo: 1, caps: { perRun: "3.000000", monthLeft: "25.000000" }, summary: { would: 1, estimate: "0.500000", payerUsdcBefore: "45.000000" }, rows: [{ key: "k", outcome: "would_pay", priceUsdc: "0.500000" }] },
    "solana",
    "2026-10-01",
    1,
  );
  assert.equal(sol.pay, true);
  const tempo = planVerdict(
    {
      kind: "vet402-remeasure-dry-run",
      chain: "tempo",
      createdAt: "2026-10-01T01:18:00.000Z",
      perPayTo: 1,
      caps: { perRun: "1.000000", monthLeft: "25.000000" },
      summary: { would: 1, estimate: "0.500000", payerUsdcEBefore: "15.000000" },
      rows: [{ key: "k", outcome: "would_pay", priceUsdc: "0.500000" }],
    },
    "tempo",
    "2026-10-01",
    1,
  );
  assert.equal(tempo.pay, true);
});

test("keeta keygen: refuses when either key file exists, writes the seed with mode 600 via O_EXCL, and returns only the address", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-key-"));
  const addr = writeKeetaKey({
    dir,
    generateSeed: () => "aabbcc",
    addressOf: () => "keeta_testaddr",
  });
  assert.equal(addr, "keeta_testaddr");
  assert.throws(() => writeKeetaKey({ dir, generateSeed: () => "x", addressOf: () => "keeta_x" }), /already exists/);
  assert.ok(existsSync(join(dir, "keeta-payer.json")));
  const stat = statSync(join(dir, "keeta-payer.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  rmSync(dir, { recursive: true });
});

test("keeta: verifyKeetaPayment rejects a block whose network is not Keeta mainnet 0x5382", async () => {
  const reader: KeetaLedgerReader = {
    async getBlock() {
      return {
        account: "keeta_p",
        network: "0xdead",
        operations: [{ type: "SEND", to: PAYTO, amount: "10000", token: KEETA_USDC }],
      };
    },
    onLedger: async () => true,
    destroy: async () => undefined,
  };
  const r = await verifyKeetaPayment(
    reader,
    { blockHash: "h", payer: "keeta_p", payTo: PAYTO, amount: "10000", asset: KEETA_USDC },
    { tries: 1, waitMs: 0, sleep: async () => undefined },
  );
  assert.equal(r.settled, false);
});

function hangingKeetaClient(fastDestroy = false) {
  const hang = () => new Promise<never>(() => undefined);
  return {
    client: { getBlock: hang, getVoteStaple: hang, getBalance: hang },
    destroy: fastDestroy ? async () => undefined : hang,
  };
}

test("keeta: publicKeetaReader getBlock, onLedger and readKeetaUsdcBalance getBalance reject with keeta_rpc_timeout before 1s when the client never answers", async () => {
  const ms = 30;
  const reader = publicKeetaReader(hangingKeetaClient as never, ms);
  const t0 = Date.now();
  await assert.rejects(() => reader.getBlock("h"), (e: Error) => e.message === `keeta_rpc_timeout: getBlock after ${ms}ms`);
  assert.ok(Date.now() - t0 < 1000);
  const t1 = Date.now();
  await assert.rejects(() => reader.onLedger("h"), (e: Error) => e.message === `keeta_rpc_timeout: getVoteStaple after ${ms}ms`);
  assert.ok(Date.now() - t1 < 1000);
  const t2 = Date.now();
  await assert.rejects(
    () => readKeetaUsdcBalance("keeta_p", KEETA_USDC, () => hangingKeetaClient(true) as never, ms),
    (e: Error) => e.message === `keeta_rpc_timeout: getBalance after ${ms}ms`,
  );
  assert.ok(Date.now() - t2 < 1000);
  await assert.rejects(() => withKeetaTimeout(new Promise(() => undefined), ms, "testHang"), (e: Error) =>
    e.message === `keeta_rpc_timeout: testHang after ${ms}ms`,
  );
});

test("keeta: a signer that never answers ends in keeta_sign_timeout within the limit, the reservation is released and nothing is fetched with a payment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-sign-to-"));
  const budget = new KeetaBudget(join(dir, "budget.json"), KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, "2026-11-15");
  const payer = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 31).toString("hex"), 0).publicKeyString.toString();
  const url = "https://keespecs.xyz/api/pulse";
  const key = keetaBudgetKey("2026-11-15", url);
  let paidFetches = 0;
  const inner: ClientKeetaSigner = {
    computePaymentBlock() {
      return new Promise(() => undefined);
    },
    destroy: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
  const createPayment = makeKeetaCreatePayment(inner, payer, KEETA_MAX_PER_PURCHASE_ATOMIC, 30);
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (init && "headers" in init) {
        const h = init.headers as Record<string, string>;
        if (Object.keys(h).some((k) => k.toLowerCase() === "payment-signature")) paidFetches += 1;
      }
      return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
    },
    payer,
    createPayment,
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    sleep: async () => undefined,
  };
  const t0 = Date.now();
  const out = await buyKeetaOne({ url, host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(out.row.reason, "keeta_sign_timeout");
  assert.ok(out.stop?.startsWith("keeta_sign_timeout:"));
  assert.equal(paidFetches, 0);
  const again = budget.reserve(10_000n, key, 1_000_000n);
  assert.ok("ok" in again);
  rmSync(dir, { recursive: true });
});

test("keeta: buyKeetaOne returns keeta_ledger_unreadable with the paid row when verify hits a keeta_rpc_timeout", async () => {
  const budget = new KeetaBudget(null);
  const blockHash = "bh_timeout";
  const payer = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 29).toString("hex"), 0).publicKeyString.toString();
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    },
    payer,
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash, blockBase64: "eA==" }),
    reader: publicKeetaReader(hangingKeetaClient as never, 30),
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    sleep: async () => undefined,
  };
  const t0 = Date.now();
  const out = await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1);
  assert.ok(Date.now() - t0 < 1000);
  assert.match(out.stop ?? "", /^keeta_ledger_unreadable:.*keeta_rpc_timeout/);
  assert.equal(out.row.tx, blockHash);
  assert.equal(out.row.settled, null);
});

test("keeta: buyKeetaOne uses vet402's block hash for settlement, not the seller's PAYMENT-RESPONSE transaction field", async () => {
  const budget = new KeetaBudget(null);
  const blockHash = "vet402_block_hash";
  const sellerTx = "seller_lied_tx";
  // Fixed test vector with no funds. Not a live payer key.
  const payer = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 7).toString("hex"), 0).publicKeyString.toString();
  const reader: KeetaLedgerReader = {
    async getBlock(hash) {
      if (hash !== blockHash) return null;
      return {
        account: payer,
        network: "0x5382",
        operations: [{ type: "SEND", to: PAYTO, amount: "10000", token: KEETA_USDC }],
      };
    },
    onLedger: async (h) => h === blockHash,
    destroy: async () => undefined,
  };
  const payResponse = encodePaymentResponseHeader({ success: true, transaction: sellerTx, network: KEETA_CAIP2 } as never);
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      const hdr = (init?.headers ?? {}) as Record<string, string>;
      if (!hdr["payment-signature"] && !hdr["PAYMENT-SIGNATURE"]) {
        return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": payResponse },
      });
    },
    payer,
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash, blockBase64: "eA==" }),
    reader,
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1);
  assert.equal(out.row.tx, blockHash);
  assert.equal(out.row.sellerTx, sellerTx);
  assert.equal(out.row.settled, true);
  assert.match(out.row.detail ?? "", /vet402's block/);
});

test("keeta: buyKeetaOne returns stop keeta_tx_mismatch when the ledger block contents do not match the payment", async () => {
  const budget = new KeetaBudget(null);
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    },
    payer: "keeta_p",
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash: "bh_m", blockBase64: "eA==" }),
    reader: {
      async getBlock() {
        return {
          account: "keeta_p",
          network: "0x5382",
          operations: [{ type: "SEND", to: "keeta_x", amount: "1", token: KEETA_USDC }],
        };
      },
      onLedger: async () => true,
      destroy: async () => undefined,
    },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1);
  assert.match(out.stop ?? "", /^keeta_tx_mismatch:/);
  assert.equal(out.row.settled, false);
  assert.equal(out.row.tx, "bh_m");
});

test("keeta: buyKeetaOne returns stop keeta_ledger_unreadable when verifyKeetaPayment throws", async () => {
  const budget = new KeetaBudget(null);
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    },
    payer: "keeta_p",
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash: "bh_u", blockBase64: "eA==" }),
    reader: {
      getBlock: async () => {
        throw new Error("ledger rpc down");
      },
      onLedger: async () => true,
      destroy: async () => undefined,
    },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 1);
  assert.match(out.stop ?? "", /^keeta_ledger_unreadable:/);
  assert.equal(out.row.tx, "bh_u");
  assert.equal(out.row.settled, null);
});

test("keeta: buyKeetaOne refuses price_raised when the live 402 amount is above the planned price", async () => {
  const budget = new KeetaBudget(null);
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async () => new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } }),
    payer: "keeta_p",
    createPayment: async () => {
      signed++;
      return { headers: {}, blockHash: "h", blockBase64: "eA==" };
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const row = (
    await buyKeetaOne(
      { url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO, plannedPriceAtomic: "5000" },
      deps,
      "2026-11-15",
      1,
    )
  ).row;
  assert.equal(row.reason, "price_raised");
  assert.equal(signed, 0);
});

test("keeta: KeetaBudget treats an unreadable month ledger as day run cap exhausted", () => {
  const day = "2026-11-15";
  const dir = mkdtempSync(join(tmpdir(), "keeta-badledger-"));
  const file = join(dir, "ledger.json");
  writeFileSync(file, "{{not json");
  const b = new KeetaBudget(file, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, day);
  const r = b.reserve(1n, keetaBudgetKey(day, "https://keespecs.xyz/api/a"), null);
  assert.ok("refused" in r);
  assert.ok(isKeetaRunCapRefusal({ refused: r.refused, detail: r.detail }) || r.refused === "purchase_count_reached");
  rmSync(dir, { recursive: true });
});

test("keeta: probePayable classifies header-only 402 as would_pay using the pulse fixture payment-required header", async () => {
  const h = pulse.headers as Record<string, string>;
  const prHdr = h["payment-required"]!;
  const row = await probePayable(
    "https://keespecs.xyz/api/pulse",
    PAYTO,
    async () => new Response("", { status: 402, headers: { "payment-required": prHdr } }),
    { at: "2026-11-15T12:00:00.000Z", date: "2026-11-15" },
  );
  assert.ok(row);
  assert.equal(row!.outcome, "would_pay");
});

test("keeta: buyKeetaOne stores the slot argument on the row", async () => {
  const budget = new KeetaBudget(null);
  const deps: KeetaBuyDeps = {
    fetch: async () => new Response(JSON.stringify(pulse.body), { status: 402, headers: { "content-type": "application/json" } }),
    payer: "keeta_p",
    createPayment: async () => ({ headers: {}, blockHash: "h", blockBase64: "eA==" }),
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne({ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO }, deps, "2026-11-15", 4);
  assert.equal(out.row.slot, 4);
});

test("keeta: fetchCatalog uses redirect manual, rejects 3xx and cross-host response url, and returns the catalog", async () => {
  const seller = KEETA_SELLERS[0]!;
  let redirect: RequestRedirect | undefined;
  const ok = await fetchCatalog(seller.catalog, async (url, init) => {
    redirect = init?.redirect;
    const r = new Response(JSON.stringify(catalog.body), { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(r, "url", { value: url });
    return r;
  });
  assert.equal(redirect, "manual");
  assert.ok(Array.isArray(ok.resources));
  await assert.rejects(() =>
    fetchCatalog(seller.catalog, async () => new Response("", { status: 302, headers: { location: "https://evil.example/" } })),
  );
  await assert.rejects(() =>
    fetchCatalog(seller.catalog, async () => {
      const r = new Response(JSON.stringify(catalog.body), { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(r, "url", { value: "https://evil.example/.well-known/x402" });
      return r;
    }),
  );
});

test("keeta: buildKeetaPlan respects the month cap on the dry-run budget (5.90 spent leaves 0.10 for fifteen 0.01 routes)", () => {
  const seller = KEETA_SELLERS[0]!;
  const routes = keetaCandidatesFromCatalog(catalog.body, seller);
  const payable = (probe.rows as { url: string; status: number }[]).filter((x) => x.status === 402);
  const probes = payable.map((p) => {
    const url = routes.find((r) => r.url === p.url)!.url;
    return { url, host: "keespecs.xyz", expectedPayTo: PAYTO, priceUsdc: "0.010000" };
  });
  const plan = buildKeetaPlan({
    probes,
    monthSpent: 5_900_000n,
    monthCount: 0,
    daySeed: { spent: 0n, count: 0 },
    balance: 10_000_000n,
    now: new Date("2026-11-15T01:00:00.000Z"),
    payer: "keeta_test",
    date: "2026-11-15",
  });
  assert.equal(plan.summary.would, 10);
  assert.equal(plan.summary.estimate, "0.100000");
  assert.ok(plan.signer.warn);
  assert.match(plan.signer.warn!, /10 of 15 payable routes/);
  const v = planVerdict({ ...plan, signer: { warn: plan.signer.warn } }, "keeta", "2026-11-15", 1);
  assert.equal(v.pay, true);
  assert.ok(v.warn);
});

test("keeta: buildKeetaPlan with no month left yields nothing to buy and a month-cap warn", () => {
  const plan = buildKeetaPlan({
    probes: [{ url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO, priceUsdc: "0.010000" }],
    monthSpent: KEETA_MAX_PER_MONTH_ATOMIC,
    monthCount: 0,
    daySeed: { spent: 0n, count: 0 },
    balance: 10_000_000n,
    now: new Date("2026-11-15T01:00:00.000Z"),
    payer: "keeta_test",
    date: "2026-11-15",
  });
  assert.equal(plan.summary.would, 0);
  assert.ok(plan.signer.warn);
  const v = planVerdict({ ...plan, signer: { warn: plan.signer.warn } }, "keeta", "2026-11-15", 1);
  assert.equal(v.pay, false);
  assert.equal(v.stop, false);
  assert.ok(v.warn);
});

test("keeta: buyKeetaOne refuses url_host_mismatch without fetch or createPayment", async () => {
  let fetched = 0;
  const budget = new KeetaBudget(null);
  const deps: KeetaBuyDeps = {
    fetch: async () => {
      fetched += 1;
      return new Response("", { status: 500 });
    },
    payer: "keeta_p",
    createPayment: async () => {
      throw new Error("must not sign");
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    { url: "https://evil.example/api/pulse", host: "keespecs.xyz", expectedPayTo: PAYTO },
    deps,
    "2026-11-15",
    1,
  );
  assert.equal(out.row.reason, "url_host_mismatch");
  assert.equal(fetched, 0);
});

test("keeta: readKeetaPayPlan skips a would_pay row whose url host does not match the plan host", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-plan-host-"));
  const day = "2026-11-15";
  const file = join(dir, "plan.json");
  const logs: string[] = [];
  writeFileSync(
    file,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T01:00:00.000Z",
      rows: [
        { outcome: "would_pay", url: "https://evil.example/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" },
        { outcome: "would_pay", url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" },
      ],
    }),
  );
  const entries = readKeetaPayPlan(file, day, (m) => logs.push(m));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.url, "https://keespecs.xyz/api/pulse");
  assert.ok(logs.some((l) => /does not match url host evil\.example/.test(l)));
  rmSync(dir, { recursive: true });
});

test("keeta: runKeetaPayRun releases keeta.lock when loadAccount, readResult or buyOne throws", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "keeta-payrun-"));
  const keyDir = mkdtempSync(join(tmpdir(), "keeta-payrun-k-"));
  const day = "2026-11-15";
  const planFile = join(resultsDir, "plan.json");
  writeFileSync(
    planFile,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T01:00:00.000Z",
      rows: [{ outcome: "would_pay", url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" }],
    }),
  );
  const fakeAccount = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 20).toString("hex"), 0);
  const payer = fakeAccount.publicKeyString.toString();
  writeFileSync(join(keyDir, "keeta-payer.pub"), `${payer}\n`);
  chmodSync(join(keyDir, "keeta-payer.pub"), 0o600);
  writeFileSync(join(keyDir, "keeta-payer.json"), JSON.stringify({ seed: Buffer.alloc(32, 20).toString("hex"), index: 0 }) + "\n");
  chmodSync(join(keyDir, "keeta-payer.json"), 0o600);
  const lock = keetaLockPath(resultsDir);
  const base = {
    planFile,
    date: day,
    now: new Date("2026-11-15T12:00:00Z"),
    resultsDir,
    fetchImpl: fetch,
  };
  const okHooks = {
    pubFile: join(keyDir, "keeta-payer.pub"),
    keyFile: join(keyDir, "keeta-payer.json"),
    loadAccount: async () => fakeAccount,
    makeReader: () => ({ getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined }),
    readResult: () => emptyKeetaResult(day, payer),
    readPlan: readKeetaPayPlan,
    readBalance: async () => 1_000_000n,
    acquireLock: (f: string, now: Date) => acquireRunLock(f, now),
    statPubMode: () => 0o600,
    readPubAddress: () => payer,
    writeResult: () => undefined,
    log: () => undefined,
    error: () => undefined,
  };
  await runKeetaPayRun({
    ...base,
    hooks: { ...okHooks, loadAccount: async () => { throw new Error("load fail"); } },
  });
  assert.ok(!existsSync(lock));
  await runKeetaPayRun({
    ...base,
    hooks: { ...okHooks, readResult: () => { throw new Error("read fail"); } },
  });
  assert.ok(!existsSync(lock));
  await runKeetaPayRun({
    ...base,
    hooks: {
      ...okHooks,
      buyOne: async () => {
        throw new Error("buy fail");
      },
    },
  });
  assert.ok(!existsSync(lock));
  rmSync(resultsDir, { recursive: true });
  rmSync(keyDir, { recursive: true });
});

test("keeta: runKeetaPayRun enforces per-seller cap (kta-oracle 3)", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "keeta-sellercap-"));
  const keyDir = mkdtempSync(join(tmpdir(), "keeta-sellercap-k-"));
  const day = "2026-11-16";
  const planFile = join(resultsDir, "plan.json");
  const ktaUrls = [
    "https://kta-oracle.top/network/pulse",
    "https://kta-oracle.top/network/pulse?a=1",
    "https://kta-oracle.top/network/pulse?a=2",
    "https://kta-oracle.top/network/pulse?a=3",
  ];
  writeFileSync(
    planFile,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T01:00:00.000Z",
      rows: ktaUrls.map((url) => ({
        outcome: "would_pay",
        url,
        host: "kta-oracle.top",
        priceUsdc: "0.001000",
      })),
    }),
  );
  const fakeAccount = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 22).toString("hex"), 0);
  const payer = fakeAccount.publicKeyString.toString();
  writeFileSync(join(keyDir, "keeta-payer.pub"), `${payer}\n`);
  chmodSync(join(keyDir, "keeta-payer.pub"), 0o600);
  let buyCalls = 0;
  let written: KeetaResultFile | undefined;
  await runKeetaPayRun({
    planFile,
    date: day,
    now: new Date("2026-11-16T12:00:00Z"),
    resultsDir,
    fetchImpl: fetch,
    hooks: {
      pubFile: join(keyDir, "keeta-payer.pub"),
      keyFile: join(keyDir, "keeta-payer.json"),
      loadAccount: async () => fakeAccount,
      makeReader: () => ({ getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined }),
      readResult: () => emptyKeetaResult(day, payer),
      readPlan: readKeetaPayPlan,
      readBalance: async () => 1_000_000n,
      acquireLock: (f, now) => acquireRunLock(f, now),
      statPubMode: () => 0o600,
      readPubAddress: () => payer,
      writeResult: (_p, data) => {
        written = data;
      },
      log: () => undefined,
      error: () => undefined,
      buyOne: async (entry, _deps, _date, slot) => {
        buyCalls += 1;
        return {
          row: {
            at: new Date().toISOString(),
            chain: "keeta",
            host: entry.host,
            service: null,
            url: entry.url,
            requestUrl: entry.url,
            payTo: entry.expectedPayTo,
            expectedPayTo: entry.expectedPayTo,
            outcome: "refused",
            reason: "no_keeta_accept",
            detail: "mock",
            settled: null,
            delivered: null,
            httpStatus: 404,
            bodyBytes: null,
            tx: null,
            sellerTx: null,
            priceUsdc: null,
            slot,
            key: keetaBudgetKey(day, entry.url),
          },
        };
      },
    },
  });
  assert.equal(buyCalls, 3);
  assert.equal(written?.rows.length, 4);
  assert.equal(written?.rows[3]?.reason, "purchase_count_reached");
  assert.match(written?.rows[3]?.detail ?? "", /cap 3/);
  rmSync(resultsDir, { recursive: true });
  rmSync(keyDir, { recursive: true });
});

test("keeta: runKeetaPayRun releases keeta.lock when signer.destroy never answers", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "keeta-payrun-d-"));
  const keyDir = mkdtempSync(join(tmpdir(), "keeta-payrun-dk-"));
  const day = "2026-11-15";
  const planFile = join(resultsDir, "plan.json");
  writeFileSync(
    planFile,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T01:00:00.000Z",
      rows: [{ outcome: "would_pay", url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" }],
    }),
  );
  const fakeAccount = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 21).toString("hex"), 0);
  const payer = fakeAccount.publicKeyString.toString();
  writeFileSync(join(keyDir, "keeta-payer.pub"), `${payer}\n`);
  chmodSync(join(keyDir, "keeta-payer.pub"), 0o600);
  writeFileSync(join(keyDir, "keeta-payer.json"), JSON.stringify({ seed: Buffer.alloc(32, 21).toString("hex"), index: 0 }) + "\n");
  chmodSync(join(keyDir, "keeta-payer.json"), 0o600);
  const lock = keetaLockPath(resultsDir);
  const hangSigner: ClientKeetaSigner = {
    computePaymentBlock: async () => {
      throw new Error("should not sign");
    },
    destroy() {
      return new Promise(() => undefined);
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
  const base = {
    planFile,
    date: day,
    now: new Date("2026-11-15T12:00:00Z"),
    resultsDir,
    fetchImpl: fetch,
  };
  const t0 = Date.now();
  await runKeetaPayRun({
    ...base,
    hooks: {
      pubFile: join(keyDir, "keeta-payer.pub"),
      keyFile: join(keyDir, "keeta-payer.json"),
      loadAccount: async () => fakeAccount,
      makeReader: () => ({ getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined }),
      readResult: () => emptyKeetaResult(day, payer),
      readPlan: readKeetaPayPlan,
      readBalance: async () => 1_000_000n,
      acquireLock: (f: string, now: Date) => acquireRunLock(f, now),
      statPubMode: () => 0o600,
      readPubAddress: () => payer,
      writeResult: () => undefined,
      log: () => undefined,
      error: () => undefined,
      toSigner: () => hangSigner,
      rpcTimeoutMs: 30,
      buyOne: async () => ({
        row: {
          at: new Date().toISOString(),
          chain: "keeta" as const,
          host: "keespecs.xyz",
          service: null,
          url: "https://keespecs.xyz/api/pulse",
          requestUrl: "https://keespecs.xyz/api/pulse",
          payTo: PAYTO,
          expectedPayTo: PAYTO,
          outcome: "refused",
          reason: "test_skip",
          detail: null,
          settled: null,
          delivered: null,
          httpStatus: null,
          bodyBytes: null,
          tx: null,
          sellerTx: null,
          priceUsdc: null,
          slot: 1,
          key: "k",
        },
      }),
    },
  });
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(!existsSync(lock));
  rmSync(resultsDir, { recursive: true });
  rmSync(keyDir, { recursive: true });
});

test("keeta: readKeetaPayPlan reads only would_pay rows from today's dry-run plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-plan-"));
  const day = "2026-11-15";
  const file = join(dir, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T01:00:00.000Z",
      rows: [
        { outcome: "would_pay", url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" },
        { outcome: "refused", url: "https://keespecs.xyz/api/x", host: "keespecs.xyz", priceUsdc: "0.010000" },
      ],
    }),
  );
  const entries = readKeetaPayPlan(file, day);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.plannedPriceAtomic, "10000");
  rmSync(dir, { recursive: true });
});

test("keeta: loadKeetaAccount rejects a key file that is not mode 600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-mode-"));
  const acct = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 12).toString("hex"), 0);
  const addr = acct.publicKeyString.toString();
  writeFileSync(join(dir, "keeta-payer.json"), JSON.stringify({ seed: Buffer.alloc(32, 12).toString("hex"), index: 0 }) + "\n");
  chmodSync(join(dir, "keeta-payer.json"), 0o644);
  await assert.rejects(() => loadKeetaAccount(join(dir, "keeta-payer.json"), addr), /mode 600/);
  rmSync(dir, { recursive: true });
});

const KEY_TRAP_STDERR = "key file is not valid JSON";

test("keeta-lane --pay without --plan exits 2", () => {
  const keyDir = mkdtempSync(join(tmpdir(), "keeta-exit2-"));
  writeFileSync(join(keyDir, "keeta-payer.json"), "{{not json");
  chmodSync(join(keyDir, "keeta-payer.json"), 0o600);
  const r = spawnSync(TSX, [join(ROOT, "scripts", "keeta-lane.ts"), "--pay"], {
    env: { ...process.env, VET402_KEETA_PAY: "1", VET402_KEETA_KEY_DIR: keyDir },
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(!r.stderr.includes(KEY_TRAP_STDERR), r.stderr);
  rmSync(keyDir, { recursive: true });
});

test("keeta-lane --pay refuses keeta-payer.pub when it is not mode 600", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "keeta-pubmode-"));
  const keyDir = mkdtempSync(join(tmpdir(), "keeta-pubmode-k-"));
  const planDir = mkdtempSync(join(tmpdir(), "keeta-pubmode-p-"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(resultsDir, `keeta-${day}.json`), JSON.stringify(emptyKeetaResult(day, "keeta_x")));
  const acct = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 14).toString("hex"), 0);
  const addr = acct.publicKeyString.toString();
  writeFileSync(join(keyDir, "keeta-payer.pub"), `${addr}\n`);
  chmodSync(join(keyDir, "keeta-payer.pub"), 0o644);
  writeFileSync(join(keyDir, "keeta-payer.json"), JSON.stringify({ seed: Buffer.alloc(32, 14).toString("hex"), index: 0 }) + "\n");
  chmodSync(join(keyDir, "keeta-payer.json"), 0o600);
  const plan = join(planDir, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T00:00:00.000Z",
      rows: [{ outcome: "would_pay", url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" }],
    }),
  );
  const r = spawnSync(TSX, [join(ROOT, "scripts", "keeta-lane.ts"), "--pay", "--plan", plan], {
    env: { ...process.env, VET402_KEETA_PAY: "1", VET402_KEETA_KEY_DIR: keyDir, VET402_KEETA_RESULTS_DIR: resultsDir },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /keeta-payer\.pub must be mode 600/);
  rmSync(resultsDir, { recursive: true });
  rmSync(keyDir, { recursive: true });
  rmSync(planDir, { recursive: true });
});

test("keeta-lane --pay releases keeta.lock when the result file was written for another payer", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "keeta-results-"));
  const keyDir = mkdtempSync(join(tmpdir(), "keeta-keys-"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(resultsDir, `keeta-${day}.json`),
    JSON.stringify({ kind: "vet402-remeasure", version: 1, chain: "keeta", network: KEETA_CAIP2, date: day, payer: "keeta_other", note: "n", runs: [], rows: [] }),
  );
  const acct = KeetaNet.lib.Account.fromSeed(Buffer.alloc(32, 13).toString("hex"), 0);
  const addr = acct.publicKeyString.toString();
  writeFileSync(join(keyDir, "keeta-payer.pub"), `${addr}\n`);
  writeFileSync(join(keyDir, "keeta-payer.json"), JSON.stringify({ seed: Buffer.alloc(32, 13).toString("hex"), index: 0 }) + "\n");
  chmodSync(join(keyDir, "keeta-payer.json"), 0o600);
  const planDir = mkdtempSync(join(tmpdir(), "keeta-pland-"));
  const plan = join(planDir, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      kind: "vet402-remeasure-dry-run",
      chain: "keeta",
      createdAt: day + "T00:00:00.000Z",
      rows: [{ outcome: "would_pay", url: "https://keespecs.xyz/api/pulse", host: "keespecs.xyz", priceUsdc: "0.010000" }],
    }),
  );
  const lock = keetaLockPath(resultsDir);
  const r = spawnSync(TSX, [join(ROOT, "scripts", "keeta-lane.ts"), "--pay", "--plan", plan], {
    env: {
      ...process.env,
      VET402_KEETA_PAY: "1",
      VET402_KEETA_KEY_DIR: keyDir,
      VET402_KEETA_RESULTS_DIR: resultsDir,
    },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(lock));
  rmSync(resultsDir, { recursive: true });
  rmSync(keyDir, { recursive: true });
  rmSync(planDir, { recursive: true });
});

test("keeta: freeTrial buy sends payment on the first GET when unpaid would be 200", async () => {
  const budget = new KeetaBudget(null);
  let paidGets = 0;
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
    maxTimeoutSeconds: 300,
  });
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      const hdr = (init?.headers ?? {}) as Record<string, string>;
      if (hdr["payment-signature"] || hdr["PAYMENT-SIGNATURE"]) {
        paidGets += 1;
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response('{"free":true}', { status: 200, headers: { "content-type": "application/json" } });
    },
    payer: "keeta_p",
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash: "bh_ft", blockBase64: "eA==" }),
    reader: {
      getBlock: async () => ({
        account: "keeta_p",
        network: "0x5382",
        operations: [{ type: "SEND", to: KTA_PAYTO, amount: "1000", token: KEETA_USDC }],
      }),
      onLedger: async () => true,
      destroy: async () => undefined,
    },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    {
      url: "https://kta-oracle.top/network/pulse",
      host: "kta-oracle.top",
      expectedPayTo: KTA_PAYTO,
      freeTrial: true,
      catalogAccept,
      plannedPriceAtomic: "1000",
    },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(paidGets, 1);
  assert.equal(out.row.outcome, "sent");
  assert.equal(out.row.settled, true);
});

test("keeta: freeTrial pay-first with ledger notFound and 200 body keeps commit (keeta_tx_not_found)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-free-"));
  const budget = new KeetaBudget(join(dir, "b.json"), KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, "2026-11-16");
  const url = "https://kta-oracle.top/network/pulse";
  const key = keetaBudgetKey("2026-11-16", url);
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
  });
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response('{"trial":true}', { status: 200 });
      }
      return new Response('{"sandbox":true}', { status: 200 });
    },
    payer: "keeta_p",
    createPayment: async () => ({ headers: { "payment-signature": "x" }, blockHash: "bh_free", blockBase64: "eA==" }),
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    { url, host: "kta-oracle.top", expectedPayTo: KTA_PAYTO, freeTrial: true, catalogAccept, plannedPriceAtomic: "1000" },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(out.row.outcome, "sent");
  assert.match(out.stop ?? "", /^keeta_tx_not_found:/);
  const again = budget.reserve(1000n, key, 1_000_000n);
  assert.ok("refused" in again && again.refused === "already_bought");
  rmSync(dir, { recursive: true });
});

test("keeta: freeTrial unpaid 200 with empty body is free_response without signing", async () => {
  const budget = new KeetaBudget(null);
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
  });
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async () => new Response("", { status: 200 }),
    payer: "keeta_p",
    createPayment: async () => {
      signed++;
      return { headers: {}, blockHash: "h", blockBase64: "eA==" };
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    { url: "https://kta-oracle.top/network/pulse", host: "kta-oracle.top", expectedPayTo: KTA_PAYTO, freeTrial: true, catalogAccept },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(out.row.outcome, "free_response");
  assert.equal(signed, 0);
});

test("keeta: freeTrial pay-first paid GET 402 does not sign twice and keeps commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-402paid-"));
  const budget = new KeetaBudget(join(dir, "b.json"), KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, "2026-11-16");
  const url = "https://kta-oracle.top/network/pulse";
  const key = keetaBudgetKey("2026-11-16", url);
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
  });
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        return new Response('{"trial":true}', { status: 200 });
      }
      return new Response("{}", { status: 402 });
    },
    payer: "keeta_p",
    createPayment: async () => {
      signed++;
      return { headers: { "payment-signature": "x" }, blockHash: "bh_402paid", blockBase64: "eA==" };
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    { url, host: "kta-oracle.top", expectedPayTo: KTA_PAYTO, freeTrial: true, catalogAccept, plannedPriceAtomic: "1000" },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(signed, 1);
  assert.equal(out.row.outcome, "refused");
  assert.equal(out.row.reason, "paid_get_402");
  assert.ok(!out.stop);
  const again = budget.reserve(1000n, key, 1_000_000n);
  assert.ok("refused" in again && again.refused === "already_bought");
  rmSync(dir, { recursive: true });
});

test("keeta: freeTrial unpaid 404 does not sign", async () => {
  const budget = new KeetaBudget(null);
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
  });
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async () => new Response("{}", { status: 404 }),
    payer: "keeta_p",
    createPayment: async () => {
      signed++;
      return { headers: {}, blockHash: "h", blockBase64: "eA==" };
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    { url: "https://kta-oracle.top/network/pulse", host: "kta-oracle.top", expectedPayTo: KTA_PAYTO, freeTrial: true, catalogAccept },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(out.row.reason, "no_keeta_accept");
  assert.equal(signed, 0);
});

test("keeta: freeTrial refuses payTo mismatch against KEETA_SELLERS", async () => {
  const budget = new KeetaBudget(null);
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
  });
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async () => new Response("{}", { status: 200 }),
    payer: "keeta_p",
    createPayment: async () => {
      signed++;
      return { headers: {}, blockHash: "h", blockBase64: "eA==" };
    },
    reader: { getBlock: async () => null, onLedger: async () => false, destroy: async () => undefined },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    {
      url: "https://kta-oracle.top/network/pulse",
      host: "kta-oracle.top",
      expectedPayTo: "keeta_wrong",
      freeTrial: true,
      catalogAccept,
    },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(out.row.reason, "payto_mismatch");
  assert.equal(signed, 0);
});

test("keeta: freeTrial falls back to the 402 path when unpaid GET returns 402", async () => {
  const budget = new KeetaBudget(null);
  const catalogAccept = normalizeKeetaAccept({
    scheme: "exact",
    network: KEETA_CAIP2,
    amount: "1000",
    asset: KEETA_USDC,
    payTo: KTA_PAYTO,
  });
  let signed = 0;
  const deps: KeetaBuyDeps = {
    fetch: async (_u, init) => {
      if (!init || !("headers" in init) || !(init.headers as Record<string, string>)["payment-signature"]) {
        const body402 = { x402Version: 2, accepts: [{ scheme: "exact", network: KEETA_CAIP2, amount: "1000", asset: KEETA_USDC, payTo: KTA_PAYTO }] };
        return new Response(JSON.stringify(body402), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response('{"ok":true}', { status: 200 });
    },
    payer: "keeta_p",
    createPayment: async () => {
      signed++;
      return { headers: { "payment-signature": "x" }, blockHash: "bh_402", blockBase64: "eA==" };
    },
    reader: {
      getBlock: async (h) =>
        h === "bh_402"
          ? { account: "keeta_p", network: "0x5382", operations: [{ type: "SEND", to: KTA_PAYTO, amount: "1000", token: KEETA_USDC }] }
          : null,
      onLedger: async (h) => h === "bh_402",
      destroy: async () => undefined,
    },
    budget,
    balance: async () => 1_000_000n,
    now: () => new Date("2026-11-16T12:00:00Z"),
    sleep: async () => undefined,
  };
  const out = await buyKeetaOne(
    {
      url: "https://kta-oracle.top/network/pulse",
      host: "kta-oracle.top",
      expectedPayTo: KTA_PAYTO,
      freeTrial: true,
      catalogAccept,
      plannedPriceAtomic: "1000",
    },
    deps,
    "2026-11-16",
    1,
  );
  assert.equal(signed, 1);
  assert.equal(out.row.outcome, "sent");
});

test("keeta-lane --pay without VET402_KEETA_PAY=1 exits 6 and reads no key", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeta-exit-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "keeta-payer.json"), "{{not json");
  chmodSync(join(dir, "keeta-payer.json"), 0o600);
  const r = spawnSync(TSX, [join(ROOT, "scripts", "keeta-lane.ts"), "--pay"], {
    env: { ...process.env, VET402_KEETA_KEY_DIR: dir, VET402_KEETA_PAY: undefined },
    encoding: "utf8",
  });
  assert.equal(r.status, 6);
  assert.ok(!r.stderr.includes(KEY_TRAP_STDERR), r.stderr);
  rmSync(dir, { recursive: true });
});