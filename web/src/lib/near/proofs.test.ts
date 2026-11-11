// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitmentOf, keyScope, merkleTree, rootFromProof } from './proofs'

const fixture = (p: string) =>
  JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../backend/test/fixtures', p),
      'utf8',
    ),
  )

describe('browser proofs match the backend and contract fixtures', () => {
  it('commitment', async () => {
    for (const v of fixture('commitment.json').vectors)
      expect(
        await commitmentOf(v.salt, v.payee, v.invoice_id, v.receipt_hash),
      ).toBe(v.commitment)
  })

  it('release Merkle root and proofs', async () => {
    for (const v of fixture('merkle.json').vectors) {
      const tree = await merkleTree(v.ids)
      expect(tree.root).toBe(v.root)
      for (const p of v.proofs) {
        expect(tree.proofFor(p.id)).toEqual({ index: p.index, proof: p.proof })
        expect(await rootFromProof(p.id, p.index, p.proof)).toBe(v.root)
      }
    }
  })

  it('a changed byte breaks the commitment', async () => {
    const v = fixture('commitment.json').vectors[0]
    expect(
      await commitmentOf(
        v.salt,
        v.payee.slice(0, -1) + 'e',
        v.invoice_id,
        v.receipt_hash,
      ),
    ).not.toBe(v.commitment)
  })

  it('access keys fail closed', () => {
    expect(keyScope('FullAccess').kind).toBe('full')
    expect(keyScope({ GasKeyFullAccess: {} }).kind).toBe('full')
    expect(
      keyScope({
        GasKeyFunctionCall: { receiver_id: 'v', method_names: ['pay'] },
      }),
    ).toMatchObject({ kind: 'function', gasKey: true })
    expect(
      keyScope({ FunctionCall: { receiver_id: 'v', method_names: [1] } }).kind,
    ).toBe('unknown')
    expect(keyScope({ A: 1, B: 2 }).kind).toBe('unknown')
  })
})
