/**
 * Proxy buy configuration from environment variables. Keys come only from the environment and are
 * never printed: every error about a key is a fixed message that does not quote its value.
 *
 * Proxy buy refuses to start with a wallet that another vet402 path already signs with (the census,
 * remeasure and first-buyer payers), and with a receive wallet equal to its payer.
 */
import { isAddress as isSolAddress } from "@solana/kit";
import { isAddress as isEvmAddress } from "viem";
import { PAYER_ADDRESS as SOLANA_CENSUS_PAYER } from "../constants.js";
import { PAYER_ADDRESS as TEMPO_CENSUS_PAYER, MAX_TOTAL_ATOMIC as TEMPO_LEDGER_CEILING, TEMPO_RPC_URL } from "../tempo/constants.js";
import {
  BUY_FEE_ATOMIC,
  DEFAULT_FACILITATOR_URL,
  PROXY_DAILY_MAX_PURCHASES,
  PROXY_DEFAULT_DAILY_CAP_ATOMIC,
  PROXY_MAX_PER_CALL_ATOMIC,
  PROXY_SOLANA_DAILY_CAP_CEILING_ATOMIC,
} from "./constants.js";

export interface SolanaConfig {
  receive: string;
  payer: string;
  payerKey: Uint8Array;
  rpcUrl: string;
  facilitatorUrl: string;
  dailyCapAtomic: bigint;
  /** Refunds per UTC day on this chain (default: the daily cap). */
  dailyRefundCapAtomic: bigint;
}

export interface TempoConfig {
  receive: string;
  payer: string;
  payerKey: `0x${string}`;
  rpcUrl: string;
  mppSecret: string;
  dailyCapAtomic: bigint;
  /** Refunds per UTC day on this chain (default: the daily cap). */
  dailyRefundCapAtomic: bigint;
}

export interface ProxyConfig {
  enabled: boolean;
  publicOrigin: string;
  /** Postgres connection string (DATABASE_URL, as Vercel's Neon integration sets it; POSTGRES_URL also read). Never printed. */
  databaseUrl: string | null;
  port: number;
  feeAtomic: bigint;
  maxPerCallAtomic: bigint;
  dailyMaxPurchases: number;
  solana: SolanaConfig | null;
  tempo: TempoConfig | null;
}

type Env = Record<string, string | undefined>;

function usdcToAtomic(name: string, v: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`${name}: expected a USDC amount like 2.00`);
  const [w, f = ""] = v.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

function cap(name: string, v: string | undefined, ceiling: bigint): bigint {
  const c = v ? usdcToAtomic(name, v) : PROXY_DEFAULT_DAILY_CAP_ATOMIC;
  if (c <= 0n || c > ceiling) throw new Error(`${name}: must be above 0 and at most ${ceiling} atomic`);
  return c;
}

function solanaKey(raw: string): Uint8Array {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error("VET402_PROXY_SOLANA_PAYER_KEY is not a JSON array"); // never echo the value
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error("VET402_PROXY_SOLANA_PAYER_KEY is not a 64-byte solana-keygen array");
  }
  return Uint8Array.from(arr as number[]);
}

