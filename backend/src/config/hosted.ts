// Hosted read-only demo (README, Deploy). Kept apart from main-config so the error handler can read it without
// pulling in the API's required env checks; read per call so one test process can build both kinds of app.
export const hostedReadOnly = (): boolean => process.env.HOSTED_READONLY === '1';

// Route patterns the read-only demo serves. Everything else is never registered, and the guard refuses it anyway.
const OPEN_GET = new Set(['/', '/health', '/ready']);
// POST /public/vault-plan computes a plan from chain reads and writes nothing.
const OPEN_POST = new Set(['/public/vault-plan']);

/** True when a request may run in read-only mode. `route` is Fastify's matched route pattern, not the raw URL. */
export const readOnlyAllows = (method: string, route: string | undefined): boolean => {
  if (method === 'OPTIONS') return true; // CORS preflight, answered by @fastify/cors
  if (route === undefined) return true; // no route matched: the 404 handler answers
  if (method === 'GET' || method === 'HEAD') return OPEN_GET.has(route) || route.startsWith('/public/');
  return method === 'POST' && OPEN_POST.has(route);
};
