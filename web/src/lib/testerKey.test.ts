// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { testerKeyAction, testerKeyCli } from './testerKey'
import type { TesterPlan } from '@/lib/api/shop'

const vault = 'shop.acme.testnet'
const owner = 'acme.testnet'
const plan = (): TesterPlan => ({
  shopId: vault,
  signerId: owner,
  publicKey: 'ed25519:3i2NnweWn6o9vAofqqKkrUQzM2JBcKFBGXaRSN2xnvVb',
  receiverId: vault,
  methods: ['reveal', 'commit_batch', 'release', 'prove_delivery'],
  allowanceYocto: '1000000000000000000000000',
  minAllowanceYocto: '100000000000000000000000',
  enabled: false,
  state: 'ok',
})

describe('the tester AddKey is built and bounded in the browser', () => {
  it('builds a function-call key to the vault with exactly the tester methods', () => {
    const k = testerKeyAction(plan(), vault, owner)
    expect(k.action).toEqual({
      type: 'AddKey',
      params: {
        publicKey: plan().publicKey,
        accessKey: {
          permission: {
            receiverId: vault,
            allowance: '1000000000000000000000000',
            methodNames: [
              'commit_batch',
              'prove_delivery',
              'release',
              'reveal',
            ],
          },
        },
      },
    })
    expect(testerKeyCli(k, 'testnet')).toContain("--allowance '1 NEAR'")
  })

  it('caps the allowance at 1 NEAR and refuses anything off-plan', () => {
    expect(
      testerKeyAction(
        { ...plan(), allowanceYocto: '50000000000000000000000000' },
        vault,
        owner,
      ).allowanceYocto,
    ).toBe('1000000000000000000000000')
    const bad: Array<Partial<TesterPlan>> = [
      { shopId: 'evil.testnet' },
      { receiverId: 'evil.testnet' },
      { signerId: 'evil.testnet' },
      { publicKey: null },
      { publicKey: "ed25519:x' ; rm -rf ~ ; '" },
      {
        methods: ['commit_batch', 'prove_delivery', 'release', 'reveal', 'pay'],
      },
      { methods: ['commit_batch', 'prove_delivery', 'release', 'add_payee'] },
      { allowanceYocto: 'lots' },
    ]
    for (const b of bad)
      expect(() => testerKeyAction({ ...plan(), ...b }, vault, owner)).toThrow()
  })
})
