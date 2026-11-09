import { useState } from 'react'

/** A shell command with a copy button, for wallets that cannot sign an action. */
export default function CopyCmd({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd)
      setDone(true)
      setTimeout(() => setDone(false), 1600)
    } catch {}
  }
  return (
    <div className="copycmd">
      <pre>{cmd}</pre>
      <button className="btn ghost sm" type="button" onClick={copy}>
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
