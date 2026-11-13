import { ApiError, api } from './client'
import type {
  Decision,
  Policy,
  Scorecard,
  Status,
  TestStatus,
} from '@/lib/near/types'
import type { ConnectorAction } from '@hot-labs/near-connect'
import { config } from '@/config'

// Shapes from backend/src/routes. Dates are ISO strings.

export interface SlotView {
  slotIndex: number
  commitment: string
  status: TestStatus
  expiresAt: string | null
  revealed: boolean
  contained?: boolean
  revealedPayee?: string | null
  revealedSalt?: string | null
  revealedInvoiceId?: string | null
  revealTxHash?: string | null
  revealedAt?: string | null
  sweptTxHash?: string | null
}

export interface InvoiceEmail {
  from_name: string
  from_email: string
  subject: string
  body: string
}

export interface AiReceipt {
  responseId: string
  model: string
  signatureKind: 'provider_tee' | 'gateway'
  signingAlgo: string
  signingAddress: string
  signedText: string
  signature: string
  requestBody: string
  responseBody: string
  createdAt: string
  assurance: string
  assuranceNote: string
  // Summary of the stored TEE attestation; null for receipts written before it was kept.
  attestation: {
    kind: string
    bound: boolean
    signer: { signingAlgo: string; signingAddress: string }
    tcbStatus: string
    advisoryIds: Array<string>
    deploymentProvenance: string
    gpuEvidence: string
    verifiedAt: string
  } | null
}

export interface PublicTest extends SlotView {
  invoice: {
    invoiceId: string
    document: Record<string, unknown>
    email: InvoiceEmail
    deliverAt: string
  } | null
  receipt: AiReceipt | null
  commitTx: { txHash: string; signerId: string | null } | null
  decisionTx: {
    kind: 'Paid' | 'Declined' | 'Proposed'
    txHash: string
    receiptId: string
    at: string
  } | null
  demotion: { txHash: string; receiptId: string; at: string } | null
}

export interface ReleaseTick {
  releaseAt: string
  releaseAtNs: string
  count: number
  root: string
  ids: Array<string>
}

export interface Company {
  id: string
  name: string
  shopContractId: string
  vendorAccountId: string
  deployBlock: string
  createdAt: string
}

export interface InvoiceItem {
  invoiceId: string
  deliverAt: string
  document: Record<string, unknown>
  email: InvoiceEmail
  decision: Decision | null
  decisionUnavailable: boolean
}

export interface ProposalRow {
  proposalId: number
  invoiceId: string
  payee: string
  amount: string
  status: 'Pending' | 'Approved' | 'Rejected'
  receiptId: string
  txHash: string
  blockHeight: string
  createdAt: string
}

export interface Vendor {
  id: string
  legalName: string
  contactEmail: string
  approvedPayees: Array<{
    account: string
    rail: 'Near' | 'Intents'
    addedAt: string
  }>
  sampleInvoices: Array<unknown>
  styleSet: Array<unknown>
  createdAt: string
  updatedAt: string
}

export interface VaultTemplate {
  network: string
  codeHash: string
  codePublished: boolean
  planEnabled: boolean
  defaultTokenId: string
  defaultPolicy: Record<string, unknown>
  policyBounds: Record<string, unknown>
  minFundingYocto: string
  notes: Array<string>
}

export interface VaultPlan {
  vaultId: string
  signerId: string
  totalYocto: string
  transactions: Array<{ receiverId: string; actions: Array<ConnectorAction> }>
  cli: Array<string>
  next: Array<string>
  warnings?: Array<string>
  /** The final init args, including the merged policy */
  init?: { policy?: Record<string, unknown> }
  token?: { symbol: string; decimals: number }
}

export interface VaultView {
  vaultId: string
  codeHash: string
  /** Capped at 20 items; count full-access keys from keySummary */
  keys: Array<{ public_key: string; access_key: { permission: unknown } }>
  keySummary?: { count: number; fullAccess?: number; truncated?: boolean }
  status: Status | null
  scorecard: Scorecard | null
  policy: Policy | null
  registered: boolean
  createdTx?: string | null
}

/** One alert-worthy event; `text` is plain text from the API. */
export interface ActivityItem {
  id: string
  kind: string
  at: string
  text: string
  txHash: string | null
  slot: number | null
  proposalId: number | null
}

export interface ActivityPage {
  items: Array<ActivityItem>
  nextBefore: string | null
}

