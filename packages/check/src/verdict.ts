/**
 * The verdict: one plain word in front of the facts, from the same numbers rank.json grades with.
 *
 *   "pay"      vet402's paid purchases from this seller came back with an answer often enough
 *   "avoid"    vet402 paid this seller and its answers mostly did not come back
 *   "unknown"  too little to say, or vet402 has not bought from this seller (on this chain)
 *
 * Every caller (the HTTP endpoint /v1/check, the fetch hook's `block` option, the CLI and the MCP tool)
 * reads the verdict from this one function, through the `verdict` and `why` fields of the lookup.
 *
 * The rule, and why it is this rule:
 *  - Only paid calls enter it: purchases whose payment settled and that count, that is, delivered, plus
 *    failures rank.json's method.faultRules puts on the seller after a settled payment (paid then 5xx,
 *    nothing or an empty 2xx; paid then 402 again). A seller-side failure with no settlement (the seller's
 *    server answered 5xx before any payment settled) is not a paid call and is left out, and with no
 *    settled payment at all the verdict is "unknown". Failures on vet402's or the facilitator's side, and
 *    failures whose cause cannot be told (for example a 4xx after vet402 built the request from the
 *    seller's listing), never move it. A seller that only failed on vet402's input is therefore never
 *    "avoid".
 *  - The bounds are rank.json's grade bounds on the same 95% Wilson interval (src/rank/score.ts):
 *    "pay" when the LOWER bound of delivered / counted is at or above GRADE_LOWER.C (0.5), the line a
 *    seller needs for grade C or better; "avoid" when the UPPER bound is below D_UPPER (0.5), the line
 *    for grade D. Anything between is "unknown", like rank.json's "undecided".
 *  - The paid calls must fall on at least MIN_DAYS (2) different UTC days, as for a grade: one
 *    outage on one day does not make a seller "avoid", one good burst does not make it "pay".
 *  - rank.json's MIN_COUNTED (10) is NOT required. It decides who gets a rank NUMBER (an order between
 *    sellers); a pay/avoid answer about one seller needs only the interval to clear the line. The Wilson
 *    interval itself needs 4 counted purchases to clear 0.5 either way (0 of 3 has an upper bound of 0.56,
 *    3 of 3 a lower bound of 0.44), so 1 to 3 purchases are always "unknown".
 *  - When the caller names a chain and the seller was bought on more than one, the counts are that
 *    chain's, and the days are counted from that chain's purchases rank.json lists (the newest ones, a
 *    lower bound). When rank.json cannot split the paid calls by chain, the verdict is "unknown".
 *  - When the caller gives the 402's payTo and it is not one vet402 paid, "pay" becomes "unknown": the
 *    purchases were made to another recipient. "avoid" stays.
 *  - Robinhood Chain and Arbitrum (data/evm/<lane>.json) hold one purchase per payTo from one run, so
 *    their purchases are on one day and alone never reach pay or avoid. A purchase there whose negative
 *    result is held until the seller is told ("withheld") is never used: such a seller is "unknown", and
 *    "pay" from another page becomes "unknown" too, with the reason the lane pages give.
 *  - Several sellers can answer one URL (a seller on the Solana, Tempo and Base page and on the Algorand
 *    page, or several services behind one host). "avoid" if any of them is "avoid" and none is "pay";
 *    "pay" if any is "pay" and none is "avoid"; both at once is "unknown" (pass a chain to choose).
 */
import { D_UPPER, GRADE_LOWER, MIN_DAYS, wilsonLower, wilsonUpper } from "../../../src/rank/score.js";
import type { CheckResult, SellerFacts } from "./check.js";

export type Verdict = "pay" | "avoid" | "unknown";
export const VERDICTS: readonly Verdict[] = ["pay", "avoid", "unknown"];

/** The figures one seller's verdict comes from (on the asked chain, when the seller spans several). */
export interface VerdictBasis {
  seller: string;
  page: string;
  /** The chains these figures cover. */
  chains: string[];
  tried: number;
  settled: number;
  /** Delivered + failures on the seller's side. */
  counted: number;
  /** Came back with an answer (2xx with a non-empty body after the payment settled). */
  answered: number;
  /** Failures not counted against the seller (vet402, the facilitator, or cause unknown), page-wide. */
  notCounted: number;
  /** Different UTC days with counted purchases, page-wide (rank.json's `days`). */
  days: number;
  /** 95% Wilson interval of answered / counted, rounded to 3 places. */
  lower: number;
  upper: number;
  /** Purchases whose result is held until the seller is told (Robinhood Chain, Arbitrum). */
  held: number;
  verdict: Verdict;
}

export interface VerdictOut {
  verdict: Verdict;
  /** One English sentence; every number in it is a field of `basis`. */
  why: string;
  /** The seller the verdict rests on (null when vet402 has no record). */
  basis: VerdictBasis | null;
  /** Every seller considered, with its own verdict. */
  bases: VerdictBasis[];
}

