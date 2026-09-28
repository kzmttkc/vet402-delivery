/**
 * One Merkle root per UTC day over that day's observations.
 *  leaf = keccak256(0x00 || eip712Digest)
 *  node = keccak256(0x01 || min(a, b) || max(a, b))   (sorted pair, so a proof is just the siblings)
 * The 0x00/0x01 prefixes keep a leaf from being passed off as an inner node. An odd node at the end
 * of a level is carried up unchanged. Leaves are in observer sequence order.
 */
import { concatHex, keccak256, type Hex } from "viem";

export function leafHash(digest: Hex): Hex {
  return keccak256(concatHex(["0x00", digest]));
}

function nodeHash(a: Hex, b: Hex): Hex {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(concatHex(["0x01", lo, hi]));
}

export interface MerkleTree {
  root: Hex;
  proofs: Hex[][];
}

export function buildTree(digests: Hex[]): MerkleTree {
  if (digests.length === 0) throw new Error("merkle: no leaves");
  let level = digests.map(leafHash);
  // positions[i] = index of leaf i's ancestor in the current level
  const positions = digests.map((_, i) => i);
  const proofs: Hex[][] = digests.map(() => []);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      next.push(b === undefined ? a : nodeHash(a, b));
    }
    for (let leaf = 0; leaf < digests.length; leaf++) {
      const p = positions[leaf]!;
      const sib = p % 2 === 0 ? p + 1 : p - 1;
      if (sib < level.length) proofs[leaf]!.push(level[sib]!);
      positions[leaf] = Math.floor(p / 2);
    }
    level = next;
  }
  return { root: level[0]!, proofs };
}

export function rootFromProof(digest: Hex, proof: Hex[]): Hex {
  let h = leafHash(digest);
  for (const sib of proof) h = nodeHash(h, sib);
  return h;
}

export function verifyInclusion(digest: Hex, proof: Hex[], root: Hex): boolean {
  return rootFromProof(digest, proof).toLowerCase() === root.toLowerCase();
}

/** The memo text written once per day. Everything a watcher needs to spot a missing record. */
export function anchorMemo(args: { day: string; root: Hex; count: number; sequenceRange: [number, number]; observerAddress: string }): string {
  return `x402-observation/v0 day=${args.day} root=${args.root} n=${args.count} seq=${args.sequenceRange[0]}-${args.sequenceRange[1]} observer=${args.observerAddress}`;
}

export function parseAnchorMemo(memo: string): { day: string; root: string; count: number; seq: [number, number]; observer: string } | null {
  const m = /x402-observation\/v0 day=(\d{4}-\d{2}-\d{2}) root=(0x[0-9a-fA-F]{64}) n=(\d+) seq=(\d+)-(\d+) observer=(0x[0-9a-fA-F]{40})/.exec(memo);
  if (!m) return null;
  return { day: m[1]!, root: m[2]!, count: Number(m[3]), seq: [Number(m[4]), Number(m[5])], observer: m[6]! };
}
