#!/usr/bin/env npx tsx
/**
 * Obol Smoke Test Client
 *
 * Hits every endpoint against a live or local instance.
 * Run: npx tsx scripts/smoke-test.ts [base-url]
 *
 * Modes:
 *   - Against mock mode: tests all endpoints return data
 *   - Against onchain mode: tests free endpoints + verifies 402 on paid endpoints
 *
 * Examples:
 *   npx tsx scripts/smoke-test.ts                          # default: http://localhost:3000
 *   npx tsx scripts/smoke-test.ts https://obol-production.up.railway.app
 */

const BASE_URL = process.argv[2] ?? 'http://localhost:3000';

// Known good Solana addresses for testing
const TEST_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'; // Solana docs example
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// A wallet known to have DeFi activity (can be updated)
const DEFI_WALLET = 'CKs1E69a2e9TmH4mKKLrXFF8kD3ZnvPBMFjvNkWJtEqj';

interface TestResult {
  name: string;
  endpoint: string;
  status: number;
  passed: boolean;
  duration: number;
  error?: string;
  paymentRequired?: boolean;
}

const results: TestResult[] = [];

async function test(name: string, endpoint: string, options?: {
  expectedStatus?: number;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  validate?: (data: unknown) => void;
}): Promise<void> {
  const url = `${BASE_URL}${endpoint}`;
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: options?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    const duration = Date.now() - start;
    const expectedStatus = options?.expectedStatus ?? 200;
    const passed = response.status === expectedStatus;

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // Some responses may not be JSON
    }

    if (passed && options?.validate && data) {
      try {
        options.validate(data);
      } catch (err) {
        results.push({
          name,
          endpoint,
          status: response.status,
          passed: false,
          duration,
          error: `Validation failed: ${(err as Error).message}`,
        });
        return;
      }
    }

    results.push({
      name,
      endpoint,
      status: response.status,
      passed,
      duration,
      paymentRequired: response.status === 402,
      error: passed ? undefined : `Expected ${expectedStatus}, got ${response.status}`,
    });
  } catch (err) {
    results.push({
      name,
      endpoint,
      status: 0,
      passed: false,
      duration: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  console.log(`\n  OBOL SMOKE TEST`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  ${'─'.repeat(50)}\n`);

  // Step 1: Determine payment mode
  let paymentMode = 'unknown';
  await test('Root endpoint', '/', {
    validate: (data) => {
      const d = data as Record<string, unknown>;
      assert(d.name === 'obol', 'Expected name "obol"');
      assert(d.version === '2.0.0', 'Expected version 2.0.0');
      assert(typeof d.endpoints === 'object', 'Expected endpoints object');
      paymentMode = d.paymentMode as string;
    },
  });

  console.log(`  Payment mode: ${paymentMode}\n`);

  // Paid endpoints should return 200 in mock mode, 402 in onchain mode (no payment header)
  const paidExpectedStatus = paymentMode === 'mock' ? 200 : 402;

  // ── Free Endpoints ──

  await test('Health check', '/health', {
    validate: (data) => {
      const d = data as Record<string, unknown>;
      assert(d.status === 'ok', 'Expected status "ok"');
      assert(typeof d.uptime === 'number', 'Expected numeric uptime');
    },
  });

  await test('RPC proxy — allowed method', '/api/v1/rpc', {
    method: 'POST',
    body: { method: 'getLatestBlockhash', params: [] },
    validate: (data) => {
      const d = data as Record<string, unknown>;
      // Helius returns { jsonrpc, result, id } — result may be nested
      assert(d.jsonrpc === '2.0' || d.result !== undefined, 'Expected valid JSON-RPC response');
    },
  });

  await test('RPC proxy — blocked method', '/api/v1/rpc', {
    method: 'POST',
    body: { method: 'getBalance', params: [] },
    expectedStatus: 403,
  });

  await test('404 handler', '/api/v1/nonexistent', {
    expectedStatus: 404,
  });

  // ── Wallet Endpoints (paid) ──

  await test('Wallet overview', `/api/v1/wallet/${TEST_WALLET}/overview`, {
    expectedStatus: paidExpectedStatus,
    validate: paymentMode === 'mock' ? (data) => {
      const d = data as Record<string, unknown>;
      assert(d.success === true, 'Expected success: true');
      assert(d.data !== undefined, 'Expected data field');
    } : undefined,
  });

  await test('Wallet portfolio', `/api/v1/wallet/${TEST_WALLET}/portfolio`, {
    expectedStatus: paidExpectedStatus,
  });

  await test('Wallet activity', `/api/v1/wallet/${TEST_WALLET}/activity`, {
    expectedStatus: paidExpectedStatus,
  });

  await test('Wallet risk', `/api/v1/wallet/${TEST_WALLET}/risk`, {
    expectedStatus: paidExpectedStatus,
  });

  await test('Wallet P&L', `/api/v1/wallet/${TEST_WALLET}/pnl`, {
    expectedStatus: paidExpectedStatus,
  });

  // ── Token Endpoints (paid) ──

  await test('Token price (USDC)', `/api/v1/token/${USDC_MINT}/price`, {
    expectedStatus: paidExpectedStatus,
    validate: paymentMode === 'mock' ? (data) => {
      const d = data as { data?: { priceUSD?: number } };
      assert(typeof d.data?.priceUSD === 'number', 'Expected numeric priceUSD');
    } : undefined,
  });

  await test('Token metadata (USDC)', `/api/v1/token/${USDC_MINT}/metadata`, {
    expectedStatus: paidExpectedStatus,
    validate: paymentMode === 'mock' ? (data) => {
      const d = data as { data?: { symbol?: string } };
      assert(d.data?.symbol === 'USDC', 'Expected symbol "USDC"');
    } : undefined,
  });

  // ── DeFi Endpoints (paid) ──

  await test('Swap quote (SOL → USDC)', `/api/v1/defi/swap/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000`, {
    expectedStatus: paidExpectedStatus,
    validate: paymentMode === 'mock' ? (data) => {
      const d = data as { data?: { outAmount?: string } };
      assert(typeof d.data?.outAmount === 'string', 'Expected outAmount string');
    } : undefined,
  });

  await test('Swap quote — missing params', '/api/v1/defi/swap/quote', {
    expectedStatus: paymentMode === 'mock' ? 400 : 402,
  });

  await test('DeFi positions', `/api/v1/defi/positions/${DEFI_WALLET}`, {
    expectedStatus: paidExpectedStatus,
  });

  await test('LST yields', '/api/v1/defi/lst/yields', {
    expectedStatus: paidExpectedStatus,
    validate: paymentMode === 'mock' ? (data) => {
      const d = data as { data?: { yields?: unknown[] } };
      assert(Array.isArray(d.data?.yields), 'Expected yields array');
    } : undefined,
  });

  // ── Validation Tests ──
  // In onchain mode, x402 gates before validation — so invalid addresses get 402.
  // In mock mode, payment auto-approves and validation returns 400.
  const validationExpected = paymentMode === 'mock' ? 400 : 402;

  await test('Invalid wallet address', '/api/v1/wallet/not-a-real-address/overview', {
    expectedStatus: validationExpected,
  });

  await test('Invalid mint address', '/api/v1/token/garbage/price', {
    expectedStatus: validationExpected,
  });

  // ── 402 Header Tests (onchain mode only) ──

  if (paymentMode === 'onchain') {
    // Verify the 402 response includes proper payment requirement headers
    const res = await fetch(`${BASE_URL}/api/v1/token/${USDC_MINT}/price`);
    const paymentRequiredHeader = res.headers.get('x-payment-required');
    const body = await res.json() as Record<string, unknown>;

    const headerValid = paymentRequiredHeader !== null;
    const bodyValid = body.x402Version === 2 && Array.isArray(body.accepts);

    results.push({
      name: '402 response header (X-PAYMENT-REQUIRED)',
      endpoint: `/api/v1/token/${USDC_MINT}/price`,
      status: 402,
      passed: headerValid,
      duration: 0,
      paymentRequired: true,
      error: headerValid ? undefined : 'Missing X-PAYMENT-REQUIRED header',
    });

    results.push({
      name: '402 response body (x402 protocol)',
      endpoint: `/api/v1/token/${USDC_MINT}/price`,
      status: 402,
      passed: bodyValid,
      duration: 0,
      paymentRequired: true,
      error: bodyValid ? undefined : 'Body missing x402Version or accepts array',
    });
  }

  // ── Report ──

  console.log('  RESULTS');
  console.log(`  ${'─'.repeat(50)}\n`);

  const maxName = Math.max(...results.map(r => r.name.length));

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    const name = r.name.padEnd(maxName);
    const status = r.paymentRequired ? '402' : String(r.status);
    const time = r.duration > 0 ? `${r.duration}ms` : '';
    console.log(`  [${icon}]  ${name}  ${status.padStart(3)}  ${time}`);
    if (!r.passed && r.error) {
      console.log(`         ${r.error}`);
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`\n  ${'─'.repeat(50)}`);
  console.log(`  ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`);
  console.log(`  ${'─'.repeat(50)}\n`);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
