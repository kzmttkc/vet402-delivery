/**
 * Is a seller's stock price right? Compare the price a paid x402 answer returns with Robinhood Chain's own
 * reference: the Chainlink price feed of that Stock Token, its age against the heartbeat, the token's
 * oraclePaused flag and its ERC-8056 UI multiplier.
 *
 * The feed returns the price of one token, which is the share price times the multiplier; a share price
 * (what most stock APIs return) is the feed answer divided by the multiplier. Robinhood's developer docs,
 * read 2026-09-30:
 *   docs.robinhood.com/chain/oracles-and-price-feeds/  "compare updatedAt against the feed's heartbeat; reject stale prices"
 *   docs.robinhood.com/chain/stock-token-apis/         "If you mix the two, apply currentMultiplier from /assets to convert"
 *   docs.robinhood.com/chain/stock-tokens/             "every Stock Token has a live Chainlink price feed"
 * Not checked: the L2 sequencer uptime feed the docs recommend (its Robinhood Chain address is not in
 * Chainlink's directory as of 2026-09-30).
 * Feed parameters (heartbeat 86400 s, deviation threshold 0.5 %) are from Chainlink's directory
 * reference-data-directory.vercel.app/feeds-robinhood-mainnet.json.
 *
 * Read-only: eth_call against the Robinhood Chain RPC. Nothing here signs or sends.
 */
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";

export interface StockRef {
  ticker: string;
  /** Chainlink proxy on Robinhood Chain ("Robinhood <T> / USD"). */
  feed: Address;
  /** The Robinhood Stock Token (ERC-20 + ERC-8056 multiplier). */
  token: Address;
}

/**
 * Tickers vet402 checks. Feeds from Chainlink's directory, tokens from Robinhood's asset list
 * (both 2026-09-30). ORCL has the largest multiplier among tokens with a feed (1.0022), so a seller that
 * mixes the share price with the token price shows up there first.
 */
