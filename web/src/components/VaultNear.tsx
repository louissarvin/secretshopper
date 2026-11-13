import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import CopyCmd from '@/components/CopyCmd'
import { Skel } from '@/components/QueryState'
import { usePolicy, useScorecard, useStatus } from '@/hooks/useShop'
import { viewAccount } from '@/lib/near/rpc'
import { signActions } from '@/lib/near/wallet'
import { topUpNear, vaultFunds } from '@/lib/vaultFunds'
import { config, explorerTx } from '@/config'
import { isAccountId, parseUnits, yoctoToNear } from '@/utils/near'

const MAX_TOP_UP = 100n * 10n ** 24n

export const useVaultFunds = (vault: string) => {
  const account = useQuery({
    queryKey: ['chain', vault, 'account'],
    queryFn: () => viewAccount(vault),
    refetchInterval: 15_000,
  })
  const policy = usePolicy(vault)
  const status = useStatus(vault)
  const sc = useScorecard(vault)
  if (!account.data || !policy.data || !status.data || !sc.data) return null
  return {
    owner: status.data.owner_id,
    mode: status.data.mode,
    gasKey: policy.data.key_nonces > 0,
    ...vaultFunds({
      amount: account.data.amount,
      storageUsage: account.data.storage_usage,
      policy: policy.data,
      mode: status.data.mode,
      openSlots: sc.data.pending + sc.data.overdue_unrevealed,
    }),
  }
}

/**
 * The vault's NEAR as the contract counts it, and a top-up from the owner's wallet. A gas-key vault needs free NEAR
 * for the vendor's accept_key; this shows the shortfall before the vendor's call fails on it.
 */
export default function VaultNear({ vault }: { vault: string }) {
  const qc = useQueryClient()
  const f = useVaultFunds(vault)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  if (!f) return <Skel h={120} />

  const short = f.mode !== 'Armed' && f.armShortfall > 0n
  const suggested = short ? topUpNear(f.armShortfall) : ''
  const value = amount || suggested
  const raw = parseUnits(value, 24)
  const valid = !!raw && BigInt(raw) > 0n && BigInt(raw) <= MAX_TOP_UP
  const near = valid ? yoctoToNear(raw, 4).replace(/\.?0+$/, '') : ''

  const send = async () => {
    if (!valid) return
    setBusy(true)
    setMsg(null)
    setHash(null)
    try {
      const out: any = await signActions(f.owner, vault, [
        { type: 'Transfer', params: { deposit: raw } },
      ])
      setHash(out?.transaction?.hash ?? null)
      setMsg({ ok: true, text: `Sent ${near} NEAR to the vault.` })
      setAmount('')
      await qc.invalidateQueries({ queryKey: ['chain', vault] })
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message : 'The wallet did not send it.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <dl className="kv">
        <dt>balance</dt>
        <dd>{yoctoToNear(String(f.balance))} NEAR</dd>
        <dt>held back</dt>
        <dd>
          {yoctoToNear(String(f.reserved))} NEAR for storage, reveals
          {f.gasKey && f.mode === 'Armed' ? ' and the re-key' : ''}
        </dd>
        <dt>free</dt>
        <dd>{yoctoToNear(String(f.free))} NEAR</dd>
        {f.gasKey && f.mode !== 'Armed' && (
          <>
            <dt>arming needs</dt>
            <dd>{yoctoToNear(String(f.armNeed))} NEAR free</dd>
          </>
        )}
      </dl>
      {short && (
        <p className="sheet-err" role="alert">
          The vendor cannot arm the agent yet: the gas key needs {suggested}{' '}
          NEAR more in the vault.
        </p>
      )}
      <div className="formgrid">
        <div className="field">
          <label htmlFor={`vn-${vault}`}>Add NEAR</label>
          <input
            id={`vn-${vault}`}
            inputMode="decimal"
            placeholder={suggested || '0.5'}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              setMsg(null)
            }}
          />
        </div>
        <div className="full">
          <button
            className={`btn ${short ? 'solid' : 'ghost'} sm`}
            type="button"
            onClick={send}
            disabled={busy || !valid}
          >
            {busy
              ? 'Waiting for your wallet…'
              : valid
                ? `Send ${near} NEAR from ${f.owner}`
                : 'Enter an amount up to 100 NEAR'}
          </button>
        </div>
      </div>
      {valid && isAccountId(f.owner) && isAccountId(vault) && (
        <CopyCmd
          cmd={`near tokens ${f.owner} send-near ${vault} '${near} NEAR' network-config ${config.network} sign-with-keychain send`}
        />
      )}
      {msg && (
        <small
          className={msg.ok ? 'dimt' : 'sheet-err'}
          role={msg.ok ? 'status' : 'alert'}
        >
          {msg.text}{' '}
          {hash && (
            <a
              className="txl"
              href={explorerTx(hash)}
              target="_blank"
              rel="noreferrer"
            >
              {hash.slice(0, 10)}…
            </a>
          )}
        </small>
      )}
      <span className="src">view_account · get_policy · get_scorecard</span>
    </div>
  )
}
