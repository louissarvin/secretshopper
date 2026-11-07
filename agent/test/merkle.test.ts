import { describe, expect, test } from 'bun:test';
import { fromHex32, merkleProofHex, merkleRootHex, verifyMerkle } from '../src/merkle.ts';

// Same fixed vectors as backend/test/merkle.test.ts and the contract (v2/32), from an independent Python hashlib
// computation. Both copies of the tree must hold them, so the agent's acks match the tester's roots.
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

describe('agent copy of the release Merkle tree', () => {
  for (const v of VECTORS) {
    test(`${v.name} root, any input order`, () => {
      expect(merkleRootHex(v.ids)).toBe(v.root);
      expect(merkleRootHex([...v.ids].reverse())).toBe(v.root);
    });
    for (const p of v.proofs) {
      test(`${v.name} proof for index ${p.index}`, () => {
        expect(merkleProofHex(v.ids, v.ids[p.index])).toEqual(p);
        expect(verifyMerkle(fromHex32(v.root), fromHex32(v.ids[p.index]), p.index, p.proof.map(fromHex32), v.ids.length)).toBe(true);
      });
    }
  }

  test('refuses empty sets, duplicates and non-canonical ids', () => {
    expect(() => merkleRootHex([])).toThrow();
    expect(() => merkleRootHex([fill(0x11), fill(0x11)])).toThrow();
    expect(() => merkleRootHex([fill(0xab).toUpperCase()])).toThrow();
  });
});