export interface VendorMe {
  vault: string
  network: string
  vendorId: string
  ownerId: string
  mode: Status['mode']
  agentKey: string | null
  pendingKey: string | null
  pendingKeyProposedAt: string | null
  armedAt: string | null
  demotedAt: string | null
  cooldownEndsAt: string | null
  staleKey: string | null
  scorecard: Scorecard
  limits: Record<string, unknown>
  /** Contract policy terms the vendor agrees to by accepting, raw units */
  fairness?: Record<string, unknown>
  fairnessWarnings?: Array<string>
  /** False when the proposed key is not the agent key the vault last armed */
  pendingKeyMatchesArmed?: boolean | null
  acceptKey: {
    receiverId: string
    methodName: 'accept_key'
    args: { public_key: string }
    gas: string
    deposit: string
  } | null
}

export interface ModelRun {
  id: string
  date: string
  title: string
  lureKind: string
  /** Present on runs measured under a named AP policy, for example "strict" or "realistic" */
  policy?: string
  preflightMode?: string
  categories: Array<string>
  trialsPerModel: number
  totalCalls: number
  models: Array<{
    model: string
    receiptKind: string
    trials: number
    declined: number
    paid: number
    proposed: number
    noDecision: number
    error: number
    genuinePaid: number
    genuineTotal: number
    receiptsVerified: number
    receiptsTotal: number
  }>
}

export interface ModelRuns {
  runs: Array<ModelRun>
  source: Array<string>
  b1: {
    run: string
    judge: string
    accuracy: number
    wilsonLow: number
    wilsonHigh: number
    auc: number
    n: number
    limitAccuracy: number
    limitAuc: number
    date: string
    pass: string
    source: string
  } | null
}

export interface Schedule {
  now: string
  releaseTickMinutes: number
  nextReleaseAt: string
  lastBatch: {
    batchIndex: number
    committedAt: string
    expiresAt: string
  } | null
  nextBatchEarliestAt: string | null
  pending: number
  nextRevealAfter: string | null
}

/** The committed result of the last `bun run verify` */
export interface VerifyReport {
  generatedAt: string | null
  ok: boolean
  passed: number
  failed: number
  skipped: number
  steps: Array<{
    step: string
    status: string
    seconds: number
    summary: string
  }>
  counts: Record<
    | 'contractUnit'
    | 'contractAudit'
    | 'contractCost'
    | 'contractSandbox'
    | 'backendPass'
    | 'backendSkip'
    | 'backendFail'
    | 'agentPass'
    | 'agentFail'
    | 'demoChecks'
    | 'mcpChecks',
    number | null
  >
}

/** A shared blocklist entry; each is backed by a transaction on this API's vault */
export interface BlockEntry {
  id: string
  accountId: string
  reason: string
  evidenceTx: string
  evidenceKind: string
  reporterKind: string
  reporterId: string | null
  vault: string
  verified: boolean
  createdAt: string
}

/** Genuine invoices only, delivered before asOf, so no sealed lure can leak through the counts */
export interface Throughput {
  shopId: string
  asOf: string
  excludedOpenWindow: boolean
  delivered: number
  autoPaid: number
  proposed: number
  approvedByOwner: number
  declined: number
  undecided: number
  ratiosBps: Record<
    'autoPaid' | 'paid' | 'proposed' | 'approval' | 'declined' | 'undecided',
    number | null
  >
  source: string
}

/** Every vault a vendor armed on chain, with each scorecard and a pooled one */
export interface AgentReputation {
  vendorId: string
  vaults: Array<{
    vaultId: string
    ownerId: string
    ownedByVendor: boolean
    mode: string
    version: string
    agentKey: string | null
    armedAt: string | null
    demotions: number
    scorecard: Scorecard | null
  }>
  aggregate: {
    vaults: number
    distinctOwners: number
    passed: number
    failed: number
    failedContained: number
    ignored: number
    unanswered: number
    scoreBps: number | null
    demotions: number
  }
  caveat: string
  truncated: { txs: boolean; vaults: boolean }
}

/** A company as GET /company/mine lists it: one per registered vault */
export interface CompanyView {
  id: string
  name: string
  shopContractId: string
  vendorAccountId: string
  deployBlock: string
  createdTxHash: string | null
  createdAt: string
  isDefault: boolean
  tester: {
    enabled: boolean
    testPercent: number
    commitCron: string | null
    publicKey: string | null
    state: string | null
  }
  inboxTokenSet: boolean
}

