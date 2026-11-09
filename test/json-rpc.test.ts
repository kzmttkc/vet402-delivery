/**
 * src/chain.ts jsonRpc: which failures are tried again (2026-11-09: one anchor read timed out and the records run
 * halted) and which are not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonRpc } from "../src/chain.js";

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

function fake(steps: (() => Response)[]) {
  let calls = 0;
  const f = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls++;
    return step();
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
}

test("jsonRpc: a timeout, a dropped connection and a 503 are tried again, then the answer is returned", async () => {
  const { f, calls } = fake([
    () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
    () => { throw new TypeError("fetch failed"); },
    () => new Response("busy", { status: 503 }),
    () => ok(42),
  ]);
  assert.equal(await jsonRpc("https://rpc.example", f, 0)("getSlot", []), 42);
  assert.equal(calls(), 4);
});

test("jsonRpc: an answer with a JSON-RPC error is not tried again", async () => {
  const { f, calls } = fake([() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Transaction already processed" } }), { status: 200 })]);
  await assert.rejects(jsonRpc("https://rpc.example", f, 0)("sendTransaction", []), /rpc sendTransaction: Transaction already processed/);
  assert.equal(calls(), 1);
});

test("jsonRpc: four failed tries give up with the last reason", async () => {
  const { f, calls } = fake([() => { throw new TypeError("fetch failed"); }]);
  await assert.rejects(jsonRpc("https://rpc.example", f, 0)("getBalance", []), /rpc getBalance: fetch failed/);
  assert.equal(calls(), 4);
  const r = fake([() => new Response("slow down", { status: 429 })]);
  await assert.rejects(jsonRpc("https://rpc.example", r.f, 0)("getBalance", []), /rpc getBalance: rate limited/);
  assert.equal(r.calls(), 4);
});