export function configFromEnv(env: Env): ProxyConfig {
  const origin = env.VET402_PROXY_PUBLIC_ORIGIN ?? "http://localhost:8402";
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error("VET402_PROXY_PUBLIC_ORIGIN: an origin like https://buy.example.com, no path");

  let solana: SolanaConfig | null = null;
  if (env.VET402_PROXY_SOLANA_RECEIVE || env.VET402_PROXY_SOLANA_PAYER) {
    const receive = env.VET402_PROXY_SOLANA_RECEIVE ?? "";
    const payer = env.VET402_PROXY_SOLANA_PAYER ?? "";
    if (!isSolAddress(receive) || !isSolAddress(payer)) throw new Error("VET402_PROXY_SOLANA_RECEIVE and VET402_PROXY_SOLANA_PAYER must be Solana addresses");
    if (receive === payer) throw new Error("the Solana receive wallet and payer must differ");
    if (payer === SOLANA_CENSUS_PAYER || receive === SOLANA_CENSUS_PAYER) throw new Error("proxy buy must not use the census payer wallet on Solana");
    const keyRaw = env.VET402_PROXY_SOLANA_PAYER_KEY;
    if (!keyRaw) throw new Error("VET402_PROXY_SOLANA_PAYER_KEY is not set");
    solana = {
      receive,
      payer,
      payerKey: solanaKey(keyRaw),
      rpcUrl: env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
      facilitatorUrl: env.VET402_PROXY_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL,
      dailyCapAtomic: cap("VET402_PROXY_SOLANA_DAILY_CAP", env.VET402_PROXY_SOLANA_DAILY_CAP, PROXY_SOLANA_DAILY_CAP_CEILING_ATOMIC),
      dailyRefundCapAtomic: cap("VET402_PROXY_SOLANA_REFUND_DAILY_CAP", env.VET402_PROXY_SOLANA_REFUND_DAILY_CAP ?? env.VET402_PROXY_SOLANA_DAILY_CAP, PROXY_SOLANA_DAILY_CAP_CEILING_ATOMIC),
    };
  }

  let tempo: TempoConfig | null = null;
  if (env.VET402_PROXY_TEMPO_RECEIVE || env.VET402_PROXY_TEMPO_PAYER) {
    const receive = env.VET402_PROXY_TEMPO_RECEIVE ?? "";
    const payer = env.VET402_PROXY_TEMPO_PAYER ?? "";
    if (!isEvmAddress(receive, { strict: false }) || !isEvmAddress(payer, { strict: false })) throw new Error("VET402_PROXY_TEMPO_RECEIVE and VET402_PROXY_TEMPO_PAYER must be 0x addresses");
    if (receive.toLowerCase() === payer.toLowerCase()) throw new Error("the Tempo receive wallet and payer must differ");
    if ([receive, payer].some((a) => a.toLowerCase() === TEMPO_CENSUS_PAYER.toLowerCase())) throw new Error("proxy buy must not use the shared EVM census payer");
    const key = env.VET402_PROXY_TEMPO_PAYER_KEY ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("VET402_PROXY_TEMPO_PAYER_KEY is not set or not a 32-byte 0x key");
    const secret = env.VET402_PROXY_MPP_SECRET ?? "";
    if (secret.length < 32) throw new Error("VET402_PROXY_MPP_SECRET must be at least 32 characters");
    tempo = {
      receive,
      payer,
      payerKey: key as `0x${string}`,
      rpcUrl: env.TEMPO_RPC_URL ?? TEMPO_RPC_URL,
      mppSecret: secret,
      dailyCapAtomic: cap("VET402_PROXY_TEMPO_DAILY_CAP", env.VET402_PROXY_TEMPO_DAILY_CAP, TEMPO_LEDGER_CEILING),
      dailyRefundCapAtomic: cap("VET402_PROXY_TEMPO_REFUND_DAILY_CAP", env.VET402_PROXY_TEMPO_REFUND_DAILY_CAP ?? env.VET402_PROXY_TEMPO_DAILY_CAP, TEMPO_LEDGER_CEILING),
    };
  }

  return {
    enabled: env.VET402_PROXY_BUY_ENABLED === "1",
    publicOrigin: origin,
    databaseUrl: env.DATABASE_URL ?? env.POSTGRES_URL ?? null,
    port: Number(env.PORT ?? 8402),
    feeAtomic: BUY_FEE_ATOMIC,
    maxPerCallAtomic: PROXY_MAX_PER_CALL_ATOMIC,
    dailyMaxPurchases: PROXY_DAILY_MAX_PURCHASES,
    solana,
    tempo,
  };
}

/** A printable summary: addresses and caps only, never keys or the MPP secret. */
export function describeConfig(c: ProxyConfig): Record<string, unknown> {
  return {
    enabled: c.enabled,
    publicOrigin: c.publicOrigin,
    database: c.databaseUrl ? "set" : "missing",
    fee: c.feeAtomic.toString(),
    maxPerCall: c.maxPerCallAtomic.toString(),
    dailyMaxPurchases: c.dailyMaxPurchases,
    solana: c.solana ? { receive: c.solana.receive, payer: c.solana.payer, rpcUrl: redactUrl(c.solana.rpcUrl), facilitator: redactUrl(c.solana.facilitatorUrl), dailyCap: c.solana.dailyCapAtomic.toString(), dailyRefundCap: c.solana.dailyRefundCapAtomic.toString() } : null,
    tempo: c.tempo ? { receive: c.tempo.receive, payer: c.tempo.payer, rpcUrl: redactUrl(c.tempo.rpcUrl), dailyCap: c.tempo.dailyCapAtomic.toString(), dailyRefundCap: c.tempo.dailyRefundCapAtomic.toString() } : null,
  };
}

/** RPC URLs often carry an API key in the path or query: print the origin only. */
function redactUrl(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "(unparseable)";
  }
}
