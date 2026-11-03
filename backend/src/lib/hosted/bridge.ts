import type { FastifyInstance } from 'fastify';

// Runs a Web Request through Fastify's full lifecycle with inject(), for the Vercel Bun.serve entry (api/server.ts).

const PATH_PARAM = '__path'; // set by the rewrite in backend/vercel.json
const FUNCTION_PREFIX = '/api/server';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

/** The path and query Fastify should see: the rewrite's `__path` if present, else the URL minus the function prefix. */
export const appUrlOf = (url: URL): string => {
  const query = new URLSearchParams(url.searchParams);
  const rewritten = query.get(PATH_PARAM);
  query.delete(PATH_PARAM);
  let path = rewritten !== null ? `/${rewritten.replace(/^\/+/, '')}` : url.pathname;
  if (rewritten === null && (path === FUNCTION_PREFIX || path.startsWith(`${FUNCTION_PREFIX}/`))) path = path.slice(FUNCTION_PREFIX.length) || '/';
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
};

/** Vercel overwrites x-real-ip with the client address, so rate limits key on the caller, not the platform. */
export const clientIpOf = (request: Request): string => request.headers.get('x-real-ip')?.trim() || '127.0.0.1';

export const handleWithFastify = async (app: FastifyInstance, request: Request): Promise<Response> => {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) headers[key] = value;
  });
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await app.inject({
    method: request.method as 'GET',
    url: appUrlOf(new URL(request.url)),
    headers,
    remoteAddress: clientIpOf(request),
    ...(hasBody ? { body: Buffer.from(await request.arrayBuffer()) } : {}),
  });
  const out = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, String(v));
  }
  const empty = request.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
  return new Response(empty ? null : res.rawPayload, { status: res.statusCode, headers: out });
};
