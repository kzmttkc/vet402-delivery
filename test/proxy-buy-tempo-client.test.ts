/**
 * The agent-side Tempo client (src/proxy-buy/tempo-client.ts, scripts/proxy-buy-tempo-client.ts): it signs only a
 * challenge naming vet402's receive wallet, chain 4217, USDC.e and a total within the ceiling, and a dry run never
 * sends the paid request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signerFor, type Signer } from "../src/tempo/chain.js";
import { PAYER_ADDRESS as TEMPO_CENSUS_PAYER } from "../src/tempo/constants.js";
import { buyOnTempo, type TempoClientDeps } from "../src/proxy-buy/tempo-client.js";
import { ORIGIN, T_RECEIVE, T_URL, tAgent, tRig, type TRig } from "./proxy-buy-fakes.js";

type J = Record<string, any>;

/** The rig's handler as the client's fetch; counts paid requests. And a signer that counts signatures. */
function deps(r: TRig, o: { rewrite?: (req: J) => J; account?: ReturnType<typeof privateKeyToAccount> } = {}) {
  const seen = { quotes: 0, paid: 0, signs: 0 };
  const fetchImpl: TempoClientDeps["fetchImpl"] = async (url, init) => {
    const req = new Request(url, init);
    if (req.headers.get("authorization")) seen.paid++;
    else seen.quotes++;
    const res = await r.buy.handle(req);
    if (!o.rewrite || res.status !== 402 || req.headers.get("authorization")) return res;
    // the same 402 with its tempo request changed (the HMAC no longer matches: the client must refuse before signing)
    const www = res.headers.get("www-authenticate")!;
    const changed = www.replace(/request="([^"]+)"/, (_m, b64: string) => {
      const j = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as J;
      return `request="${Buffer.from(JSON.stringify(o.rewrite!(j))).toString("base64url")}"`;
    });
    const h = new Headers(res.headers);
    h.set("www-authenticate", changed);
    return new Response(await res.arrayBuffer(), { status: 402, headers: h });
  };
  const inner = signerFor(o.account ?? tAgent, r.rpc);
  const signer: Signer = {
    address: inner.address,
    credentialFor: async (res, id, rcpt) => {
      seen.signs++;
      return inner.credentialFor(res, id, rcpt);
    },
  };
  return { seen, d: { fetchImpl, signer } };
}

const opts = (o: Partial<Parameters<typeof buyOnTempo>[0]> = {}) => ({ origin: ORIGIN, target: T_URL, expectedReceive: T_RECEIVE, maxAtomic: 20_000n, ...o });

test("tempo client: the dry run (default) signs and checks the credential, and sends nothing", async () => {
  const r = await tRig();
  const { seen, d } = deps(r);
  const out = await buyOnTempo(opts(), d);
  assert.equal(out.ok, true);
  assert.equal(out.sent, false);
  if (out.ok && !out.sent) {
    assert.equal(out.amountAtomic, "13000"); // seller 0.008 + fee 0.005
    assert.equal(out.recipient.toLowerCase(), T_RECEIVE.toLowerCase());
    assert.match(out.txHash, /^0x[0-9a-f]{64}$/);
    assert.ok(Object.values(out).every((v) => typeof v !== "string" || v.length <= 66), "the signed transaction is not in the result");
  }
  assert.deepEqual(seen, { quotes: 1, paid: 0, signs: 1 });
  assert.equal(r.chain.broadcasts, 0);
  assert.equal(r.seller.paidRequests, 0);
});

test("tempo client: --send pays and hands back the seller's answer", async () => {
  const r = await tRig();
  const { seen, d } = deps(r);
  const out = await buyOnTempo(opts({ send: true }), d);
  assert.equal(out.ok && out.sent, true);
  if (out.ok && out.sent) {
    assert.equal(out.status, 200);
    assert.deepEqual([...out.body], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    assert.ok(out.headers["x-vet402-record"]);
    assert.equal(out.headers["x-vet402-customer-tx"]?.toLowerCase(), out.txHash);
  }
  assert.deepEqual(seen, { quotes: 1, paid: 1, signs: 1 });
});

test("tempo client: another recipient, a total over the ceiling, another chain, another currency -> refused before signing", async () => {
  const cases: [string, Partial<Parameters<typeof buyOnTempo>[0]>, ((j: J) => J) | undefined, RegExp][] = [
    ["recipient", {}, (j) => ({ ...j, recipient: privateKeyToAccount(generatePrivateKey()).address }), /^recipient_/],
    ["expected receive differs", { expectedReceive: privateKeyToAccount(generatePrivateKey()).address }, undefined, /^recipient_/],
    ["over the ceiling", { maxAtomic: 12_999n }, undefined, /^amount_13000_over_max_12999$/],
    ["chain", {}, (j) => ({ ...j, methodDetails: { ...(j.methodDetails ?? {}), chainId: 42431 } }), /^chain_42431_not_4217$/],
    ["currency", {}, (j) => ({ ...j, currency: "0x20c0000000000000000000000000000000000000" }), /^currency_/],
    ["sponsored", {}, (j) => ({ ...j, methodDetails: { ...(j.methodDetails ?? {}), feePayer: true } }), /^sponsored_fee_not_expected$/],
  ];
  for (const [name, o, rewrite, reason] of cases) {
    const r = await tRig();
    const { seen, d } = deps(r, rewrite ? { rewrite } : {});
    const out = await buyOnTempo(opts({ ...o, send: true }), d);
    assert.equal(out.ok, false, name);
    if (!out.ok) {
      assert.equal(out.stage, "guard", name);
      assert.match(out.reason, reason, name);
      assert.equal(out.signed, false, name);
    }
    assert.equal(seen.signs, 0, `${name}: nothing signed`);
    assert.equal(seen.paid, 0, `${name}: nothing sent`);
    assert.equal(r.chain.broadcasts, 0, name);
  }
});

test("tempo client: no Tempo offer, or an agent that is one of vet402's wallets -> refused, nothing signed", async () => {
  const off = await tRig({ tempoEnabled: false });
  const a = deps(off);
  const out = await buyOnTempo(opts({ send: true }), a.d);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.stage, "quote");
  assert.deepEqual([a.seen.signs, a.seen.paid], [0, 0]);

  const r = await tRig();
  for (const own of [T_RECEIVE, TEMPO_CENSUS_PAYER]) {
    const { seen, d } = deps(r);
    const res = await buyOnTempo(opts({ send: true }), { ...d, signer: { ...d.signer, address: own } });
    assert.deepEqual(res, { ok: false, stage: "guard", reason: "agent_is_a_vet402_wallet", signed: false, sent: false });
    assert.deepEqual([seen.quotes, seen.signs, seen.paid], [0, 0, 0]);
  }
  // vet402's proxy payer, passed by the script as notAgent (VET402_PROXY_TEMPO_PAYER)
  const payer = privateKeyToAccount(generatePrivateKey()).address;
  const { seen, d } = deps(r);
  const res = await buyOnTempo(opts({ send: true, notAgent: [payer.toLowerCase()] }), { ...d, signer: { ...d.signer, address: payer } });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "agent_is_a_vet402_wallet");
  assert.deepEqual([seen.quotes, seen.signs, seen.paid], [0, 0, 0]);
});
