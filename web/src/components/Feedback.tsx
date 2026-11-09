import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ShopCall } from '@/lib/near/wallet'
import { callShop } from '@/lib/near/wallet'
import { config } from '@/config'
import { yoctoToNear } from '@/utils/near'

interface ConfirmCall extends ShopCall {
  title: string
  note?: string
}

interface Ctx {
  toast: (msg: string) => void
  /** Shows the exact call, then hands it to the wallet. Resolves true once the transaction succeeded. */
  confirmCall: (call: ConfirmCall) => Promise<boolean>
}

const FeedbackContext = createContext<Ctx | null>(null)

export function useFeedback() {
  const c = useContext(FeedbackContext)
  if (!c) throw new Error('useFeedback needs FeedbackProvider')
  return c
}

const failureOf = (outcome: any): string | null => {
  const s = outcome?.status
  if (s && typeof s === 'object' && 'Failure' in s)
    return JSON.stringify(s.Failure).slice(0, 200)
  return null
}

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const [call, setCall] = useState<ConfirmCall | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const okBtn = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const toast = useCallback((m: string) => {
    setMsg(m)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMsg(null), 3400)
  }, [])

  const confirmCall = useCallback((c: ConfirmCall) => {
    setErr(null)
    setCall(c)
    return new Promise<boolean>((res) => (resolver.current = res))
  }, [])

  const close = (ok: boolean) => {
    if (busy) return
    setCall(null)
    resolver.current?.(ok)
    resolver.current = null
  }

  const send = async () => {
    if (!call) return
    setBusy(true)
    setErr(null)
    try {
      const outcome = await callShop(call)
      const failed = failureOf(outcome)
      if (failed) throw new Error(`The vault rejected it: ${failed}`)
      await qc.invalidateQueries({ queryKey: ['chain'] })
      await qc.invalidateQueries({ queryKey: ['owner'] })
      await qc.invalidateQueries({ queryKey: ['vendor'] })
      setBusy(false)
      setCall(null)
      resolver.current?.(true)
      resolver.current = null
      toast(
        `${call.title}: sent. ${(outcome as any)?.transaction?.hash ? 'Tx ' + String((outcome as any).transaction.hash).slice(0, 10) + '…' : ''}`,
      )
    } catch (e) {
      setBusy(false)
      setErr(
        e instanceof Error
          ? e.message
          : 'The wallet did not send the transaction.',
      )
    }
  }

  useEffect(() => {
    if (!call) return
    okBtn.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close(false)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  })

  return (
    <FeedbackContext.Provider value={{ toast, confirmCall }}>
      {children}
      <div
        className={`scrim${call ? ' on' : ''}`}
        onClick={() => close(false)}
      />
      <div
        className={`sheet${call ? ' on' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        inert={!call}
      >
        <span className="label">Confirm, then sign in your wallet</span>
        <h3 id="sheet-title">{call?.title}</h3>
        <pre>
          {call
            ? `receiver  ${call.receiverId ?? config.shopId}\nmethod    ${call.method}\nargs      ${JSON.stringify(call.args)}\ndeposit   ${call.deposit === '1' ? '1 yoctoNEAR' : yoctoToNear(call.deposit, 6) + ' NEAR'}\ngas       ${call.tgas} Tgas`
            : ''}
        </pre>
        {call?.note && <p style={{ fontSize: 14 }}>{call.note}</p>}
        {err && (
          <p className="sheet-err" role="alert">
            {err}
          </p>
        )}
        <div className="acts">
          <button
            ref={okBtn}
            className="btn solid"
            type="button"
            onClick={send}
            disabled={busy}
          >
            {busy ? 'Waiting for your wallet…' : 'Open wallet and sign'}
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => close(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
      <div
        className={`toast${msg ? ' on' : ''}`}
        role="status"
        aria-live="polite"
      >
        <i />
        <span>{msg}</span>
      </div>
    </FeedbackContext.Provider>
  )
}