/** What the owner's tester key must look like; GET /public/tester/:shopId */
export interface TesterPlan {
  shopId: string
  signerId: string
  publicKey: string | null
  receiverId: string
  methods: Array<string>
  allowanceYocto: string
  minAllowanceYocto: string
  enabled: boolean
  state: string | null
}

const enc = encodeURIComponent

export const publicApi = {
  tests: (shopId: string, before?: number, limit = 50) =>
    api<{ items: Array<SlotView>; nextBefore: number | null }>(
      `/public/tests/${enc(shopId)}`,
      { query: { limit, before } },
    ),
  test: (shopId: string, slot: number) =>
    api<PublicTest>(`/public/tests/${enc(shopId)}/${slot}`),
  releases: (shopId: string, since?: string, limit = 100) =>
    api<{ items: Array<ReleaseTick>; nextSince: string | null }>(
      `/public/releases/${enc(shopId)}`,
      { query: { since, limit } },
    ),
  vaultTemplate: () => api<VaultTemplate>('/public/vault-template'),
  vaultPlan: (body: {
    ownerId: string
    name: string
    vendorId: string
    tokenId?: string
    fundNear: string
    policy?: Record<string, string>
  }) => api<VaultPlan>('/public/vault-plan', { method: 'POST', body }),
  vault: (shopId: string) => api<VaultView>(`/public/vault/${enc(shopId)}`),
  testerOf: (shopId: string) =>
    api<TesterPlan>(`/public/tester/${enc(shopId)}`),
  modelRuns: () => api<ModelRuns>('/public/model-runs'),
  verifyReport: () => api<VerifyReport>('/public/verify-report'),
  throughput: (shopId: string) =>
    api<Throughput>(`/public/throughput/${enc(shopId)}`),
  agent: (vendorId: string) =>
    api<AgentReputation>(`/public/agent/${enc(vendorId)}`),
  blocklist: (before?: string) =>
    api<{ items: Array<BlockEntry>; nextBefore: string | null }>(
      '/public/blocklist',
      { query: { limit: 50, before } },
    ),
  blocklistOf: (accountId: string) =>
    api<{
      accountId: string
      listed: boolean
      count: number
      entries: Array<BlockEntry>
    }>(`/public/blocklist/${enc(accountId)}`),
  schedule: (shopId: string) =>
    api<Schedule>(`/public/schedule/${enc(shopId)}`),
  /** The ledger CSV, built by the API from on-chain events */
  ledgerCsv: async (shopId: string, from?: string, to?: string) => {
    const url = new URL(`${config.apiUrl}/public/ledger/${enc(shopId)}`)
    if (from) url.searchParams.set('from', from)
    if (to) url.searchParams.set('to', to)
    let res: Response
    try {
      res = await fetch(url)
    } catch {
      throw new ApiError(
        'NETWORK',
        `Cannot reach the API at ${config.apiUrl}.`,
        0,
      )
    }
    if (res.ok) return res.blob()
    const body = await res.json().catch(() => null)
    throw new ApiError(
      body?.error?.code ?? 'HTTP',
      res.status === 429
        ? 'Ten ledger downloads a minute at most. Try again in a minute.'
        : (body?.error?.message ?? `The API answered ${res.status}.`),
      res.status,
    )
  },
  /** Every page of the public evidence bundle, merged into one document */
  evidence: async (shopId: string) => {
    type Page = {
      slots: Array<unknown>
      batches: Array<unknown>
      next_from_slot: number | null
    } & Record<string, unknown>
    let page = await api<Page>(`/public/evidence/${enc(shopId)}`)
    const first = page
    const slots = [...page.slots]
    const batches = new Map(page.batches.map((b) => [JSON.stringify(b), b]))
    while (page.next_from_slot !== null) {
      page = await api<Page>(`/public/evidence/${enc(shopId)}`, {
        query: { fromSlot: page.next_from_slot },
      })
      slots.push(...page.slots)
      for (const b of page.batches) batches.set(JSON.stringify(b), b)
    }
    return {
      ...first,
      slots,
      batches: [...batches.values()],
      next_from_slot: null,
    }
  },
}

