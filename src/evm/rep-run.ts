/**
 * Plan, simulate and (only with --send) write vet402's ERC-8004 feedback on one EVM chain.
 * Chain reads, signing and broadcast come in through RepDeps, so tests run against fakes.
 * The only signing path is send(); plan() and simulate() read and call eth_call / eth_estimateGas.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToBytes,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { arbitrum, base, robinhood, tempo } from "viem/chains";
import { sha256Hex, type LoadedRecords } from "../receipt/publish.js";
import type { Observation } from "../receipt/types.js";
import { fetchRecord, recordVerifies, type Fetched } from "../solana-feedback/records.js";
import { identityAbi, REP_REGISTRIES, reputationAbi } from "./erc8004.js";
import {
  chooseEvmAgent,
  evmRefusals,
  evmValues,
  feeRefusal,
  groupEvmByPayTo,
  MAX_WRITES_PER_RUN,
  outcomeOf,
  recordUri,
  tempoFeeAtomic,
  type AgentEntry,
  type EvmGateChecks,
  type EvmPurchase,
  type OutcomeSummary,
  type RepChainKey,
} from "./rep-plan.js";

// ---------- per-chain configuration ----------

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TEMPO_USDC_E: Address = "0x20C000000000000000000000b9537d11c60E8b50";

export interface RepChainConfig {
  key: RepChainKey;
  chainId: number;
  caip2: string;
  viemChain: Chain;
  rpc: string;
  /** For receipts of past purchases (Base's publicnode refuses old receipts without a token). Default: rpc. */
  receiptRpc?: string;
  /** Tokens a purchase may be paid in (the Transfer log's address). Empty: no purchase on this chain can pass. */
  purchaseAssets: Address[];
  /** How the write's fee is paid and the most one write may cost, in that unit. */
  fee: { kind: "native"; symbol: "ETH"; cap: bigint; opL1Oracle: boolean } | { kind: "tip20"; symbol: "USDC.e"; token: Address; cap: bigint };
  explorerTx: string;
}

/**
 * Caps per write. Base: the 7 writes of 2026-09-28 cost 1.37e12-1.48e12 wei each; cap 1e13 wei.
 * Arbitrum and Robinhood: ~250k gas at ~0.02-0.024 gwei (eth_estimateGas, 2026-09-30); cap 2e13 wei.
 * Tempo: ~2.14M gas (new storage slots cost more there) at 7.2e8 attodollars max fee = 1,542 microdollars; cap 5,000 (0.005 USDC.e).
 */