const CHAIN_NAME: Record<string, string> = { solana: "Solana", tempo: "Tempo", base: "Base", algorand: "Algorand", arbitrum: "Arbitrum", robinhood: "Robinhood Chain" };
const chainName = (c: string): string => CHAIN_NAME[c] ?? c;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function times(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

function basisOf(f: SellerFacts, chain: string | null): VerdictBasis {
  const multi = Object.keys(f.byChain).length > 1;
  const scoped = chain && multi ? f.byChain[chain] : undefined;
  // Settled purchases only (check.ts PaidFigures). Per chain, null means rank.json cannot split them: unknown.
  const paidScoped = scoped ? (f.paid.byChain[chain!] ?? null) : null;
  const splitUnknown = Boolean(scoped) && paidScoped === null;
  const tried = scoped ? scoped.tried : f.tried;
  const settled = scoped ? scoped.settled : f.settled;
  const counted = splitUnknown ? 0 : scoped ? paidScoped!.counted : f.paid.counted;
  const answered = splitUnknown ? 0 : scoped ? paidScoped!.answered : f.paid.answered;
  const days = splitUnknown ? 0 : scoped ? paidScoped!.days : f.paid.days;
  const lower = counted ? wilsonLower(answered, counted) : 0;
  const upper = counted ? wilsonUpper(answered, counted) : 1;
  let verdict: Verdict = "unknown";
  const held = f.held ?? 0;
  if (settled > 0 && counted > 0 && days >= MIN_DAYS && !held) {
    if (lower >= GRADE_LOWER.C) verdict = "pay";
    else if (upper < D_UPPER) verdict = "avoid";
  }
  const nc = f.notCountedAgainstSeller;
  return {
    seller: f.key,
    page: f.page,
    chains: scoped ? [chain!] : Object.keys(f.byChain),
    tried,
    settled,
    counted,
    answered,
    notCounted: nc.vet402OrFacilitator + nc.causeUnknown,
    days,
    lower: round3(lower),
    upper: round3(upper),
    held,
    verdict,
  };
}

/** "vet402 paid this seller 6 times on Solana over 4 days; 0 of the 6 that count came back with an answer" */
function paidClause(b: VerdictBasis): string {
  const on = b.chains.length ? ` on ${joinAnd(b.chains.map(chainName))}` : "";
  const over = b.days > 1 ? ` over ${b.days} days` : b.days === 1 ? " on one day" : "";
  return `vet402 paid this seller ${times(b.settled)}${on}${over}; ${b.answered} of the ${b.counted} that count came back with an answer`;
}

function newestStatus(f: SellerFacts | undefined, b: VerdictBasis): string {
  const last = f?.lastSellerSideFailure ?? f?.last ?? null;
  if (!last || last.httpStatus === null || (b.chains.length === 1 && last.chain !== b.chains[0])) return "";
  return ` (the newest failed one answered HTTP ${last.httpStatus})`;
}

function notCountedClause(b: VerdictBasis): string {
  return b.notCounted ? `, and ${b.notCounted} other failure${b.notCounted === 1 ? "" : "s"} that may be on vet402's side are left out` : "";
}

/**
 * The verdict for a lookup. Pure: reads only the result's own figures, so the sentence and the numbers
 * beside it cannot disagree.
 */
export function verdictFor(r: Pick<CheckResult, "found" | "sellers" | "asked" | "payTo">): VerdictOut {
  const chain = r.asked.chain;
  if (!r.sellers.length) {
    const why = r.found
      ? "vet402 holds signed records for this host but no purchase counts for it, so there is nothing to count."
      : chain
      ? `vet402 has not bought from this seller on ${chainName(chain)}, so there is no record to go on.`
      : "vet402 has not bought from this seller, so there is no record to go on.";
    return { verdict: "unknown", why, basis: null, bases: [] };
  }
  const bases = r.sellers.map((f) => basisOf(f, chain));
  const factsOf = (b: VerdictBasis) => r.sellers.find((f) => f.key === b.seller && f.page === b.page);
  const pays = bases.filter((b) => b.verdict === "pay");
  const avoids = bases.filter((b) => b.verdict === "avoid");

  if (pays.length && avoids.length) {
    const b = avoids[0]!;
    return {
      verdict: "unknown",
      why: `${paidClause(b)}, but other purchases from it on ${joinAnd(pays.flatMap((p) => p.chains).map(chainName))} came back, so name the chain to get one answer.`,
      basis: b,
      bases,
    };
  }
  if (avoids.length) {
    const b = avoids[0]!;
    return { verdict: "avoid", why: `${paidClause(b)}${newestStatus(factsOf(b), b)}${notCountedClause(b)}.`, basis: b, bases };
  }
  const heldOne = bases.find((b) => b.held > 0);
  if (heldOne) {
    return {
      verdict: "unknown",
      why: `vet402 bought from this seller on ${joinAnd(heldOne.chains.map(chainName))}; results for this seller are held until the seller is told.`,
      basis: heldOne,
      bases,
    };
  }
  if (pays.length) {
    const b = pays[0]!;
    if (r.payTo && !r.payTo.sameAsRecorded)
      return { verdict: "unknown", why: `${paidClause(b)}, but those payments went to another payTo than the one in this 402.`, basis: b, bases };
    return { verdict: "pay", why: `${paidClause(b)}${notCountedClause(b)}.`, basis: b, bases };
  }
  // Nothing decisive: the seller with the most counted purchases speaks for the rest.
  const b = [...bases].sort((x, y) => y.counted - x.counted || y.settled - x.settled)[0]!;
  const reason =
    b.counted === 0
      ? b.settled
        ? ", too few to tell anything"
        : ""
      : b.days < MIN_DAYS
        ? ", all on one day, too early to tell"
        : ", too few to tell either way";
  const why =
    b.settled === 0
      ? `vet402 tried to buy from this seller ${times(b.tried)}${b.chains.length ? ` on ${joinAnd(b.chains.map(chainName))}` : ""}, and none of its payments settled, so there is nothing to go on.`
      : `${paidClause(b)}${reason}${notCountedClause(b)}.`;
  return { verdict: "unknown", why, basis: b, bases };
}

/** The first line of every answer, CLI and MCP alike: the verdict and its one-sentence reason. */
export function verdictLine(r: { verdict: Verdict; why: string }): string {
  return `verdict: ${r.verdict}. ${r.why}`;
}
