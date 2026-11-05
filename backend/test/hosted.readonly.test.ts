import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { readOnlyAllows } from '../src/config/hosted.ts';
import { appUrlOf, clientIpOf, handleWithFastify } from '../src/lib/hosted/bridge.ts';

// HOSTED_READONLY=1 (docs/HOSTING.md): only public reads are served, nothing writes, and the Vercel bridge maps paths.

describe('readOnlyAllows', () => {
  test('public reads, health and preflight pass', () => {
    for (const [m, r] of [
      ['GET', '/'],
      ['GET', '/health'],
      ['GET', '/ready'],
      ['HEAD', '/health'],
      ['GET', '/public/evidence/:shopId'],
      ['GET', '/public/blocklist'],
      ['GET', '/public/verify-report'],
      ['POST', '/public/vault-plan'],
      ['OPTIONS', '*'],
    ] as const)
      expect(readOnlyAllows(m, r)).toBe(true);
  });

  test('writes and private reads are refused', () => {
    for (const [m, r] of [
      ['POST', '/auth/nonce'],
      ['POST', '/company/'],
      ['GET', '/company/me'],
      ['PUT', '/vendors/:id'],
      ['POST', '/invoices/'],
      ['GET', '/inbox/next'],
      ['POST', '/blocklist/'],
      ['GET', '/tests/'],
      ['POST', '/public/anything-else'],
      ['PUT', '/public/vault-plan'],
      ['DELETE', '/public/evidence/:shopId'],
      ['GET', '/publicity'],
    ] as const)
      expect(readOnlyAllows(m, r)).toBe(false);
  });
});

describe('appUrlOf', () => {
  test('the rewrite parameter wins and is removed from the query', () => {
    expect(appUrlOf(new URL('https://api.example/api/server?__path=public/evidence/shop.testnet&fromSlot=100'))).toBe('/public/evidence/shop.testnet?fromSlot=100');
    expect(appUrlOf(new URL('https://api.example/api/server?__path='))).toBe('/');
  });

  test('without the parameter the function prefix is stripped, other paths pass through', () => {
    expect(appUrlOf(new URL('https://api.example/api/server/health'))).toBe('/health');
    expect(appUrlOf(new URL('https://api.example/api/server'))).toBe('/');
    expect(appUrlOf(new URL('https://api.example/public/config?a=1'))).toBe('/public/config?a=1');
    expect(appUrlOf(new URL('https://api.example/api/serverless'))).toBe('/api/serverless');
  });

  test('client ip comes from x-real-ip', () => {
    expect(clientIpOf(new Request('https://a.example/', { headers: { 'x-real-ip': '203.0.113.7' } }))).toBe('203.0.113.7');
    expect(clientIpOf(new Request('https://a.example/'))).toBe('127.0.0.1');
  });
});

describe('buildApp with HOSTED_READONLY=1', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../src/lib/prisma.ts').prismaQuery;
  const prior = process.env.HOSTED_READONLY;

  beforeAll(async () => {
    Object.assign(process.env, {
      // never reached: no route below touches the database
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://nobody@127.0.0.1:1/none?schema=public',
      JWT_SECRET: process.env.JWT_SECRET || randomBytes(32).toString('hex'),
      SHOP_CONTRACT_ID: process.env.SHOP_CONTRACT_ID || 'ss-readonly.testnet',
      INBOX_TOKEN_HASH: process.env.INBOX_TOKEN_HASH || createHash('sha256').update(randomBytes(24)).digest('hex'),
      NEAR_NETWORK: 'testnet',
      LOG_LEVEL: 'error',
      HOSTED_READONLY: '1',
    });
    prisma = (await import('../src/lib/prisma.ts')).prismaQuery;
    app = await (await import('../src/app.ts')).buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (prior === undefined) delete process.env.HOSTED_READONLY;
    else process.env.HOSTED_READONLY = prior;
  });

  test('health is served', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  test('every write route and every signed-in read is absent', async () => {
    const calls: [string, string][] = [
      ['POST', '/auth/nonce'],
      ['POST', '/auth/verify'],
      ['POST', '/company'],
      ['GET', '/company/me'],
      ['GET', '/company/alerts'],
      ['GET', '/vendors'],
      ['POST', '/vendors'],
      ['PUT', '/vendors/abc'],
      ['GET', '/vendor/me'],
      ['POST', '/invoices'],
      ['GET', '/invoices'],
      ['GET', '/inbox/next'],
      ['POST', '/inbox/blocklist'],
      ['GET', '/tests'],
      ['GET', '/proposals'],
      ['POST', '/blocklist'],
    ];
    for (const [method, url] of calls) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 404 });
    }
  });

  test('a write verb on a GET-only public route matches nothing', async () => {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/public/config', payload: method === 'DELETE' ? undefined : {} });
      expect(res.statusCode).toBe(404);
    }
  });

  test('errors are not written to the database', async () => {
    const create = spyOn(prisma.errorLog, 'create');
    const res = await app.inject({ method: 'GET', url: '/public/tests/NOT_AN_ACCOUNT' });
    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  test('the Vercel bridge routes rewritten requests through the same guard', async () => {
    const ok = await handleWithFastify(app, new Request('https://api.example/api/server?__path=health', { headers: { 'x-real-ip': '203.0.113.7' } }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { status: string } }).data.status).toBe('ok');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');

    const write = await handleWithFastify(
      app,
      new Request('https://api.example/api/server?__path=auth/nonce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accountId":"a.testnet"}' })
    );
    expect(write.status).toBe(404);
  });
});
