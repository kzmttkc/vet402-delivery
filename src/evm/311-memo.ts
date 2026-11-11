/**
 * The 3.11.0 Monad (eip155:143) payability verdict, as this repository's code holds it. The memo itself is not in
 * this repository; this constant is the only switch the purchase path reads. FAIL: no Monad purchase lane, no
 * Monad signature, no deposit asked for Monad, no Monad purchase counted or announced.
 */
export const MONAD_311_STATUS = "FAIL" as const;

export const MONAD_CAIP2 = "eip155:143";
export const MONAD_CHAIN_ID = 143;
export const POLYGON_CAIP2 = "eip155:137";
export const POLYGON_CHAIN_ID = 137;

/** Why Monad must not be paid on while MONAD_311_STATUS is FAIL. null when purchase code may proceed. */
export function monadPurchaseBlockedReason(): string | null {
  if (MONAD_311_STATUS !== "FAIL") return null;
  return `3.11.0 is FAIL: no purchase lane on ${MONAD_CAIP2} until catalog proof is recorded`;
}

/** A chain spec or accept that names Monad by CAIP-2 or chain id. */
export function namesMonad(x: { caip2?: string; chainId?: number; network?: string }): boolean {
  return x.caip2 === MONAD_CAIP2 || x.network === MONAD_CAIP2 || x.chainId === MONAD_CHAIN_ID;
}

/** A chain spec that is Polygon by key, CAIP-2 or chain id: the 3.11 gates apply whatever the key is called. */
export function isPolygonSpec(x: { key?: string; caip2?: string; chainId?: number }): boolean {
  return x.key === "polygon" || x.caip2 === POLYGON_CAIP2 || x.chainId === POLYGON_CHAIN_ID;
}
