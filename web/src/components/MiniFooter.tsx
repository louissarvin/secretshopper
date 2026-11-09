import { Link } from '@tanstack/react-router'
import ScanlineWordmark from '@/components/elements/ScanlineWordmark'
import { config } from '@/config'

export default function MiniFooter({ note }: { note: string }) {
  return (
    <footer className="mini-foot">
      <div className="wrap mark">
        <ScanlineWordmark />
      </div>
      <div className="wrap fine">
        <span>{note}</span>
        <span style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Link to="/s/$shopId" params={{ shopId: config.shopId }}>
            Scorecard
          </Link>
          <Link to="/app">Owner app</Link>
          <Link to="/blocklist">Blocklist</Link>
          <Link to="/agents">Your agent</Link>
          {import.meta.env.DEV && <Link to="/devices">Device check</Link>}
        </span>
      </div>
    </footer>
  )
}
