/**
 * Read from the chain whether each purchase of an EVM lane settled (src/evm/chaincheck.ts). Read-only:
 * eth_getLogs and eth_getBlockByNumber; nothing is signed or sent.
 *
 *   npx tsx scripts/evm-chaincheck.ts --lane arbitrum | robinhood | base-compare
 *
 * Writes results/evm/<lane>-chaincheck.jsonl (src/evm/chaincheck-run.ts). scripts/evm-publish.ts reads that file
 * last and refuses to publish a sent purchase the chain check has not decided.
 * Exit code 1 when a transfer out of the payer has no purchase, or a purchase is ambiguous or still pending.
 */
import type { Address } from "viem";
import { LANES, type LaneId } from "../src/evm/chains.js";
import { checkLaneFiles } from "../src/evm/chaincheck-run.js";
import { readPublicAddress } from "../src/evm/key.js";

const argv = process.argv.slice(2);
const laneId = argv[argv.indexOf("--lane") + 1] as LaneId;
if (!(laneId in LANES)) throw new Error(`--lane ${Object.keys(LANES).join(" | ")}`);
const payer: Address = readPublicAddress();
const out = await checkLaneFiles(laneId, payer);
const s = out.summary;
console.log(JSON.stringify({ lane: out.lane, rpc: out.rpc, sent: out.sent, transfersOut: out.transfersOut, tally: out.tally, added: s?.added ?? [], ambiguous: s?.ambiguous ?? [], pending: s?.pending ?? [], unmatched: s?.unmatched ?? [] }, null, 2));
if (out.failed) process.exitCode = 1;
