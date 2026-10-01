/** vet402-check: read vet402's public record about an x402 or MPP seller before paying it. Read-only. */
export { checkBeforePaying, lookup, normalizeChain, type CheckInput, type CheckResult, type SellerFacts, type RecordRef } from "./check.js";
export { verifyRecord, formatVerify, type VerifyResult, type VerifyLine, type VerifyOptions } from "./verify.js";
export { wrapFetchWithCheck, readOffers, carriesPayment, CheckBlockedError, type CheckEvent, type CheckHookOptions, type Offer, type WrappedFetch } from "./hook.js";
export { handleMessage, serveStdio, TOOLS } from "./mcp.js";
export { PublicData, defaultSources, RANK_URL, RECORDS_INDEX_URL, RECORDS_BASE_URL, type Sources } from "./sources.js";
export { verdictFor, verdictLine, VERDICTS, type Verdict, type VerdictBasis, type VerdictOut } from "./verdict.js";
