import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// TanStack devtools only on the dev server, never in a production build
const config = defineConfig(({ command }) => ({
  plugins: [
    ...(command === 'serve' ? [devtools()] : []),
    // Security headers live in Nitro's route rules: its Vercel build output replaces vercel.json headers
    nitro({
      routeRules: {
        '/**': {
          headers: {
            'Content-Security-Policy':
              "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
          },
        },
      },
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}))

export default config
