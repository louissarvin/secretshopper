import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from '@tanstack/react-query'
import type { ActivityPage } from '@/lib/api/shop'
import { EmptyState, ErrorState, Skel } from '@/components/QueryState'
import { useNow } from '@/hooks/useMotion'
import { explorerTx } from '@/config'
import { ago, short } from '@/utils/near'

/** Newest-first event list for the owner alerts and the vendor history. */
export default function ActivityFeed({
  q,
  title,
  src,
  empty,
}: {
  q: UseInfiniteQueryResult<InfiniteData<ActivityPage>>
  title: string
  src: string
  empty: string
}) {
  const now = useNow(30_000)
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <div className="panel" style={{ display: 'grid', gap: 12 }}>
      <div className="ptop">
        <h3>{title}</h3>
        <span className="src">{src}</span>
      </div>
      {q.isError ? (
        <ErrorState
          what={title.toLowerCase()}
          error={q.error}
          retry={() => q.refetch()}
        />
      ) : q.isPending ? (
        <Skel h={80} />
      ) : !items.length ? (
        <EmptyState title="Nothing yet">{empty}</EmptyState>
      ) : (
        <ul className="feed">
          {items.map((i) => (
            <li key={i.id}>
              <span className="chip">{i.kind.replace(/_/g, ' ')}</span>
              <span>{i.text}</span>
              <span className="mono dimt">
                {now ? ago(Date.parse(i.at), now) : ''}
                {i.txHash && (
                  <>
                    {' · '}
                    <a
                      className="txl"
                      href={explorerTx(i.txHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(i.txHash, 6, 4)}
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div>
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            Older
          </button>
        </div>
      )}
    </div>
  )
}
