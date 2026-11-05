import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromHex32, merkleDepth, merkleProofHex, merkleRootHex, verifyMerkle } from '../src/lib/proof/merkle.ts';

// Expected roots and proofs come from an independent Python hashlib computation, not from this code.
// The contract's unit test asserts the same vectors (v2/32).
const fill = (b: number) => Buffer.alloc(32, b).toString('hex');
const VECTORS = [
  { name: 'a_count_1', ids: [fill(0x11)], root: '4635e1fa62a599a7880a8d14a56f720a1d40f6e5448ab5a5e39bedc8bd87fa8e', proofs: [{ index: 0, proof: [] as string[] }] },
  {
    name: 'b_count_3',
    ids: [fill(0x11), fill(0x22), fill(0x33)],
    root: '8456303a1e30d1ba174eaad8b4b111e5b98cd3715d1b989b2f19173446fe83ad',
    proofs: [
      { index: 1, proof: ['4635e1fa62a599a7880a8d14a56f720a1d40f6e5448ab5a5e39bedc8bd87fa8e', 'cd9983e108c3576842260b98a96d0ec222f48a20725a6408f41aa85b133f5b16'] },
      { index: 2, proof: [fill(0), 'cc15b132263fd4fd2748c0e7cb9e1c4ad0afe70fcf9382ee644c4da8af0286a5'] },
    ],
  },
  {
    name: 'c_count_4',
    ids: [fill(0x11), fill(0x22), fill(0x33), fill(0x44)],
    root: '0bdd9ab2021b08e98613d9495870a4e3445ddc83e83bcff6a6d6f1ccd5120105',
    proofs: [
      { index: 0, proof: ['bc6f27de60abf5319d16ff4c98fe3c42022c84f6a7a2b207c8df19b0ec3d8d58', '227ecad4978a6582a00f90e74efcea105674ab62fb72a14ada8a2b321311ec8f'] },
      { index: 3, proof: ['5e5caeafc27155c368b6f201107d6f8b270747ce636ac5174a56c6e12ef89ad1', 'cc15b132263fd4fd2748c0e7cb9e1c4ad0afe70fcf9382ee644c4da8af0286a5'] },
    ],
  },
];

const b = fromHex32;
const flip = (hex: string, at = 0) => {
  const x = Buffer.from(hex, 'hex');
  x[at] ^= 1;
  return x.toString('hex');
};
const verifyHex = (root: string, id: string, index: number, proof: string[], count: number) => verifyMerkle(b(root), b(id), index, proof.map(b), count);

describe('release Merkle tree (v2/32) fixed vectors', () => {
  for (const v of VECTORS) {
    test(`${v.name} root`, () => expect(merkleRootHex(v.ids)).toBe(v.root));
    for (const p of v.proofs) {
      test(`${v.name} proof for index ${p.index}`, () => {
        expect(merkleProofHex(v.ids, v.ids[p.index])).toEqual(p);
        expect(verifyHex(v.root, v.ids[p.index], p.index, p.proof, v.ids.length)).toBe(true);
      });
    }
  }

  test('depth is ceil(log2(max(count, 1)))', () => {
    expect([1, 2, 3, 4, 5, 8, 9].map(merkleDepth)).toEqual([0, 1, 2, 2, 3, 3, 4]);
    expect(merkleDepth(0)).toBe(0);
  });

  test('order of the input does not change the root', () => {
    expect(merkleRootHex([fill(0x33), fill(0x11), fill(0x22)])).toBe(VECTORS[1].root);
  });

  test('refuses empty sets, duplicates and non-canonical ids', () => {
    expect(() => merkleRootHex([])).toThrow();
    expect(() => merkleRootHex([fill(0x11), fill(0x11)])).toThrow();
    expect(() => merkleRootHex([fill(0xab).toUpperCase()])).toThrow();
    expect(() => merkleRootHex(['11'])).toThrow();
    expect(() => merkleProofHex([fill(0x11)], fill(0x22))).toThrow();
  });
});

