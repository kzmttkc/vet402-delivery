/**
 * End to end over real sockets on 127.0.0.1: a mock seller HTTP server, the proxy buy HTTP server
 * (src/proxy-buy/http.ts), and an agent that only speaks HTTP to vet402. The chain and the facilitator
 * are the fakes from proxy-buy-fakes.ts. No request leaves this machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { signerFor } from "../src/tempo/chain.js";
import { startServer, writeResponse } from "../src/proxy-buy/http.js";
import { agent, ORIGIN, S_URL, solRig, T_RECEIVE, T_URL, tAgent, transferTx, tRig } from "./proxy-buy-fakes.js";

/** A mock seller behind a real socket. The rig's seller logic answers; the host is carried in a header. */
async function sellerOverHttp(): Promise<{ server: Server; wrap: (f: typeof fetch) => typeof fetch; hits: () => number }> {
  const holder: { f: typeof fetch | null } = { f: null };
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const url = `https://${headers.get("x-seller-host")}${req.url}`;
    headers.delete("x-seller-host");
    holder.f!(url, { method: req.method, headers })
      .then((r) => writeResponse(res, r))
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const wrap = (f: typeof fetch) => {
    holder.f = f;
    return (async (u: string | URL, init?: RequestInit) => {
      const url = new URL(String(u));
      const h = new Headers(init?.headers);
      h.set("x-seller-host", url.host);
      return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers: h });
    }) as unknown as typeof fetch;
  };
  return { server, wrap, hits: () => hits };
}

async function proxyOverHttp(buy: Parameters<typeof startServer>[0]): Promise<{ server: Server; base: string }> {
  const server = await startServer(buy, { port: 0, origin: ORIGIN });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const q = (target: string) => `/v1/buy?url=${encodeURIComponent(target)}`;

test("e2e solana: agent -> vet402 (HTTP) -> seller (HTTP): 402, pay, answer, record", async () => {
  const seller = await sellerOverHttp();
  const r = solRig({ wrapSeller: seller.wrap });
  const proxy = await proxyOverHttp(r.buy);
  try {
    const first = await fetch(`${proxy.base}${q(S_URL)}`);
    assert.equal(first.status, 402);
    const pr = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
    const req = pr.accepts[0]!;
    assert.equal(req.amount, "15000");
    const tx = await transferTx(agent, String(req.extra?.feePayer), req.payTo, BigInt(req.amount));
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: req, payload: { transaction: tx } } as PaymentPayload);
    const paid = await fetch(`${proxy.base}${q(S_URL)}`, { headers: { "payment-signature": header } });
    assert.equal(paid.status, 200);
    assert.equal(await paid.text(), r.seller.paidBody);
    assert.equal(r.fac.settles, 1);
    assert.equal(r.sellerPays.length, 1);
    assert.ok(seller.hits() >= 4, `seller hits ${seller.hits()}`); // 402 read x3 (agent quote, paid re-read, payOne) + the paid request
    const recPath = new URL(paid.headers.get("x-vet402-record")!).pathname;
    const rec = (await (await fetch(`${proxy.base}${recPath}`)).json()) as Record<string, any>;
    assert.equal(rec.outcome, "delivered");
    // the same payment again over HTTP
    assert.equal((await fetch(`${proxy.base}${q(S_URL)}`, { headers: { "payment-signature": header } })).status, 409);
    assert.equal(r.fac.settles, 1);
  } finally {
    r.books.release();
    await close(proxy.server);
    await close(seller.server);
  }
});

test("e2e solana: the seller goes down after being paid -> 502 with the record, over HTTP", async () => {
  const seller = await sellerOverHttp();
  const r = solRig({ wrapSeller: seller.wrap, seller: { paidStatus: 503, paidBody: "maintenance" } });
  const proxy = await proxyOverHttp(r.buy);
  try {
    const first = await fetch(`${proxy.base}${q(S_URL)}`);
    const pr = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
    const req = pr.accepts[0]!;
    const tx = await transferTx(agent, String(req.extra?.feePayer), req.payTo, BigInt(req.amount));
    const header = encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: req, payload: { transaction: tx } } as PaymentPayload);
    const paid = await fetch(`${proxy.base}${q(S_URL)}`, { headers: { "payment-signature": header } });
    assert.equal(paid.status, 502);
    const j = (await paid.json()) as Record<string, any>;
    assert.equal(j.error, "not_delivered");
    assert.equal(j.sellerStatus, 503);
    assert.equal(j.refund, "none");
  } finally {
    r.books.release();
    await close(proxy.server);
    await close(seller.server);
  }
});

test("e2e tempo: agent -> vet402 (HTTP, MPP) -> seller (HTTP, MPP): challenge, pull credential, answer", async () => {
  const seller = await sellerOverHttp();
  const r = tRig({ wrapSeller: seller.wrap });
  const proxy = await proxyOverHttp(r.buy);
  try {
    const first = await fetch(`${proxy.base}${q(T_URL)}`);
    assert.equal(first.status, 402);
    const id = /id="([^"]+)"/.exec(first.headers.get("www-authenticate")!)![1]!;
    const { credential } = await signerFor(tAgent, r.rpc).credentialFor(first, id, T_RECEIVE);
    const paid = await fetch(`${proxy.base}${q(T_URL)}`, { headers: { authorization: credential } });
    assert.equal(paid.status, 200, await paid.clone().text());
    assert.deepEqual(Buffer.from(await paid.arrayBuffer()), r.seller.paidBody);
    assert.equal(r.chain.broadcasts, 1);
    assert.equal(r.seller.paidRequests, 1);
  } finally {
    await close(proxy.server);
    await close(seller.server);
  }
});
