import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type {
  ApprovedPayee,
  Decision,
  Payment,
  PendingLimits,
  Policy,
  Release,
  Scorecard,
  Status,
  TestSlot,
} from '@/lib/near/types'
import { view, viewAccessKeys } from '@/lib/near/rpc'
import { ownerApi, publicApi, vendorApi } from '@/lib/api/shop'
import { activeShop, session } from '@/lib/api/client'
import { csvObjects } from '@/lib/csv'

// A missing account or contract will not appear on retry; fail fast so the error shows at once
const chain = {
  staleTime: 15_000,
  refetchInterval: 30_000,
  retry: (n: number, e: any) =>
    !/UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CodeDoesNotExist|MethodNotFound/.test(
      e?.message,
    ) && n < 3,
}

// Contract views over RPC
export const useScorecard = (shopId: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'scorecard'],
    queryFn: () => view<Scorecard>('get_scorecard', {}, shopId),
    ...chain,
  })
export const useStatus = (shopId: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'status'],
    queryFn: () => view<Status>('get_status', {}, shopId),
    ...chain,
  })
export const usePolicy = (shopId: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'policy'],
    queryFn: () => view<Policy>('get_policy', {}, shopId),
    staleTime: 60_000,
  })
export const usePendingLimits = (shopId: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'pending_limits'],
    queryFn: () => view<PendingLimits | null>('get_pending_limits', {}, shopId),
    ...chain,
  })
export const useAccessKeys = (shopId: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'keys'],
    queryFn: () => viewAccessKeys(shopId),
    ...chain,
  })
export const useTestSlot = (shopId: string, slot: number, enabled = true) =>
  useQuery({
    queryKey: ['chain', shopId, 'test', slot],
    enabled,
    queryFn: () => view<TestSlot | null>('get_test', { slot_id: slot }, shopId),
    staleTime: 15_000,
  })
export const useDecision = (shopId: string, invoiceId?: string | null) =>
  useQuery({
    queryKey: ['chain', shopId, 'decision', invoiceId],
    enabled: !!invoiceId,
    queryFn: () =>
      view<Decision | null>('get_decision', { invoice_id: invoiceId }, shopId),
  })
export const useRelease = (shopId: string, releaseAtNs?: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'release', releaseAtNs],
    enabled: !!releaseAtNs,
    queryFn: () =>
      view<Release | null>('get_release', { release_at: releaseAtNs }, shopId),
  })
export const usePayees = (shopId: string) =>
  useQuery({
    queryKey: ['chain', shopId, 'payees'],
    queryFn: () =>
      view<Array<ApprovedPayee>>('get_payees', { from: 0, limit: 100 }, shopId),
    ...chain,
  })

export const useToken = (tokenId?: string) =>
  useQuery({
    queryKey: ['chain', 'ft_metadata', tokenId],
    enabled: !!tokenId,
    queryFn: () =>
      view<{ symbol: string; decimals: number }>('ft_metadata', {}, tokenId),
    staleTime: Infinity,
  })

/** The latest `limit` payments; get_payments indexes by payment id. */
export const useRecentPayments = (shopId: string, total?: number, limit = 20) =>
  useQuery({
    queryKey: ['chain', shopId, 'payments', total],
    enabled: total !== undefined,
    queryFn: async () => {
      const from = Math.max(0, (total ?? 0) - limit)
      const rows = await view<Array<Payment>>(
        'get_payments',
        { from, limit },
        shopId,
      )
      return rows.map((p, i) => ({ ...p, id: from + i })).reverse()
    },
    ...chain,
  })

