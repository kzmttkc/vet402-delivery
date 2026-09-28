/**
 * ERC-8004 giveFeedback on Base for each delivered purchase, from the address that paid (0x9B59).
 *
 *   npx tsx scripts/base-feedback.ts --dry-run [--input results/base-buy-dryrun.json]   (simulate only)
 *   VET402_BASE_WRITE=yes npx tsx scripts/base-feedback.ts --write                      (reads results/base-purchases.jsonl)
 *
 * feedbackURI = data: URI of the feedback file; proofOfPayment = that purchase's Base settlement tx.
 * --write refuses: dry-run records, anything not delivered + settled on chain, payTo != agentWallet,
 * submitter is owner/operator, the agent already has feedback from this address, a tx already written
 * (results/base-feedback-ledger.json), a failed simulate, or too little ETH.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { BuyRecord } from "../src/evm/base-buy.js";
import { feedbackEligibility, toFeedbackInput } from "../src/evm/base-feedback.js";
import { buildGiveFeedbackArgs, CHAINS, preflight, reputationAbi, simulateGiveFeedback, verifyDataUri } from "../src/evm/erc8004.js";
import { loadEvmAccount, readPublicAddress } from "../src/evm/key.js";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
if (write && argv.includes("--dry-run")) throw new Error("choose one of --dry-run / --write");
if (write && process.env.VET402_BASE_WRITE !== "yes") throw new Error("--write also needs VET402_BASE_WRITE=yes (set only after the independent review)");
const inputArg = argv.includes("--input") ? argv[argv.indexOf("--input") + 1] : undefined;
if (write && inputArg) throw new Error("--write reads only results/base-purchases.jsonl");

const LEDGER = "results/base-feedback-ledger.json";
const submitter = readPublicAddress();
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com") }) as PublicClient;

function loadRecords(): BuyRecord[] {
  if (inputArg) return (JSON.parse(readFileSync(inputArg, "utf8")) as { records: BuyRecord[] }).records;
  if (!existsSync("results/base-purchases.jsonl")) return [];
  return readFileSync("results/base-purchases.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as BuyRecord);
}
const ledger: Record<string, { agentId: string; feedbackTx: string; at: string }> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};

const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const out = [];
for (const r of loadRecords()) {
  const el = feedbackEligibility(r, submitter, { allowDryRunRecord: !write });
  if (!el.ok) {
    out.push({ agentId: r.agentId, resource: r.resource, skipped: el.reason });
    continue;
  }
  const input = toFeedbackInput(r, submitter, createdAt);
  const { args, fileBytes } = buildGiveFeedbackArgs(input);
  const pf = await preflight(client, input);
  const sim = await simulateGiveFeedback(client, input, args);
  const row = {
    agentId: r.agentId,
    resource: r.resource,
    purchaseTx: input.purchase.txHash,
    placeholderTx: el.placeholder,
    sellerBinding: pf.sellerBinding,
    clientIsOwnerOrOperator: pf.clientIsOwnerOrOperator,
    lastIndexBefore: pf.lastIndexBefore.toString(),
    feedbackFileBytes: fileBytes.length,
    dataUriRoundTrip: verifyDataUri(args.feedbackURI, args.feedbackHash).ok,
    simulateOk: sim.simulateOk,
    revertReason: sim.revertReason,
    gas: sim.gas?.toString() ?? null,
    costEthAtMaxFee: sim.costWeiAtMaxFee !== null ? formatEther(sim.costWeiAtMaxFee) : null,
    ethBalance: formatEther(sim.fromBalanceWei),
    written: null as null | { tx: string; status: string },
    refused: null as null | string,
  };
  if (write) {
    const why =
      el.placeholder ? "placeholder record"
      : pf.sellerBinding !== "agentWallet" ? `sellerBinding ${pf.sellerBinding}`
      : pf.clientIsOwnerOrOperator !== false ? "submitter is owner/operator"
      : pf.lastIndexBefore > 0n ? "agent already has feedback from this address"
      : ledger[input.purchase.txHash] ? "this purchase tx was already written"
      : !sim.simulateOk || sim.gas === null ? `simulate failed: ${sim.revertReason}`
      : sim.costWeiAtMaxFee === null || sim.fromBalanceWei < (sim.costWeiAtMaxFee * 3n) / 2n ? "ETH balance below 1.5x the max-fee cost"
      : null;
    if (why || sim.gas === null) {
      row.refused = why ?? "no gas estimate";
    } else {
      const account = loadEvmAccount();
      const wallet = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com") });
      const { request } = await client.simulateContract({
        account,
        address: CHAINS.base.reputationRegistry,
        abi: reputationAbi,
        functionName: "giveFeedback",
        args: [args.agentId, args.value, args.valueDecimals, args.tag1, args.tag2, args.endpoint, args.feedbackURI, args.feedbackHash],
      });
      const tx = await wallet.writeContract({ ...request, gas: (sim.gas * 12n) / 10n });
      ledger[input.purchase.txHash] = { agentId: r.agentId, feedbackTx: tx, at: new Date().toISOString() };
      writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
      const rc = await client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      row.written = { tx, status: rc.status };
    }
  }
  out.push(row);
}
const doc = { generatedAt: createdAt, mode: write ? "write" : "dry-run", submitter, registry: CHAINS.base.reputationRegistry, items: out };
if (!write) writeFileSync("results/base-feedback-dryrun.json", JSON.stringify(doc, null, 2) + "\n");
console.log(JSON.stringify(doc, null, 2));