describe('release Merkle tree properties', () => {
  // ids derived from a counter so the sets are fixed and reproducible
  const idsOf = (n: number) => Array.from({ length: n }, (_, i) => Buffer.from(new Bun.CryptoHasher('sha256').update(`id-${n}-${i}`).digest()).toString('hex'));

  for (const n of [1, 2, 3, 5, 7, 8, 13]) {
    test(`count ${n}: every leaf verifies; flipped bytes, wrong index and wrong count fail`, () => {
      const ids = idsOf(n);
      const root = merkleRootHex(ids);
      for (const id of ids) {
        const { index, proof } = merkleProofHex(ids, id);
        expect(verifyHex(root, id, index, proof, n)).toBe(true);
        expect(verifyHex(flip(root), id, index, proof, n)).toBe(false);
        expect(verifyHex(root, flip(id, 31), index, proof, n)).toBe(false);
        for (let k = 0; k < proof.length; k++) expect(verifyHex(root, id, index, proof.map((p, j) => (j === k ? flip(p, 7) : p)), n)).toBe(false);
        if (n > 1) expect(verifyHex(root, id, (index + 1) % n, proof, n)).toBe(false);
        expect(verifyHex(root, id, index, proof, n * 2 + 1)).toBe(false); // deeper tree, proof too short
        if (merkleDepth(n) > 0) expect(verifyHex(root, id, index, proof.slice(1), n)).toBe(false);
        expect(verifyHex(root, id, n, proof, n)).toBe(false); // index past count lands on padding
      }
    });
  }

  test('a node cannot pass as a leaf (domain separation)', () => {
    const ids = idsOf(4);
    const { proof } = merkleProofHex(ids, ids[0]);
    // the level-1 node over leaves 2 and 3 is proof[1]; presenting it as an id of a depth-1 tree must fail
    expect(verifyHex(merkleRootHex(ids), proof[1], 1, [proof[0]], 2)).toBe(false);
  });

  test('emits test/fixtures/merkle.json for the Rust side', () => {
    const dir = join(import.meta.dir, 'fixtures');
    mkdirSync(dir, { recursive: true });
    const vectors = VECTORS.map((v) => ({
      name: v.name,
      count: v.ids.length,
      ids: v.ids,
      root: merkleRootHex(v.ids),
      proofs: v.ids.map((id) => ({ id, ...merkleProofHex(v.ids, id) })),
    }));
    const fixture = {
      description:
        'v2/32 release tree: leaf = sha256(0x00 || id32), leaves sorted ascending, padded with 32 zero bytes to a power of two, node = sha256(0x01 || left || right), proof = siblings leaf to root. Lowercase hex. Checked by backend/test/merkle.test.ts',
      vectors,
    };
    writeFileSync(join(dir, 'merkle.json'), JSON.stringify(fixture, null, 2) + '\n');
    expect(vectors.map((v) => v.root)).toEqual(VECTORS.map((v) => v.root));
    for (const v of vectors) for (const p of v.proofs) expect(verifyHex(v.root, p.id, p.index, p.proof, v.count)).toBe(true);
  });

  test('matches the contract fixture contracts/shop/tests/fixtures/merkle.json root for root and proof for proof', () => {
    const path = join(import.meta.dir, '..', '..', 'contracts', 'shop', 'tests', 'fixtures', 'merkle.json');
    if (!existsSync(path)) throw new Error(`run cargo test merkle_vectors first: ${path} is missing`);
    const rust = JSON.parse(readFileSync(path, 'utf8')) as {
      vectors: { count: number; depth: number; invoice_ids: string[]; root: string; proofs: { index: number; proof: string[] }[] }[];
    };
    expect(rust.vectors.length).toBe(VECTORS.length);
    for (const v of rust.vectors) {
      const ids = [...v.invoice_ids].sort();
      expect(merkleRootHex(ids)).toBe(v.root);
      expect(merkleDepth(v.count)).toBe(v.depth);
      for (const p of v.proofs) {
        const ours = merkleProofHex(ids, ids[p.index]);
        expect(ours.index).toBe(p.index);
        expect(ours.proof).toEqual(p.proof);
      }
    }
  });
});
