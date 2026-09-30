/**
 * Read again, on the chain's receipt RPC, the settlements a lane run could not confirm ("unconfirmed":
 * a settlement tx was named but its receipt was not read). Read-only: nothing is signed or sent.
 *
 *   npx tsx scripts/evm-reverify.ts --lane base-compare
 *
 * Writes results/evm/<lane>-reverify.jsonl: one line per re-read record, the original record with the
 * settlement read back (settledOnChain, settlementCheck, delivered) and reverifiedAt. The original
 * purchases file is not changed. scripts/evm-publish.ts reads the reverify file after the purchases, so the
 * later reading is the one shown.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { EVM_CHAINS, LANES, type LaneId } from "../src/evm/chains.js";
import { readUsdcTransfer } from "../src/evm/erc8004.js";
import { readPublicAddress } from "../src/evm/key.js";
import { reverifyRecord } from "../src/evm/settle-cause.js";

const argv = process.argv.slice(2);
const laneId = argv[argv.indexOf("--lane") + 1] as LaneId;
if (!(laneId in LANES)) throw new Error(`--lane ${Object.keys(LANES).join(" | ")}`);
const spec = EVM_CHAINS[LANES[laneId].chain];
const payer: Address = readPublicAddress();
const file = `results/evm/${laneId}-purchases.jsonl`;
if (!existsSync(file)) throw new Error(`no ${file}`);
const client = createPublicClient({ transport: http(process.env[spec.receiptRpcEnv] ?? spec.receiptRpc) }) as PublicClient;
if ((await client.getChainId()) !== spec.chainId) throw new Error("receipt RPC chainId mismatch");
const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const out: string[] = [];
const tally: Record<string, number> = {};
for (const r of rows) {
  if (r.outcome !== "sent" || r.settledOnChain === true || !r.settlementTx || !String(r.settlementCheck ?? "").startsWith("not verified: ")) continue;
  let proof: { ok: boolean; from?: string; reason?: string };
  try {
    proof = await readUsdcTransfer(client, r.settlementTx as Hex, { to: r.payTo as Address, amountUnits: r.amountAtomic, asset: spec.asset, from: payer });
  } catch (err) {
    proof = { ok: false, reason: `receipt unreadable: ${(err as Error).message.split("\n")[0]!.slice(0, 80)}` };
  }
  const next = { ...reverifyRecord(r, proof, payer), reverifiedAt: new Date().toISOString() };
  const k = next.settledOnChain ? (next.delivered ? "settled, answer" : "settled, no answer") : `still not verified: ${proof.reason}`;
  tally[k] = (tally[k] ?? 0) + 1;
  out.push(JSON.stringify(next));
}
writeFileSync(`results/evm/${laneId}-reverify.jsonl`, out.join("\n") + (out.length ? "\n" : ""));
console.log(JSON.stringify({ lane: laneId, receiptRpc: process.env[spec.receiptRpcEnv] ?? spec.receiptRpc, reread: out.length, tally }, null, 2));
