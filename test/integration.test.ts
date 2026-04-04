import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { cache } from '../src/services/cache.js';
import type { FastifyInstance } from 'fastify';

/**
 * Integration Tests
 *
 * Spins up a real Fastify instance in mock payment mode.
 * Tests endpoint routing, response shapes, and error handling.
 * Does NOT hit external APIs (Helius, Jupiter) — those are tested via smoke-test.ts.
 */

let app: FastifyInstance;

beforeAll(async () => {
  // Override to mock mode for integration tests
  process.env.PAYMENT_MODE = 'mock';
  process.env.NODE_ENV = 'test';

  try {
    await cache.connect();
  } catch {
    // Cache may not be available in CI — that's fine
  }

  app = await createApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Free Endpoints', () => {
  it('GET / returns obol root info', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.name).toBe('obol');
    expect(body.version).toBe('2.0.0');
    expect(body.protocol).toBe('x402');
    expect(body.endpoints).toBeDefined();
    expect(body.freeEndpoints).toContain('GET /');
    expect(body.freeEndpoints).toContain('GET /health');
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toBeDefined();
  });

  it('POST /api/v1/rpc blocks disallowed methods', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rpc',
      payload: { method: 'getBalance', params: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Forbidden');
  });

  it('POST /api/v1/rpc blocks missing method', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rpc',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Not Found');
  });
});

describe('Validation', () => {
  it('rejects invalid wallet address', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/not-a-valid-address/overview',
      headers: mockPaymentHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Invalid Solana address');
  });

  it('rejects invalid mint address', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/token/garbage/price',
      headers: mockPaymentHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Invalid token mint');
  });
});

describe('Payment Gate (mock mode)', () => {
  it('returns data with mock payment header on wallet overview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg/overview',
      headers: mockPaymentHeader(),
    });
    // In mock mode, should pass through to the handler.
    // May return 200 (if Helius is available) or 500 (if not).
    // The key test is that it does NOT return 402.
    expect(res.statusCode).not.toBe(402);
  });

  it('returns data with mock payment header on swap quote', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/defi/swap/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000',
      headers: mockPaymentHeader(),
    });
    expect(res.statusCode).not.toBe(402);
  });

  it('rejects malformed payment header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg/overview',
      headers: { 'x-payment': 'not-valid-base64!!!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid payment');
  });

  it('rejects payment header missing payload', async () => {
    const header = Buffer.from(JSON.stringify({ notPayload: true })).toString('base64');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg/overview',
      headers: { 'x-payment': header },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('missing payload');
  });
});

describe('Endpoint Response Shapes', () => {
  it('GET /api/v1/defi/swap/quote requires inputMint, outputMint, amount', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/defi/swap/quote',
      headers: mockPaymentHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Required query params');
  });

  it('GET /api/v1/defi/lst/yields passes through to handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/defi/lst/yields',
      headers: mockPaymentHeader(),
    });
    // Should not 402 — payment accepted in mock mode
    expect(res.statusCode).not.toBe(402);
  });
});

// ── Helpers ──

function mockPaymentHeader(): Record<string, string> {
  const payment = {
    payload: {
      signature: 'mock-tx-sig-' + Date.now(),
      fromAddress: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
    },
  };
  return {
    'x-payment': Buffer.from(JSON.stringify(payment)).toString('base64'),
  };
}