export const vendorApi = {
  me: () => api<VendorMe>('/vendor/me', { auth: true }),
  /** Vaults that name the caller as vendor; a hint, every vendor route re-checks on chain */
  vaults: () =>
    api<{ items: Array<{ shopContractId: string; name: string }> }>(
      '/vendor/vaults',
      { auth: true },
    ),
  history: (before?: string) =>
    api<ActivityPage>('/vendor/history', {
      auth: true,
      query: { limit: 30, before },
    }),
}

export const authApi = {
  nonce: (accountId: string) =>
    api<{ message: string; recipient: string; nonce: string }>('/auth/nonce', {
      method: 'POST',
      body: { accountId },
    }),
  verify: (body: {
    accountId: string
    publicKey: string
    signature: string
    nonce: string
  }) =>
    api<{ token: string; accountId: string }>('/auth/verify', {
      method: 'POST',
      body,
    }),
}

export const ownerApi = {
  company: () => api<Company | null>('/company/me', { auth: true }),
  registerCompany: (name: string, deployBlock: string) =>
    api<Company>('/company', {
      method: 'POST',
      auth: true,
      body: { name, deployBlock },
    }),
  invoices: (cursor?: string) =>
    api<{ items: Array<InvoiceItem>; nextCursor: string | null }>('/invoices', {
      auth: true,
      query: { limit: 50, cursor },
    }),
  addInvoice: (body: {
    vendorId: string
    document: Record<string, unknown>
    email: InvoiceEmail
  }) =>
    api<{ invoiceId: string; deliverAt: string }>('/invoices', {
      method: 'POST',
      auth: true,
      body,
    }),
  tests: (before?: number) =>
    api<{ items: Array<SlotView>; nextBefore: number | null }>('/tests', {
      auth: true,
      query: { limit: 100, before },
    }),
  proposals: (status?: ProposalRow['status']) =>
    api<{ items: Array<ProposalRow>; nextBefore: number | null }>(
      '/proposals',
      {
        auth: true,
        query: { limit: 100, status },
      },
    ),
  vendors: () =>
    api<{ items: Array<Vendor>; nextCursor: string | null }>('/vendors', {
      auth: true,
      query: { limit: 100 },
    }),
  addVendor: (body: {
    legalName: string
    contactEmail: string
    approvedPayees: Array<{ account: string; rail: 'Near' | 'Intents' }>
    sampleInvoices: Array<object>
  }) => api<Vendor>('/vendors', { method: 'POST', auth: true, body }),
  updateVendor: (
    id: string,
    body: Partial<{
      legalName: string
      contactEmail: string
      sampleInvoices: Array<object>
    }>,
  ) => api<Vendor>(`/vendors/${enc(id)}`, { method: 'PUT', auth: true, body }),
  mine: () =>
    api<{ items: Array<CompanyView> }>('/company/mine', { auth: true }),
  /** Registers a self-serve vault; the server derives its deploy block */
  registerVault: (name: string, shopId: string) =>
    api<CompanyView>('/company', {
      method: 'POST',
      auth: true,
      body: { name, shopId },
    }),
  /** Renames the company of the vault in X-Shop */
  rename: (name: string, shop: string) =>
    api<CompanyView>('/company', {
      method: 'PATCH',
      auth: true,
      body: { name },
      shop,
    }),
  /** Tester settings for the vault in X-Shop */
  tester: (shop?: string) =>
    api<
      TesterPlan & {
        testPercent: number
        commitCron: string | null
        testerCheckedAt: string | null
      }
    >('/company/tester', { auth: true, shop }),
  setTester: (
    body: {
      enabled: boolean
      testPercent?: number
      commitCron?: string | null
    },
    shop?: string,
  ) =>
    api<unknown>('/company/tester', {
      method: 'PUT',
      auth: true,
      body,
      shop,
    }),
  /** A new agent inbox token for the vault in X-Shop; shown once, rotates the old one */
  inboxToken: (shop?: string) =>
    api<{ token: string; shopContractId: string; createdAt: string }>(
      '/company/inbox-token',
      { method: 'POST', auth: true, shop },
    ),
  reportPayee: (body: {
    accountId: string
    reason: string
    evidenceTx: string
  }) =>
    api<{ created: boolean; entry: BlockEntry }>('/blocklist', {
      method: 'POST',
      auth: true,
      body,
    }),
  alerts: (before?: string) =>
    api<ActivityPage>('/company/alerts', {
      auth: true,
      query: { limit: 20, before },
    }),
}
