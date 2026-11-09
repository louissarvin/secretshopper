import { useRouter } from '@tanstack/react-router'

interface ErrorPageProps {
  error?: Error
  reset?: () => void
  notFound?: boolean
}

export default function ErrorPage({ error, reset, notFound }: ErrorPageProps) {
  const router = useRouter()
  return (
    <main
      className="wrap"
      style={{
        minHeight: '100svh',
        display: 'grid',
        alignContent: 'center',
        gap: 24,
        paddingBlock: 80,
      }}
    >
      <span className="label">{notFound ? '404' : 'Error'}</span>
      <h1 className="disp" style={{ fontSize: 'clamp(44px, 8vw, 104px)' }}>
        {notFound ? 'Nothing' : 'Something'}
        <br />
        <span className="cob">{notFound ? 'here.' : 'broke.'}</span>
      </h1>
      <p className="dimt" style={{ maxWidth: '56ch' }}>
        {notFound
          ? 'This page does not exist. A vault id must be a NEAR account and a test slot must be a number.'
          : 'The page hit an error it could not recover from. Try again. If it keeps happening, the details below help us find it.'}
      </p>
      {error?.message && (
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 16,
            border: '1px solid var(--line)',
            borderRadius: 14,
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {error.message}
        </pre>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {!notFound && (
          <button
            className="btn solid"
            type="button"
            onClick={() => (reset ? reset() : router.invalidate())}
          >
            Try again
          </button>
        )}
        <button
          className="btn ghost"
          type="button"
          onClick={() => router.navigate({ to: '/' })}
        >
          Go home
        </button>
      </div>
    </main>
  )
}
