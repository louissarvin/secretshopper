import { handleWithFastify } from '../src/lib/hosted/bridge.ts';

// Vercel entry for the hosted read-only demo (docs/HOSTING.md). Never used locally: `bun run start` runs index.ts.
process.env.HOSTED_READONLY = '1';
// model runs, the B1 summary and the verify report ship from backend/data (vercel.json functions.includeFiles)

// Dynamic import so the setting above is in place before the config module reads it.
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
await app.ready();

Bun.serve({ fetch: (request) => handleWithFastify(app, request) });