export const STOCK_REFS: readonly StockRef[] = [
  { ticker: "AAPL", feed: getAddress("0x6B22A786bAa607d76728168703a39Ea9C99f2cD0"), token: getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9") },
  { ticker: "TSLA", feed: getAddress("0x4A1166a659A55625345e9515b32adECea5547C38"), token: getAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d") },
  { ticker: "NVDA", feed: getAddress("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"), token: getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC") },
  { ticker: "SPY", feed: getAddress("0x319724394D3A0e3669269846abE664Cd621f9f6A"), token: getAddress("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C") },
  { ticker: "ORCL", feed: getAddress("0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844"), token: getAddress("0xb0992820E760d836549ba69BC7598b4af75dEE03") },
];

export const FEED_HEARTBEAT_SEC = 86_400;
/** Chainlink updates the feed when the price moves this much, so a right answer sits within it. */
export const FEED_DEVIATION_PCT = 0.5;
/** Beyond the feed's own threshold but still near: after-hours drift, rounding, a delayed source. */
export const CLOSE_PCT = 2;

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const tokenAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
]);

export interface StockReference {
  ticker: string;
  feed: Address;
  token: Address;
  description: string | null;
  /** Token price in USD (feed answer / 10^decimals): the share price times the multiplier. */
  tokenPrice: number;
  answerRaw: string;
  decimals: number;
  roundId: string;
  updatedAt: number;
  readAt: number;
  ageSec: number;
  stale: boolean;
  oraclePaused: boolean | null;
  /** ERC-8056 UI multiplier in effect at readAt (1e18 = 1.0), as a number. */
  multiplier: number | null;
  /** tokenPrice / multiplier: the price of one share. */
  sharePrice: number | null;
}

type Reader = Pick<PublicClient, "readContract">;

/** The effective multiplier: the new one once its effectiveAt has passed. */
export function effectiveMultiplier(ui: bigint, next: bigint | null, effectiveAt: bigint | null, nowSec: number): bigint {
  if (next !== null && effectiveAt !== null && effectiveAt > 0n && BigInt(nowSec) >= effectiveAt && next > 0n) return next;
  return ui;
}

export async function readStockReference(client: Reader, ref: StockRef, nowSec: number = Math.floor(Date.now() / 1000)): Promise<StockReference> {
  const [decimals, round, description] = await Promise.all([
    client.readContract({ address: ref.feed, abi: feedAbi, functionName: "decimals" }),
    client.readContract({ address: ref.feed, abi: feedAbi, functionName: "latestRoundData" }),
    client.readContract({ address: ref.feed, abi: feedAbi, functionName: "description" }).catch(() => null),
  ]);
  const opt = async <T>(f: () => Promise<T>): Promise<T | null> => f().catch(() => null);
  const [ui, next, eff, paused] = await Promise.all([
    opt(() => client.readContract({ address: ref.token, abi: tokenAbi, functionName: "uiMultiplier" })),
    opt(() => client.readContract({ address: ref.token, abi: tokenAbi, functionName: "newUIMultiplier" })),
    opt(() => client.readContract({ address: ref.token, abi: tokenAbi, functionName: "effectiveAt" })),
    opt(() => client.readContract({ address: ref.token, abi: tokenAbi, functionName: "oraclePaused" })),
  ]);
  const [roundId, answer, , updatedAt] = round;
  const tokenPrice = Number(answer) / 10 ** Number(decimals);
  const mult = ui === null ? null : Number(effectiveMultiplier(ui, next, eff, nowSec)) / 1e18;
  const ageSec = nowSec - Number(updatedAt);
  return {
    ticker: ref.ticker,
    feed: ref.feed,
    token: ref.token,
    description,
    tokenPrice,
    answerRaw: answer.toString(),
    decimals: Number(decimals),
    roundId: roundId.toString(),
    updatedAt: Number(updatedAt),
    readAt: nowSec,
    ageSec,
    stale: ageSec > FEED_HEARTBEAT_SEC,
    oraclePaused: paused,
    multiplier: mult,
    sharePrice: mult === null || mult <= 0 ? null : tokenPrice / mult,
  };
}

/** Pull the ticker and price out of a seller's JSON answer. Looks at the top level and one level down. */
export function extractSellerPrice(body: string): { ticker: string | null; price: number | null } {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return { ticker: null, price: null };
  }
  const objs: Record<string, unknown>[] = [];
  if (j && typeof j === "object" && !Array.isArray(j)) {
    objs.push(j as Record<string, unknown>);
    for (const v of Object.values(j as Record<string, unknown>)) if (v && typeof v === "object" && !Array.isArray(v)) objs.push(v as Record<string, unknown>);
  }
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  let price: number | null = null;
  let ticker: string | null = null;
  for (const o of objs) {
    for (const k of ["price", "current_price", "currentPrice", "regularMarketPrice", "last", "last_price"]) {
      if (price === null && k in o) price = num(o[k]);
    }
    for (const k of ["ticker", "symbol"]) {
      if (ticker === null && typeof o[k] === "string") ticker = (o[k] as string).toUpperCase();
    }
  }
  return { ticker, price };
}

export type StockVerdict =
  | "agrees" // within the feed's own 0.5 % threshold of the reference
  | "close" // within 2 %
  | "differs" // further off
  | "wrong_ticker" // the answer is about another ticker
  | "no_price" // no positive price in the answer
  | "reference_invalid" // the feed answer is zero or negative
  | "reference_stale" // the feed is older than its heartbeat: nothing to compare against
  | "reference_paused" // the token's oracle is paused (a corporate action is being processed)
  | "market_closed"; // bought outside the NYSE core session and not within 0.5 %: no verdict against the seller

export interface StockComparison {
  ticker: string;
  verdict: StockVerdict;
  sellerPrice: number | null;
  sellerTicker: string | null;
  /** The reference the answer was graded against: share price when known, else token price. */
  comparedWith: "share_price" | "token_price";
  referencePrice: number;
  referenceAgeSec: number;
  /** (seller - reference) / reference, percent. */
  deviationPct: number | null;
  /** Deviation from the other of the two prices, percent. */
  deviationFromOtherPct: number | null;
  /** Which of the two prices the answer is nearer to. Null when the multiplier is exactly 1. */
  nearer: "share_price" | "token_price" | null;
}

