/**
 * The redaction marks the secret gate (./secret-gate.ts) writes into public copies, and the first step of the cut
 * that shortens a detail for the rank and the site (./detail-cut.ts): a mark the cut would split is kept whole.
 * No imports, so the gate can import it.
 */

/** The replacement text for a token a seller returned to vet402 (same wording as data/ since 2026-09-28). */
export const SELLER_TOKEN_REDACTION = "[redacted: token the seller issued to vet402]";

/**
 * The replacement text for a value in a seller's answer that the gate could not tell from a secret (gateCopy).
 * One run of characters with no space, so it reads as one value in a query, a header or a form as well.
 */
export const UNCLEAR_VALUE_REDACTION = "[redacted:unclear-seller-value]";

/** The replacement text for a street address (same form as the token redaction). */
export const POSTAL_ADDRESS_REDACTION = "[redacted: street address]";
/** The replacement text for the coordinates a seller gave next to a street address it was asked about. */
export const POSTAL_COORD_REDACTION = "[redacted: coordinates of a street address]";
/** The street address mark as a URL query writes it. */
export const ENCODED_ADDRESS_REDACTION = encodeURIComponent(POSTAL_ADDRESS_REDACTION).replace(/%20/g, "+");

const MARKS = [SELLER_TOKEN_REDACTION, UNCLEAR_VALUE_REDACTION, POSTAL_ADDRESS_REDACTION, POSTAL_COORD_REDACTION, ENCODED_ADDRESS_REDACTION];

/**
 * The text kept to its first `n` characters and "…", as before, except that a mark the cut would split is kept
 * whole: the cut moves to where that mark ends. A piece of a mark ("access_token=[redacted:unclear-se…") is a value
 * under a secret name to the gate's scan of the tree, which would halt the publish, and so is a name with nothing
 * after it ("access_token=…"), so the cut is not moved back before the mark. The gate reads a whole mark with "…"
 * after it as the mark (ownMarker in ./secret-gate.ts).
 */
export function cutKeepingMarks(v: string | null, n = 200): string | null {
  if (v === null || v.length <= n) return v;
  let end = n;
  for (const m of MARKS) {
    for (let i = v.indexOf(m); i >= 0 && i < n; i = v.indexOf(m, i + 1)) {
      if (i + m.length > n) end = Math.max(end, i + m.length);
    }
  }
  return end >= v.length ? v : `${v.slice(0, end)}…`;
}