export function repChain(key: RepChainKey, env: NodeJS.ProcessEnv = process.env): RepChainConfig {
  const c = REP_REGISTRIES[key];
  switch (key) {
    case "base":
      return { key, chainId: c.chainId, caip2: c.caip2, viemChain: base, rpc: env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com", receiptRpc: env.BASE_RECEIPT_RPC_URL ?? "https://mainnet.base.org", purchaseAssets: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], fee: { kind: "native", symbol: "ETH", cap: 10_000_000_000_000n, opL1Oracle: true }, explorerTx: "https://basescan.org/tx/" };
    case "tempo":
      return { key, chainId: c.chainId, caip2: c.caip2, viemChain: tempo, rpc: env.TEMPO_RPC_URL ?? "https://rpc.tempo.xyz", purchaseAssets: [TEMPO_USDC_E], fee: { kind: "tip20", symbol: "USDC.e", token: TEMPO_USDC_E, cap: 5_000n }, explorerTx: "https://explore.tempo.xyz/tx/" };
    case "arbitrum":
      return { key, chainId: c.chainId, caip2: c.caip2, viemChain: arbitrum, rpc: env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc", purchaseAssets: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831"], fee: { kind: "native", symbol: "ETH", cap: 20_000_000_000_000n, opL1Oracle: false }, explorerTx: "https://arbiscan.io/tx/" };
    case "robinhood":
      // vet402 has no Robinhood Chain purchase yet; the payment token is named when there is one.
      return { key, chainId: c.chainId, caip2: c.caip2, viemChain: robinhood, rpc: env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com", purchaseAssets: [], fee: { kind: "native", symbol: "ETH", cap: 20_000_000_000_000n, opL1Oracle: false }, explorerTx: "https://explorer.mainnet.chain.robinhood.com/tx/" };
  }
}

// ---------- what the chain is asked ----------

export interface PurchaseCheck {
  status: "success" | "reverted" | "missing";
  finalized: boolean;
  transferMatches: boolean;
  detail: string;
}

export interface SimRead {
  ok: boolean;
  revertReason: string | null;
  gas: bigint | null;
  /** Cost at the node's max fee, in the fee unit (wei, or TIP-20 atomic). */
  costAtMax: bigint | null;
  /** Cost at the current gas price, same unit. */
  costNow: bigint | null;
  feeBalance: bigint | null;
  blockNumber: bigint;
}

export interface RepReader {
  chainId(): Promise<number>;
  indexAgents(): Promise<AgentEntry[]>;
  agentWallet(agentId: bigint): Promise<string | null>;
  isAuthorizedOrOwner(client: string, agentId: bigint): Promise<boolean | null>;
  lastIndex(agentId: bigint, client: string): Promise<bigint | null>;
  purchase(p: { tx: string; client: string; payTo: string; amountAtomic: string | null; assets: string[] }): Promise<PurchaseCheck>;
  simulate(from: string, data: Hex): Promise<SimRead>;
}

export interface RepSender {
  /** Sign locally; nothing leaves the machine. Returns the raw tx and its hash. */
  sign(data: Hex, gas: bigint): Promise<{ serialized: Hex; hash: Hex; from: string }>;
  broadcast(serialized: Hex): Promise<Hex>;
  wait(hash: Hex): Promise<"success" | "reverted" | "pending">;
}

const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const gasOracleAbi = parseAbi(["function getL1Fee(bytes _data) view returns (uint256)"]);
const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";

function shortError(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return m.split("\n")[0]!.slice(0, 300);
}

/** Viem-backed reader for one chain. */
export function chainReader(cfg: RepChainConfig): RepReader {
  const c = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpc, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  const rc = cfg.receiptRpc ? (createPublicClient({ chain: cfg.viemChain, transport: http(cfg.receiptRpc, { timeout: 30_000, retryCount: 2 }) }) as PublicClient) : c;
  const reg = REP_REGISTRIES[cfg.key];
  const feeTok = cfg.fee.kind === "tip20" ? { feeToken: cfg.fee.token } : {};
  // Only a revert of ownerOf means "no such agent". Any other error (rate limit, timeout) stops the run:
  // a wrong top id would give a partial index, and a partial index can make a shared payTo look unique.
  const exists = (id: bigint) =>
    c.readContract({ address: reg.identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [id] }).then(
      () => true,
      (e: unknown) => {
        if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return false;
        throw e;
      },
    );
  return {
    chainId: () => c.getChainId(),
    async indexAgents() {
      // agentIds are minted from 0 upward; find the top, then read every id (plus a tail for burned ids).
      let hi = 1n;
      while (await exists(hi)) hi *= 2n;
      let lo = hi / 2n;
      while (lo + 1n < hi) {
        const m = (lo + hi) / 2n;
        if (await exists(m)) lo = m;
        else hi = m;
      }
      const last = lo + 64n;
      const out: AgentEntry[] = [];
      const CHUNK = 500n;
      const chunks: bigint[] = [];
      for (let s = 0n; s <= last; s += CHUNK) chunks.push(s);
      const readChunk = async (s: bigint) => {
        const ids: bigint[] = [];
        for (let i = s; i < s + CHUNK && i <= last; i++) ids.push(i);
        const res = await c.multicall({
          multicallAddress: MULTICALL3,
          allowFailure: true,
          batchSize: 0,
          contracts: ids.flatMap((id) => [
            { address: reg.identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [id] } as const,
            { address: reg.identityRegistry, abi: identityAbi, functionName: "getAgentWallet", args: [id] } as const,
          ]),
        });
        return ids.map((id, i) => {
          const o = res[2 * i]!;
          const w = res[2 * i + 1]!;
          // an agent whose wallet did not read could hold the same payTo: stop rather than call a match unique
          if (o.status === "success" && w.status !== "success") throw new Error(`${cfg.key}: getAgentWallet(${id}) failed`);
          return { agentId: id, owner: o.status === "success" ? (o.result as string) : null, agentWallet: w.status === "success" ? (w.result as string) : null };
        });
      };
      for (let i = 0; i < chunks.length; i += 4) {
        const part = await Promise.all(chunks.slice(i, i + 4).map(readChunk));
        for (const p of part) out.push(...p.filter((a) => a.owner !== null));
      }
      return out;
    },
    agentWallet: (id) => c.readContract({ address: reg.identityRegistry, abi: identityAbi, functionName: "getAgentWallet", args: [id] }).then((x) => x as string, () => null),
    isAuthorizedOrOwner: (client, id) => c.readContract({ address: reg.identityRegistry, abi: identityAbi, functionName: "isAuthorizedOrOwner", args: [client as Address, id] }).then((x) => x as boolean, () => null),
    lastIndex: (id, client) => c.readContract({ address: reg.reputationRegistry, abi: reputationAbi, functionName: "getLastIndex", args: [id, client as Address] }).then((x) => x as bigint, () => null),
    async purchase(p) {
      // only "not found" means missing; any other read error stops the run (an RPC refusal is not a fact about the tx)
      const r = await rc.getTransactionReceipt({ hash: p.tx as Hex }).catch((e: unknown) => {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      });
      if (!r) return { status: "missing", finalized: false, transferMatches: false, detail: "no receipt" };
      const fin = await c.getBlock({ blockTag: "finalized" });
      const finalized = r.blockNumber <= fin.number;
      if (r.status !== "success") return { status: "reverted", finalized, transferMatches: false, detail: "reverted" };
      if (p.assets.length === 0) return { status: "success", finalized, transferMatches: false, detail: `no payment token configured for ${cfg.key}` };
      if (p.amountAtomic === null) return { status: "success", finalized, transferMatches: false, detail: "the input did not record the amount" };
      for (const log of r.logs) {
        if (!p.assets.some((a) => isAddressEqual(a as Address, log.address))) continue;
        try {
          const ev = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics });
          if (!isAddressEqual(ev.args.from, p.client as Address) || !isAddressEqual(ev.args.to, p.payTo as Address)) continue;
          if (ev.args.value !== BigInt(p.amountAtomic)) return { status: "success", finalized, transferMatches: false, detail: `transfer of ${ev.args.value}, recorded ${p.amountAtomic}` };
          return { status: "success", finalized, transferMatches: true, detail: `transfer ${p.amountAtomic} to the payTo in block ${r.blockNumber}` };
        } catch {
          /* not a Transfer */
        }
      }
      return { status: "success", finalized, transferMatches: false, detail: "no payment-token transfer from the writer to the payTo" };
    },
    async simulate(from, data) {
      const blockNumber = await c.getBlockNumber();
      const req = { account: from as Address, to: reg.reputationRegistry, data, blockNumber, ...feeTok } as Parameters<PublicClient["call"]>[0];
      let ok = false;
      let revertReason: string | null = null;
      let gas: bigint | null = null;
      try {
        await c.call(req);
        ok = true;
        gas = await c.estimateGas(req as Parameters<PublicClient["estimateGas"]>[0]);
      } catch (e) {
        revertReason = shortError(e);
        ok = false;
      }
      const [fees, price] = await Promise.all([c.estimateFeesPerGas().catch(() => null), c.getGasPrice().catch(() => null)]);
      const maxFee = fees?.maxFeePerGas ?? null;
      let costAtMax: bigint | null = null;
      let costNow: bigint | null = null;
      let feeBalance: bigint | null = null;
      if (cfg.fee.kind === "tip20") {
        if (gas !== null && maxFee !== null) costAtMax = tempoFeeAtomic(gas, maxFee);
        if (gas !== null && price !== null) costNow = tempoFeeAtomic(gas, price);
        // eth_getBalance on Tempo is a placeholder, not money: read the fee token itself.
        feeBalance = await c.readContract({ address: cfg.fee.token, abi: erc20, functionName: "balanceOf", args: [from as Address] }).catch(() => null);
      } else {
        let l1 = 0n;
        if (cfg.fee.opL1Oracle) {
          const approx = (data + "00".repeat(68)) as Hex; // calldata plus room for the signed envelope
          const f = await c.readContract({ address: GAS_PRICE_ORACLE, abi: gasOracleAbi, functionName: "getL1Fee", args: [approx] }).catch(() => null);
          // no L1 fee read: costs stay null, so the fee gate refuses
          if (f === null) return { ok, revertReason: revertReason ?? "L1 fee oracle not read", gas, costAtMax: null, costNow: null, feeBalance: await c.getBalance({ address: from as Address }).catch(() => null), blockNumber };
          l1 = f;
        }
        if (gas !== null && maxFee !== null) costAtMax = gas * maxFee + l1;
        if (gas !== null && price !== null) costNow = gas * price + l1;
        feeBalance = await c.getBalance({ address: from as Address }).catch(() => null);
      }
      return { ok, revertReason, gas, costAtMax, costNow, feeBalance, blockNumber };
    },
  };
}