// Public API
export const usePublicTests = (shopId: string) =>
  useInfiniteQuery({
    queryKey: ['api', shopId, 'tests'],
    queryFn: ({ pageParam }) => publicApi.tests(shopId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    staleTime: 30_000,
  })
export const usePublicTest = (shopId: string, slot: number, enabled = true) =>
  useQuery({
    queryKey: ['api', shopId, 'test', slot],
    enabled,
    queryFn: () => publicApi.test(shopId, slot),
    retry: (n, e: any) => e?.status !== 404 && n < 2,
  })
export const useReleases = (shopId: string, since?: string) =>
  useQuery({
    queryKey: ['api', shopId, 'releases', since],
    enabled: !!since,
    queryFn: () => publicApi.releases(shopId, since),
  })

// Each vault's owner and vendor data is cached under its own key (X-Shop), so one vault's figures never show under another
const shopKey = () => activeShop.value || 'default'

// Owner API, only with a session
// 401, 403 and 404 will not change on retry; fail fast so the right state shows at once
const noAuthRetry = (n: number, e: any) =>
  ![401, 403, 404].includes(e?.status) && n < 2
const owner = () => ({
  enabled: !!session.get(),
  staleTime: 15_000,
  retry: noAuthRetry,
})
export const useCompany = () =>
  useQuery({
    queryKey: ['owner', 'company', shopKey()],
    queryFn: ownerApi.company,
    ...owner(),
  })
export const useInvoices = () =>
  useInfiniteQuery({
    queryKey: ['owner', 'invoices', shopKey()],
    queryFn: ({ pageParam }) => ownerApi.invoices(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...owner(),
  })
export const useOwnerTests = () =>
  useQuery({
    queryKey: ['owner', 'tests', shopKey()],
    queryFn: () => ownerApi.tests(),
    ...owner(),
  })
export const useProposals = (status?: 'Pending' | 'Approved' | 'Rejected') =>
  useQuery({
    queryKey: ['owner', 'proposals', status, shopKey()],
    queryFn: () => ownerApi.proposals(status),
    ...owner(),
  })
export const useVendors = () =>
  useQuery({
    queryKey: ['owner', 'vendors', shopKey()],
    queryFn: ownerApi.vendors,
    ...owner(),
  })
export const useAlerts = () =>
  useInfiniteQuery({
    queryKey: ['owner', 'alerts', shopKey()],
    queryFn: ({ pageParam }) => ownerApi.alerts(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
    ...owner(),
  })

// Vendor console, same session as the owner app
const vendor = () => ({
  enabled: !!session.get(),
  staleTime: 15_000,
  retry: noAuthRetry,
})
export const useVendorMe = () =>
  useQuery({
    queryKey: ['vendor', 'me', shopKey()],
    queryFn: vendorApi.me,
    refetchInterval: 30_000,
    ...vendor(),
  })
export const useVendorVaults = () =>
  useQuery({
    queryKey: ['vendor', 'vaults'],
    queryFn: vendorApi.vaults,
    ...vendor(),
  })
export const useVendorHistory = (enabled: boolean) =>
  useInfiniteQuery({
    queryKey: ['vendor', 'history', shopKey()],
    queryFn: ({ pageParam }) => vendorApi.history(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    ...vendor(),
    enabled: enabled && !!session.get(),
  })

// Self-serve vaults
export const useVaultTemplate = () =>
  useQuery({
    queryKey: ['api', 'vault-template'],
    queryFn: publicApi.vaultTemplate,
    staleTime: 5 * 60_000,
    retry: (n, e: any) => e?.status !== 404 && n < 2,
  })
/** A vault on the published code; polls while it is being created. */
export const useVault = (vaultId: string | null, poll = false) =>
  useQuery({
    queryKey: ['api', 'vault', vaultId],
    enabled: !!vaultId,
    queryFn: () => publicApi.vault(vaultId!),
    retry: (n, e: any) => ![404, 422, 503].includes(e?.status) && n < 2,
    refetchInterval: poll ? 5_000 : false,
  })

export const useModelRuns = () =>
  useQuery({
    queryKey: ['api', 'model-runs'],
    queryFn: publicApi.modelRuns,
    staleTime: 10 * 60_000,
    retry: (n, e: any) => ![404, 503].includes(e?.status) && n < 2,
  })
export const useSchedule = (shopId: string) =>
  useQuery({
    queryKey: ['api', shopId, 'schedule'],
    queryFn: () => publicApi.schedule(shopId),
    refetchInterval: 60_000,
    retry: (n, e: any) => e?.status !== 404 && n < 2,
  })
/** The public ledger, parsed from the API's CSV; the route allows 10 reads a minute, so it is cached */
export const useLedger = (shopId: string) =>
  useQuery({
    queryKey: ['api', shopId, 'ledger'],
    queryFn: async () =>
      csvObjects(await (await publicApi.ledgerCsv(shopId)).text()),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (n, e: any) => ![404, 429].includes(e?.status) && n < 1,
  })
export const useVerifyReport = () =>
  useQuery({
    queryKey: ['api', 'verify-report'],
    queryFn: publicApi.verifyReport,
    staleTime: 10 * 60_000,
    retry: (n, e: any) => ![404, 503].includes(e?.status) && n < 2,
  })
export const useBlocklist = () =>
  useInfiniteQuery({
    queryKey: ['api', 'blocklist'],
    queryFn: ({ pageParam }) => publicApi.blocklist(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    staleTime: 30_000,
  })
export const useBlocklistOf = (accountId?: string) =>
  useQuery({
    queryKey: ['api', 'blocklist', accountId],
    enabled: !!accountId,
    queryFn: () => publicApi.blocklistOf(accountId!),
    staleTime: 60_000,
  })
export const useThroughput = (shopId: string) =>
  useQuery({
    queryKey: ['api', shopId, 'throughput'],
    queryFn: () => publicApi.throughput(shopId),
    staleTime: 60_000,
    retry: (n, e: any) => ![404, 503].includes(e?.status) && n < 2,
  })
export const useAgentReputation = (vendorId: string) =>
  useQuery({
    queryKey: ['api', 'agent', vendorId],
    queryFn: () => publicApi.agent(vendorId),
    staleTime: 5 * 60_000,
    retry: (n, e: any) => ![404, 503].includes(e?.status) && n < 2,
  })
/** Every vault the signed-in owner registered; 404 on an API without multi-vault falls back to this build's vault */
export const useCompaniesMine = () =>
  useQuery({
    queryKey: ['owner', 'mine'],
    queryFn: ownerApi.mine,
    ...owner(),
  })
export const useTesterPlan = (shopId?: string) =>
  useQuery({
    queryKey: ['api', shopId, 'tester'],
    enabled: !!shopId,
    queryFn: () => publicApi.testerOf(shopId!),
    retry: (n, e: any) => ![404, 503].includes(e?.status) && n < 2,
    // the tester provisions its key within a minute of registration
    refetchInterval: (q) => (q.state.data?.publicKey ? false : 15_000),
  })