const pct = (a: number, b: number): number => ((a - b) / b) * 100;

/**
 * Pure. A stock API answers in share terms, so the answer is graded against the share price
 * (feed / multiplier). How far it is from the token price is kept next to it, so an answer that mixed
 * the two is visible.
 */
export function compareStockAnswer(ticker: string, body: string, ref: StockReference, boughtAtIso?: string): StockComparison {
  const { ticker: sellerTicker, price } = extractSellerPrice(body);
  const refPrice = ref.sharePrice ?? ref.tokenPrice;
  const base: StockComparison = {
    ticker,
    verdict: "no_price",
    sellerPrice: price,
    sellerTicker,
    comparedWith: ref.sharePrice !== null ? "share_price" : "token_price",
    referencePrice: refPrice,
    referenceAgeSec: ref.ageSec,
    deviationPct: null,
    deviationFromOtherPct: null,
    nearer: null,
  };
  if (!(ref.tokenPrice > 0)) return { ...base, verdict: "reference_invalid" };
  if (ref.oraclePaused === true) return { ...base, verdict: "reference_paused" };
  if (ref.stale) return { ...base, verdict: "reference_stale" };
  if (sellerTicker !== null && sellerTicker !== ticker.toUpperCase()) return { ...base, verdict: "wrong_ticker" };
  if (price === null) return base;
  const d = pct(price, refPrice);
  const other = ref.sharePrice !== null ? pct(price, ref.tokenPrice) : null;
  const nearer = other === null || ref.multiplier === 1 ? null : Math.abs(d) <= Math.abs(other) ? "share_price" : "token_price";
  let verdict: StockVerdict = Math.abs(d) <= FEED_DEVIATION_PCT ? "agrees" : Math.abs(d) <= CLOSE_PCT ? "close" : "differs";
  // Outside the core session a stock API may serve the last close while the 24/5 feed moves: no verdict against the seller.
  // No purchase time given = not known to be in session = no verdict either.
  if (verdict !== "agrees" && (boughtAtIso === undefined || !inCoreSession(boughtAtIso))) verdict = "market_closed";
  return { ...base, verdict, deviationPct: d, deviationFromOtherPct: other, nearer };
}

/**
 * NYSE 2026 (www.nyse.com/markets/hours-calendars, read 2026-09-30): core session 9:30 a.m. to 4:00 p.m. ET,
 * these full-day holidays, and 1:00 p.m. closes on 2026-11-27 and 2026-12-24. A date outside 2026 is treated
 * as closed (no verdict) until its calendar is added.
 */
export const NYSE_HOLIDAYS_2026 = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
export const NYSE_EARLY_CLOSE_2026 = ["2026-11-27", "2026-12-24"];

/** Pure. Is this instant inside the NYSE core session? */
export function inCoreSession(iso: string): boolean {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(t)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.year !== "2026") return false;
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  if (NYSE_HOLIDAYS_2026.includes(day)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const close = NYSE_EARLY_CLOSE_2026.includes(day) ? 13 * 60 : 16 * 60;
  return minutes >= 9 * 60 + 30 && minutes < close;
}

/** Chainlink's directory entry for a feed, to check the fixed addresses against the source of truth. */
export const CHAINLINK_DIRECTORY = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

/** Every fixed feed must be in the directory under "Robinhood <T> / USD" with the same proxy; returns the mismatches. */
export function checkAgainstDirectory(refs: readonly StockRef[], directory: { name?: string; proxyAddress?: string; heartbeat?: number }[]): string[] {
  const bad: string[] = [];
  for (const r of refs) {
    const e = directory.find((d) => d.name === `Robinhood ${r.ticker} / USD`);
    if (!e) bad.push(`${r.ticker}: not in the directory`);
    else if (!e.proxyAddress || e.proxyAddress.toLowerCase() !== r.feed.toLowerCase()) bad.push(`${r.ticker}: directory proxy ${e.proxyAddress} != ${r.feed}`);
    else if (e.heartbeat !== FEED_HEARTBEAT_SEC) bad.push(`${r.ticker}: heartbeat ${e.heartbeat} != ${FEED_HEARTBEAT_SEC}`);
  }
  return bad;
}
