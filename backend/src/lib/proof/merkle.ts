import { createHash } from 'node:crypto';

// Release-tick Merkle tree (v2/32), byte for byte the contract's. agent/src/merkle.ts is a copy; the fixed vectors
// in both test suites keep them equal. Domain bytes 0x00 (leaf) and 0x01 (node) stop a leaf passing as a node.

const ZERO = new Uint8Array(32);

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const compare = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && compare(a, b) === 0;

export const leafHash = (id: Uint8Array): Uint8Array => sha256(Uint8Array.of(0), id);
const nodeHash = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(Uint8Array.of(1), l, r);

/** ceil(log2(max(count, 1))): the proof length for a tree of `count` leaves. */
export const merkleDepth = (count: number): number => {
  let d = 0;
  while (1 << d < Math.max(count, 1)) d++;
  return d;
};

/** Ids sorted ascending by bytes; refuses empty sets, non-32-byte ids and duplicates. */
const sortedIds = (ids: Uint8Array[]): Uint8Array[] => {
  if (ids.length === 0) throw new Error('merkle: at least one id');
  if (ids.some((id) => id.length !== 32)) throw new Error('merkle: ids are 32 bytes');
  const out = [...ids].sort(compare);
  for (let i = 1; i < out.length; i++) if (compare(out[i - 1], out[i]) === 0) throw new Error('merkle: duplicate id');
  return out;
};

// Every level from the padded leaves (index 0) up to the root (last, one node).
const levels = (sorted: Uint8Array[]): Uint8Array[][] => {
  const width = 1 << merkleDepth(sorted.length);
  let level = Array.from({ length: width }, (_, i) => (i < sorted.length ? leafHash(sorted[i]) : ZERO));
  const out = [level];
  while (level.length > 1) {
    level = Array.from({ length: level.length / 2 }, (_, i) => nodeHash(level[2 * i], level[2 * i + 1]));
    out.push(level);
  }
  return out;
};

export const merkleRoot = (ids: Uint8Array[]): Uint8Array => levels(sortedIds(ids)).at(-1)![0];

/** Position of `id` in the sorted set and its sibling hashes from leaf to root. */
export const merkleProof = (ids: Uint8Array[], id: Uint8Array): { index: number; proof: Uint8Array[] } => {
  const sorted = sortedIds(ids);
  const index = sorted.findIndex((x) => equal(x, id));
  if (index < 0) throw new Error('merkle: id not in set');
  const tree = levels(sorted);
  const proof = tree.slice(0, -1).map((level, d) => level[(index >> d) ^ 1]);
  return { index, proof };
};

export const verifyMerkle = (root: Uint8Array, leafId: Uint8Array, index: number, proof: Uint8Array[], count: number): boolean => {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) return false;
  if (root.length !== 32 || leafId.length !== 32 || proof.length !== merkleDepth(count) || proof.some((p) => p.length !== 32)) return false;
  let h = leafHash(leafId);
  proof.forEach((sib, d) => (h = (index >> d) & 1 ? nodeHash(sib, h) : nodeHash(h, sib)));
  return equal(h, root);
};

const HEX32 = /^[0-9a-f]{64}$/;
export const fromHex32 = (hex: string): Uint8Array => {
  if (!HEX32.test(hex)) throw new Error('merkle: expected 32-byte lowercase hex');
  return new Uint8Array(Buffer.from(hex, 'hex'));
};
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Hex wrappers for chain args and JSON: root and proof as lowercase hex. */
export const merkleRootHex = (ids: string[]): string => toHex(merkleRoot(ids.map(fromHex32)));
export const merkleProofHex = (ids: string[], id: string): { index: number; proof: string[] } => {
  const p = merkleProof(ids.map(fromHex32), fromHex32(id));
  return { index: p.index, proof: p.proof.map(toHex) };
};
