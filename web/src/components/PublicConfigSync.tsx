import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import { applyPublicConfig, mismatch } from '@/config'

/** Reads GET /public/config once and re-renders the app if the API serves another vault or network than the env. */
export default function PublicConfigSync({
  children,
}: {
  children: React.ReactNode
}) {
  const qc = useQueryClient()
  const [rev, setRev] = useState(0)
  const [warn, setWarn] = useState('')
  useEffect(() => {
    api<{ network: string; explorerUrl: string; shop: string }>(
      '/public/config',
    )
      .then((c) => {
        if (applyPublicConfig(c)) {
          qc.clear()
          setRev((n) => n + 1)
        } else if (mismatch.value) setWarn(mismatch.value)
      })
      // The env values stay in use when the API is unreachable
      .catch(() => {})
  }, [qc])
  return (
    <div key={rev} style={{ display: 'contents' }}>
      {warn && (
        <p className="cfg-warn" role="alert">
          {warn}
        </p>
      )}
      {children}
    </div>
  )
}
