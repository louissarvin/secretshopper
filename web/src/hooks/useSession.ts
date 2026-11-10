import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authApi } from '@/lib/api/shop'
import { session } from '@/lib/api/client'
import {
  connectWallet,
  connectedAccount,
  disconnectWallet,
  signLogin,
} from '@/lib/near/wallet'

export type SignInStep = 'idle' | 'wallet' | 'challenge' | 'sign' | 'verify'

const ACCOUNT_KEY = 'ss-account'

/** NEP-413 sign-in: wallet, POST /auth/nonce, signMessage, POST /auth/verify → JWT for this tab. */
export function useSession() {
  const qc = useQueryClient()
  const [token, setToken] = useState<string | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [step, setStep] = useState<SignInStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setToken(session.get())
    try {
      setAccountId(sessionStorage.getItem(ACCOUNT_KEY))
    } catch {}
    setReady(true)
  }, [])

  const signIn = useCallback(async () => {
    setError(null)
    try {
      setStep('wallet')
      const { wallet, accountId: acct } =
        (await connectedAccount()) ?? (await connectWallet())
      setStep('challenge')
      const challenge = await authApi.nonce(acct)
      setStep('sign')
      const signed = await signLogin(wallet, acct, challenge)
      setStep('verify')
      const res = await authApi.verify(signed)
      session.set(res.token)
      try {
        sessionStorage.setItem(ACCOUNT_KEY, res.accountId)
      } catch {}
      setToken(res.token)
      setAccountId(res.accountId)
      // Reset, not invalidate: a 401 left from the old session must not outlive the new one
      await qc.resetQueries({ queryKey: ['owner'] })
      await qc.resetQueries({ queryKey: ['vendor'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
    } finally {
      setStep('idle')
    }
  }, [qc])

  const signOut = useCallback(async () => {
    session.set(null)
    try {
      sessionStorage.removeItem(ACCOUNT_KEY)
    } catch {}
    setToken(null)
    setAccountId(null)
    qc.removeQueries({ queryKey: ['owner'] })
    qc.removeQueries({ queryKey: ['vendor'] })
    await disconnectWallet()
  }, [qc])

  return { ready, token, accountId, step, error, signIn, signOut }
}