/** Viem-backed signer for one chain. Loads the key only when called. */
export function chainSender(cfg: RepChainConfig, loadAccount: () => PrivateKeyAccount): RepSender {
  const reg = REP_REGISTRIES[cfg.key];
  const pub = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpc) }) as PublicClient;
  return {
    async sign(data, gas) {
      const account = loadAccount();
      const w = createWalletClient({ account, chain: cfg.viemChain, transport: http(cfg.rpc) });
      const feeTok = cfg.fee.kind === "tip20" ? { feeToken: cfg.fee.token } : {};
      const req = await w.prepareTransactionRequest({ account, to: reg.reputationRegistry, data, gas, ...feeTok } as Parameters<typeof w.prepareTransactionRequest>[0]);
      const serialized = (await w.signTransaction(req as Parameters<typeof w.signTransaction>[0])) as Hex;
      return { serialized, hash: keccak256(serialized), from: account.address };
    },
    broadcast: (serialized) => pub.sendRawTransaction({ serializedTransaction: serialized }),
    async wait(hash) {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
      return r ? r.status : "pending";
    },
  };
}

// ---------- plan ----------

export interface LedgerEntry {
  status: "sending" | "success" | "reverted" | "pending";
  chain: RepChainKey;
  agentId: string;
  tx: string;
  payTo: string;
  purchaseTx: string;
  recordId: string;
  feedbackURI: string;
  feedbackHash: string;
  at: string;
}
export type Ledger = Record<string, LedgerEntry>;
export const ledgerKey = (chain: RepChainKey, agentId: bigint | string) => `${chain}:${agentId.toString()}`;

