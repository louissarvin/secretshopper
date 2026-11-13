import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'

import HeroUIProvider from '../providers/HeroUIProvider'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import ErrorPage from '../components/ErrorPage'
import Interactions from '../components/elements/Interactions'
import { FeedbackProvider } from '../components/Feedback'
import PublicConfigSync from '../components/PublicConfigSync'
import { config } from '../config'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => (
    <ErrorPage error={error} reset={reset} />
  ),
  notFoundComponent: () => <ErrorPage notFound />,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { title: `${config.appName}: phishing drills for the agent that pays` },
      { name: 'description', content: config.appDescription },
      { name: 'theme-color', content: '#0B0B0F' },
      { property: 'og:title', content: config.appName },
      { property: 'og:description', content: config.appDescription },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'preload', href: '/logo.svg', as: 'image', type: 'image/svg+xml' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <HeroUIProvider>
          <FeedbackProvider>
            <LenisSmoothScrollProvider />
            <PublicConfigSync>{children}</PublicConfigSync>
            <Interactions />
          </FeedbackProvider>
        </HeroUIProvider>
        <Scripts />
      </body>
    </html>
  )
}
