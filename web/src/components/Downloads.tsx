import { useState } from 'react'
import { publicApi } from '@/lib/api/shop'
import { saveBlob } from '@/lib/download'

const today = () => new Date().toISOString().slice(0, 10)

/** Ledger CSV for accountants: one row per payment, proposal, decline and test slot. */
export function LedgerDownload({ shopId }: { shopId: string }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const get = async () => {
    if (from && to && from >= to)
      return setErr('The start date must be before the end date.')
    setBusy(true)
    setErr(null)
    try {
      const blob = await publicApi.ledgerCsv(shopId, from, to)
      saveBlob(
        `ledger-${shopId}${from || to ? `-${from || 'start'}-to-${to || today()}` : ''}.csv`,
        blob,
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The download failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dl">
      <p className="dimt">
        Every payment, proposal, decline and test slot as a spreadsheet, rebuilt
        from the vault's on-chain events with a link to each transaction. Leave
        the dates empty for everything.
      </p>
      <div className="dl-row">
        <div className="field">
          <label htmlFor="lg-from">From (UTC)</label>
          <input
            id="lg-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="lg-to">To, not included</label>
          <input
            id="lg-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <button
          className="btn solid sm"
          type="button"
          onClick={get}
          disabled={busy}
        >
          {busy ? 'Building…' : 'Download ledger (CSV)'}
        </button>
      </div>
      {err && (
        <small className="sheet-err" role="alert">
          {err}
        </small>
      )}
      <span className="src">GET /public/ledger/:shopId</span>
    </div>
  )
}

/** The public evidence bundle that scripts/verify-evidence.ts checks against the chain. */
export function EvidenceDownload({ shopId }: { shopId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const get = async () => {
    setBusy(true)
    setErr(null)
    try {
      const bundle = await publicApi.evidence(shopId)
      saveBlob(
        `evidence-${shopId}.json`,
        new Blob([JSON.stringify(bundle, null, 2)], {
          type: 'application/json',
        }),
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The download failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dl">
      <button
        className="btn ghost sm"
        type="button"
        onClick={get}
        disabled={busy}
      >
        {busy ? 'Collecting pages…' : 'Download evidence bundle (JSON)'}
      </button>
      {err && (
        <small className="sheet-err" role="alert">
          {err}
        </small>
      )}
      <span className="src">GET /public/evidence/:shopId</span>
    </div>
  )
}