export function readLedger(path: string): Ledger {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ledger) : {};
}

export interface RepDeps {
  chain: RepChainConfig;
  reader: RepReader;
  /** The address that paid and the only one that may write. */
  writer: string;
  purchases: EvmPurchase[];
  published: LoadedRecords;
  ledgerPath: string;
  /** agentIds already written by an earlier writer on this chain (Base: data/base/feedback-ledger.json). */
  priorAgentIds?: Set<string>;
  fetchImpl?: typeof fetch;
  verifyRecord?: (o: Observation) => Promise<boolean>;
  sender?: RepSender;
  log?: (line: string) => void;
}

export interface GiveArgs {
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export function encodeGive(a: GiveArgs): Hex {
  return encodeFunctionData({ abi: reputationAbi, functionName: "giveFeedback", args: [a.agentId, a.value, a.valueDecimals, a.tag1, a.tag2, a.endpoint, a.feedbackURI, a.feedbackHash] });
}

interface RecordHit {
  id: string;
  text: string;
  obs: Observation;
  sha256: string;
  indexSha256: string;
}

/** The latest published record of any of these txs (EVM hashes compared lowercase). */
export function publishedEvmRecord(loaded: LoadedRecords, txs: string[]): RecordHit | null {
  const want = new Set(txs.map((t) => t.toLowerCase()));
  const hits = loaded.records.filter((r) => want.has(String(r.obs.payment.transaction).toLowerCase())).sort((a, b) => b.entry.sequence - a.entry.sequence);
  const h = hits[0];
  if (!h) return null;
  return { id: h.entry.id, text: h.text, obs: h.obs, sha256: sha256Hex(h.text), indexSha256: h.entry.sha256 };
}

export interface RepItem {
  chain: RepChainKey;
  payTo: string;
  hosts: string[];
  purchases: { day: string; tx: string; httpStatus: number | null; settled: boolean; delivered: boolean; source: string }[];
  outcome: OutcomeSummary;
  agent: { agentId: string | null; byWallet: string[]; byOwner: string[]; detail: string; agentWalletNow: string | null; clientIsOwnerOrOperator: boolean | null };
  purchaseProof: (PurchaseCheck & { tx: string }) | null;
  record: { id: string; uri: string; sha256: string; keccak256: string; fetched: Fetched | null; verifiesOffline: boolean | null } | null;
  args: { agentId: string; value: string; valueDecimals: number; tag1: string; tag2: string; endpoint: string; feedbackURI: string; feedbackHash: string } | null;
  lastIndexOnChain: string | null;
  inLedger: boolean;
  refusals: string[];
  status: "writable" | "refused";
}

export interface Planned {
  item: RepItem;
  give: GiveArgs | null;
  record: RecordHit | null;
}

const endpointOf = (u: string) => {
  const x = new URL(u);
  return `${x.origin}${x.pathname}`;
};

/** Targets, values and every gate, read from the chain and the public site now. */
export async function plan(d: RepDeps): Promise<Planned[]> {
  if (d.purchases.length === 0) return [];
  const id = await d.reader.chainId();
  if (id !== d.chain.chainId) throw new Error(`RPC is chain ${id}, not ${d.chain.key} ${d.chain.chainId}`);
  const index = await d.reader.indexAgents();
  d.log?.(`${d.chain.key}: ${index.length} agents in the Identity registry`);
  const ledger = readLedger(d.ledgerPath);
  const out: Planned[] = [];
  for (const [payTo, ps] of groupEvmByPayTo(d.purchases)) {
    const choice = chooseEvmAgent(index, payTo);
    const hosts = [...new Set(ps.map((p) => p.host))].sort();
    const oc = outcomeOf(ps);
    const settled = ps.filter((p) => p.settled);
    const rec = publishedEvmRecord(d.published, settled.map((p) => p.tx));
    const evidence = rec ? settled.find((p) => p.tx === String(rec.obs.payment.transaction).toLowerCase()) ?? null : settled.at(-1) ?? null;
    const needsChain = choice.agentId !== null; // only a seller with an agent is read further
    const [walletNow, authz, last, proof] = needsChain
      ? await Promise.all([
          d.reader.agentWallet(choice.agentId!),
          d.reader.isAuthorizedOrOwner(d.writer, choice.agentId!),
          d.reader.lastIndex(choice.agentId!, d.writer),
          evidence ? d.reader.purchase({ tx: evidence.tx, client: d.writer, payTo, amountAtomic: evidence.amountAtomic, assets: d.chain.purchaseAssets }) : Promise.resolve(null),
        ])
      : [null, null, null, null];
    const fetched = needsChain && rec ? await fetchRecord(recordUri(rec.id), d.fetchImpl) : null;
    const verifies = needsChain && rec ? await (d.verifyRecord ?? recordVerifies)(rec.obs) : null;
    const values = oc.outcome ? evmValues(oc.outcome) : null;
    const hash = rec ? keccak256(stringToBytes(rec.text)) : null;
    const give: GiveArgs | null =
      values && rec && choice.agentId !== null ? { agentId: choice.agentId, ...values, endpoint: endpointOf(rec.obs.resourceUrl), feedbackURI: recordUri(rec.id), feedbackHash: hash! } : null;
    const key = choice.agentId !== null ? ledgerKey(d.chain.key, choice.agentId) : null;
    const inLedger = !!key && (!!ledger[key] || !!d.priorAgentIds?.has(choice.agentId!.toString()));
    const checks: EvmGateChecks = {
      chain: d.chain.key,
      caip2: d.chain.caip2,
      client: d.writer,
      payTo,
      outcome: oc.outcome,
      agent: choice.agentId !== null ? { agentId: choice.agentId, agentWalletNow: walletNow, clientIsOwnerOrOperator: authz } : null,
      purchase: proof && evidence ? { tx: evidence.tx, ...proof } : null,
      record: rec
        ? {
            id: rec.id,
            published: true,
            fetchedOk: fetched ? fetched.ok : null,
            fetchedSha256: fetched?.sha256 ?? null,
            indexSha256: rec.indexSha256,
            localSha256: rec.sha256,
            paymentTx: String(rec.obs.payment.transaction),
            payer: String(rec.obs.payment.payer),
            payTo: String(rec.obs.payment.payTo),
            network: String(rec.obs.payment.network),
            verdict: rec.obs.verdict.code,
            verifiesOffline: verifies,
          }
        : null,
      lastIndexOnChain: last,
      inLedger,
    };
    const why = evmRefusals(checks);
    out.push({
      give,
      record: rec,
      item: {
        chain: d.chain.key,
        payTo,
        hosts,
        purchases: ps.map((p) => ({ day: p.day, tx: p.tx, httpStatus: p.httpStatus, settled: p.settled, delivered: p.delivered, source: p.source })),
        outcome: oc,
        agent: { agentId: choice.agentId?.toString() ?? null, byWallet: choice.byWallet, byOwner: choice.byOwner, detail: choice.detail, agentWalletNow: walletNow, clientIsOwnerOrOperator: authz },
        purchaseProof: proof && evidence ? { tx: evidence.tx, ...proof } : null,
        record: rec ? { id: rec.id, uri: recordUri(rec.id), sha256: rec.sha256, keccak256: hash!, fetched, verifiesOffline: verifies } : null,
        args: give ? { agentId: give.agentId.toString(), value: give.value.toString(), valueDecimals: give.valueDecimals, tag1: give.tag1, tag2: give.tag2, endpoint: give.endpoint, feedbackURI: give.feedbackURI, feedbackHash: give.feedbackHash } : null,
        lastIndexOnChain: last?.toString() ?? null,
        inLedger,
        refusals: why,
        status: why.length === 0 ? "writable" : "refused",
      },
    });
  }
  return out;
}

// ---------- simulate ----------

export interface SimItem {
  payTo: string;
  agentId: string | null;
  simulated: boolean;
  detail: string;
  calldataBytes: number | null;
  result: (Omit<SimRead, "gas" | "costAtMax" | "costNow" | "feeBalance" | "blockNumber"> & { gas: string | null; costAtMax: string | null; costNow: string | null; feeBalance: string | null; blockNumber: string }) | null;
  feeUnit: string;
  feeCap: string;
  feeRefusal: string | null;
}

const simJson = (r: SimRead) => ({ ok: r.ok, revertReason: r.revertReason, gas: r.gas?.toString() ?? null, costAtMax: r.costAtMax?.toString() ?? null, costNow: r.costNow?.toString() ?? null, feeBalance: r.feeBalance?.toString() ?? null, blockNumber: r.blockNumber.toString() });
const feeUnit = (c: RepChainConfig) => (c.fee.kind === "tip20" ? `${c.fee.symbol} atomic (6 decimals)` : "wei");

/** eth_call + eth_estimateGas for every item that has an agent and a record. Nothing is signed. */
export async function simulate(d: RepDeps, items: Planned[]): Promise<SimItem[]> {
  const out: SimItem[] = [];
  for (const x of items) {
    const base = { payTo: x.item.payTo, agentId: x.item.agent.agentId, feeUnit: feeUnit(d.chain), feeCap: d.chain.fee.cap.toString() };
    if (!x.give) {
      out.push({ ...base, simulated: false, detail: x.item.agent.agentId === null ? "no agent" : "no record or no outcome", calldataBytes: null, result: null, feeRefusal: null });
      continue;
    }
    const data = encodeGive(x.give);
    const r = await d.reader.simulate(d.writer, data);
    out.push({ ...base, simulated: true, detail: "simulated with the published record", calldataBytes: (data.length - 2) / 2, result: simJson(r), feeRefusal: feeRefusal(r.costAtMax, d.chain.fee.cap, r.feeBalance) });
  }
  return out;
}

/**
 * Measurement only: giveFeedback with the latest DELIVERED published record of this chain, against a
 * given agentId, to read gas and fee when there is no target. Never a target, never written.
 */
export async function measure(d: RepDeps, agentId: bigint): Promise<Record<string, unknown>> {
  const mine = d.published.records.filter((r) => r.obs.payment.network === d.chain.caip2 && r.obs.verdict.code === "DELIVERED" && String(r.obs.payment.payer).toLowerCase() === d.writer.toLowerCase());
  const rec = mine.sort((a, b) => b.entry.sequence - a.entry.sequence)[0];
  if (!rec) return { chain: d.chain.key, measured: false, detail: `no published DELIVERED record on ${d.chain.caip2}` };
  const v = evmValues("delivered");
  const give: GiveArgs = { agentId, ...v, endpoint: endpointOf(rec.obs.resourceUrl), feedbackURI: recordUri(rec.entry.id), feedbackHash: keccak256(stringToBytes(rec.text)) };
  const data = encodeGive(give);
  const r = await d.reader.simulate(d.writer, data);
  return {
    chain: d.chain.key,
    measured: true,
    note: "measurement only: this agent is not a target and this call is never sent",
    agentId: agentId.toString(),
    record: rec.entry.id,
    feedbackURI: give.feedbackURI,
    feedbackHash: give.feedbackHash,
    calldataBytes: (data.length - 2) / 2,
    feeUnit: feeUnit(d.chain),
    feeCap: d.chain.fee.cap.toString(),
    result: simJson(r),
    feeRefusal: feeRefusal(r.costAtMax, d.chain.fee.cap, r.feeBalance),
  };
}

// ---------- send ----------

export interface SendResult {
  payTo: string;
  agentId: string | null;
  sent: boolean;
  tx: string | null;
  status: string;
}

/**
 * Write the items whose gates all pass, at most MAX_WRITES_PER_RUN, each only after a fresh read of the
 * chain, the ledger and the public record, and a fresh simulate within the fee cap. The ledger entry is
 * written after signing and before the transaction leaves this machine.
 */
export async function send(d: RepDeps, items: Planned[]): Promise<SendResult[]> {
  if (!d.sender) throw new Error("no sender");
  const out: SendResult[] = [];
  let written = 0;
  for (const x of items) {
    const res = (status: string, extra: Partial<SendResult> = {}): SendResult => ({ payTo: x.item.payTo, agentId: x.item.agent.agentId, sent: false, tx: null, status, ...extra });
    if (x.item.status !== "writable" || !x.give || !x.record) {
      out.push(res(`refused: ${x.item.refusals.join("; ") || "no arguments"}`));
      continue;
    }
    if (written >= MAX_WRITES_PER_RUN) {
      out.push(res(`refused: at most ${MAX_WRITES_PER_RUN} writes per run`));
      continue;
    }
    const key = ledgerKey(d.chain.key, x.give.agentId);
    const ledger = readLedger(d.ledgerPath);
    if (ledger[key] || d.priorAgentIds?.has(x.give.agentId.toString())) {
      out.push(res(`refused: ledger already has ${key}`));
      continue;
    }
    const last = await d.reader.lastIndex(x.give.agentId, d.writer);
    if (last !== 0n) {
      out.push(res(last === null ? "refused: could not read earlier feedback" : `refused: already has ${last} feedback from this address`));
      continue;
    }
    const wallet = await d.reader.agentWallet(x.give.agentId);
    if (!wallet || wallet.toLowerCase() !== x.item.payTo) {
      out.push(res(`refused: agentWallet changed to ${wallet}`));
      continue;
    }
    const f = await fetchRecord(x.give.feedbackURI, d.fetchImpl);
    if (!f.ok || f.sha256 !== x.record.sha256) {
      out.push(res(`refused: public record ${f.ok ? "hash changed" : f.detail}`));
      continue;
    }
    const data = encodeGive(x.give);
    const sim = await d.reader.simulate(d.writer, data);
    if (!sim.ok || sim.gas === null) {
      out.push(res(`refused: simulate failed ${sim.revertReason}`));
      continue;
    }
    const fr = feeRefusal(sim.costAtMax, d.chain.fee.cap, sim.feeBalance);
    if (fr) {
      out.push(res(`refused: ${fr}`));
      continue;
    }
    const signed = await d.sender.sign(data, (sim.gas * 12n) / 10n);
    if (signed.from.toLowerCase() !== d.writer.toLowerCase()) throw new Error(`key ${signed.from} is not the paying address ${d.writer}`);
    const entry: LedgerEntry = {
      status: "sending",
      chain: d.chain.key,
      agentId: x.give.agentId.toString(),
      tx: signed.hash,
      payTo: x.item.payTo,
      purchaseTx: String(x.record.obs.payment.transaction),
      recordId: x.record.id,
      feedbackURI: x.give.feedbackURI,
      feedbackHash: x.give.feedbackHash,
      at: new Date().toISOString(),
    };
    ledger[key] = entry;
    writeFileSync(d.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`); // before anything leaves
    written++;
    await d.sender.broadcast(signed.serialized);
    const status = await d.sender.wait(signed.hash);
    ledger[key] = { ...entry, status };
    writeFileSync(d.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    out.push(res(status, { sent: true, tx: signed.hash }));
    d.log?.(`${d.chain.key} agent ${key}: ${signed.hash} ${status}`);
  }
  return out;
}
