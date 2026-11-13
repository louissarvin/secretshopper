import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import CopyCmd from '@/components/CopyCmd'
import TesterSetup from '@/components/TesterSetup'
import VaultNear from '@/components/VaultNear'
import { useFeedback } from '@/components/Feedback'
import { usePayees, useStatus, useToken } from '@/hooks/useShop'
import { view } from '@/lib/near/rpc'
import { ONE_YOCTO, connectedAccount } from '@/lib/near/wallet'
import { config } from '@/config'
import {
  ED25519_RE,
  fmtUnits,
  isAccountId,
  parseUnits,
  short,
} from '@/utils/near'

const useFtBalance = (token?: string, account?: string) =>
  useQuery({
    queryKey: ['chain', token, 'ft_balance_of', account],
    enabled: !!token && !!account,
    queryFn: () =>
      view<string>('ft_balance_of', { account_id: account }, token),
    refetchInterval: 15_000,
  })

/**
 * Finishes setting up a new vault from the browser: approved payees, the agent key proposal, the vendor's
 * acceptance and token funding. Every value is read from the chain and every call is built here; the actions show
 * only to the vault's on-chain owner.
 */
export default function Onboard({ vaultId }: { vaultId: string }) {
  const { confirmCall } = useFeedback()
  const status = useStatus(vaultId)
  const payees = usePayees(vaultId)
  const s = status.data
  const token = useToken(s?.token_id)
  const balance = useFtBalance(s?.token_id, vaultId)
  const [me, setMe] = useState<string | null>(null)
  const [payee, setPayee] = useState({ account: '', label: '' })
  const [pk, setPk] = useState('')
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState<string | null>(null)

  // The owner may connect the wallet after this panel appears, so keep checking (a local call, no network)
  useEffect(() => {
    const check = () =>
      connectedAccount().then((a) => setMe(a?.accountId ?? null))
    void check()
    const id = setInterval(check, 3000)
    return () => clearInterval(id)
  }, [])

  if (!s) return null
  const owner = me === s.owner_id
  const sym = token.data?.symbol ?? 'tokens'
  const dec = token.data?.decimals
  const listed = (payees.data ?? []).filter((p) => !p.removed_at)
  const armed = s.mode === 'Armed'
  const funded = !!balance.data && BigInt(balance.data) > 0n
  const pending =
    s.pending_key && ED25519_RE.test(s.pending_key) ? s.pending_key : null

  const steps: Array<[string, string, boolean]> = [
    [
      'Approve payees',
      listed.length
        ? `${listed.length} on the vault's list`
        : 'None yet: the agent can pay only listed accounts',
      listed.length > 0,
    ],
    [
      'Propose the agent key',
      pending
        ? `Proposed ${short(pending, 12, 6)}`
        : armed
          ? 'Done'
          : 'Not yet',
      !!pending || armed,
    ],
    [
      'Vendor accepts',
      armed ? `Armed with ${short(s.agent_key, 12, 6)}` : `By ${s.vendor_id}`,
      armed,
    ],
    [
      `Fund with ${sym}`,
      balance.data && dec !== undefined
        ? `${fmtUnits(balance.data, dec)} ${sym} in the vault`
        : '…',
      funded,
    ],
  ]

  const addPayee = () => {
    if (!isAccountId(payee.account.trim()))
      return setErr('Enter the payee NEAR account.')
    const bytes = new TextEncoder().encode(payee.label.trim()).length
    if (!bytes || bytes > 64) return setErr('Add a label of at most 64 bytes.')
    setErr(null)
    void confirmCall({
      title: 'Approve payee',
      receiverId: vaultId,
      method: 'add_payee',
      args: { account_id: payee.account.trim(), label: payee.label.trim() },
      deposit: ONE_YOCTO,
      tgas: config.gasTgas.default,
      note: 'The payee becomes payable after the vault payee delay.',
    }).then((ok) => ok && setPayee({ account: '', label: '' }))
  }
  const propose = () => {
    if (!ED25519_RE.test(pk.trim()))
      return setErr('Use ed25519: followed by 43 or 44 base58 characters.')
    setErr(null)
    void confirmCall({
      title: 'Propose agent key',
      receiverId: vaultId,
      method: 'propose_key',
      args: { public_key: pk.trim() },
      deposit: ONE_YOCTO,
      tgas: config.gasTgas.default,
      note: 'The vendor then accepts the same key.',
    }).then((ok) => ok && setPk(''))
  }
  const fund = () => {
    // never convert with guessed decimals: a 2-decimal token would get 10,000 times the amount
    if (dec === undefined)
      return setErr('Could not read the token decimals yet.')
    const raw = parseUnits(amount, dec)
    if (!raw || BigInt(raw) === 0n)
      return setErr(`Enter a positive amount with at most ${dec} decimals.`)
    setErr(null)
    void confirmCall({
      title: `Send ${amount} ${sym} to the vault`,
      receiverId: s.token_id,
      method: 'ft_transfer',
      args: { receiver_id: vaultId, amount: raw },
      deposit: ONE_YOCTO,
      tgas: config.gasTgas.default,
      note: 'The vault was registered on the token when it was created.',
    }).then((ok) => ok && setAmount(''))
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <span className="label">Finish setting it up</span>
      <ol className="plan">
        {steps.map(([t, d, done]) => (
          <li key={t}>
            <b>
              {done ? '✓ ' : ''}
              {t}
            </b>
            <code>{d}</code>
          </li>
        ))}
      </ol>
      {!owner ? (
        <p className="dimt" style={{ fontSize: 14 }}>
          Connect the owner wallet, {s.owner_id}, to do these steps here.
        </p>
      ) : (
        <>
          <div className="formgrid">
            <div className="field">
              <label htmlFor="ob-pa">Payee account</label>
              <input
                id="ob-pa"
                value={payee.account}
                onChange={(e) =>
                  setPayee({ ...payee, account: e.target.value })
                }
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="ob-pl">Label</label>
              <input
                id="ob-pl"
                value={payee.label}
                onChange={(e) => setPayee({ ...payee, label: e.target.value })}
                maxLength={64}
              />
            </div>
            <div className="full">
              <button className="btn ghost sm" type="button" onClick={addPayee}>
                Approve payee
              </button>
            </div>
          </div>
          {!armed && !pending && (
            <div className="formgrid">
              <div className="field full">
                <label htmlFor="ob-pk">Agent public key</label>
                <input
                  id="ob-pk"
                  placeholder="ed25519:…"
                  value={pk}
                  onChange={(e) => setPk(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="full">
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={propose}
                >
                  Propose key
                </button>
              </div>
            </div>
          )}
          <div className="formgrid">
            <div className="field">
              <label htmlFor="ob-amt">Amount, {sym}</label>
              <input
                id="ob-amt"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="full">
              <button
                className="btn ghost sm"
                type="button"
                onClick={fund}
                disabled={dec === undefined}
              >
                Fund the vault
              </button>
            </div>
          </div>
          {err && (
            <small className="sheet-err" role="alert">
              {err}
            </small>
          )}
        </>
      )}
      {!armed && (
        <div style={{ display: 'grid', gap: 8 }}>
          <span className="label">Vault NEAR</span>
          <VaultNear vault={vaultId} />
        </div>
      )}
      {pending &&
        !armed &&
        isAccountId(s.vendor_id) &&
        isAccountId(vaultId) && (
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="label">
              For the vendor, {s.vendor_id}: accept the key
            </span>
            <CopyCmd
              cmd={[
                `near contract call-function as-transaction ${vaultId} accept_key \\`,
                `  json-args '${JSON.stringify({ public_key: pending })}' \\`,
                `  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \\`,
                `  sign-as ${s.vendor_id} network-config ${config.network} \\`,
                `  sign-with-keychain send`,
              ].join('\n')}
            />
            <small className="dimt">
              The vendor checks the key is its agent's before accepting.
            </small>
          </div>
        )}
      {owner && <TesterSetup vault={vaultId} owner={s.owner_id} />}
      <span className="src">get_status · get_payees · ft_balance_of</span>
    </div>
  )
}
