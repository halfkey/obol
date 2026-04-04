#!/usr/bin/env npx tsx
/**
 * Manual Payment Test
 *
 * Usage:
 *   npx tsx scripts/test-payment.ts <tx-signature> [endpoint] [base-url]
 *
 * Examples:
 *   npx tsx scripts/test-payment.ts 5xyz...abc
 *   npx tsx scripts/test-payment.ts 5xyz...abc /api/v1/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/price
 *   npx tsx scripts/test-payment.ts 5xyz...abc /api/v1/defi/lst/yields https://obol-production.up.railway.app
 *
 * Steps:
 *   1. Send USDC from any wallet to your merchant wallet
 *   2. Copy the tx signature
 *   3. Run this script with the signature
 */

const txSignature = process.argv[2];
const endpoint = process.argv[3] ?? '/api/v1/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/price';
const baseUrl = process.argv[4] ?? 'https://obol-production.up.railway.app';

if (!txSignature) {
  console.log(`
  Usage: npx tsx scripts/test-payment.ts <tx-signature> [endpoint] [base-url]

  Steps:
    1. Open Phantom (or any Solana wallet)
    2. Send at least 0.005 USDC to: 8XbWHWCQyKokgLjALYyXGaLqjGaLNwuhRGNVfqSNVDDw
    3. Copy the transaction signature
    4. Run: npx tsx scripts/test-payment.ts <that-signature>

  Endpoint pricing:
    /api/v1/token/:mint/price       0.005 USDC  (cheapest)
    /api/v1/token/:mint/metadata    0.01  USDC
    /api/v1/wallet/:addr/overview   0.01  USDC
    /api/v1/defi/swap/quote         0.005 USDC
    /api/v1/defi/lst/yields         0.02  USDC
    /api/v1/wallet/:addr/pnl        0.15  USDC  (most expensive)
  `);
  process.exit(1);
}

async function run() {
  const url = `${baseUrl}${endpoint}`;

  // Build the X-PAYMENT header — base64-encoded JSON with the tx signature
  // Don't include fromAddress — the middleware will extract it from the on-chain tx
  const paymentPayload = {
    payload: {
      signature: txSignature,
    },
  };

  const header = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  console.log(`\n  OBOL PAYMENT TEST`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Target:    ${url}`);
  console.log(`  Tx Sig:    ${txSignature.slice(0, 20)}...${txSignature.slice(-8)}`);
  console.log(`  Header:    X-PAYMENT: ${header.slice(0, 40)}...`);
  console.log(`  ─────────────────────────────────────\n`);

  // Step 1: Hit without payment to see the 402
  console.log('  [1] Hitting endpoint without payment...');
  const noPayRes = await fetch(url);
  console.log(`      Status: ${noPayRes.status} ${noPayRes.status === 402 ? '(Payment Required — correct)' : ''}`);

  if (noPayRes.status === 402) {
    const body = await noPayRes.json() as Record<string, unknown>;
    const accepts = body.accepts as Array<{ maxAmountRequired?: string; asset?: string }>;
    if (accepts?.[0]) {
      const req = accepts[0];
      console.log(`      Required: ${req.maxAmountRequired} atomic units of ${req.asset}`);
    }
  }

  // Step 2: Hit with payment header
  console.log('\n  [2] Hitting endpoint WITH payment header...');
  const start = Date.now();

  const paidRes = await fetch(url, {
    headers: { 'X-PAYMENT': header },
  });

  const duration = Date.now() - start;
  const responseBody = await paidRes.text();

  console.log(`      Status: ${paidRes.status} (${duration}ms)`);

  // Check for payment response header
  const paymentResponse = paidRes.headers.get('x-payment-response');
  if (paymentResponse) {
    const decoded = JSON.parse(Buffer.from(paymentResponse, 'base64').toString('utf-8'));
    console.log(`      Payment Response:`, decoded);
  }

  // Pretty print the response
  try {
    const json = JSON.parse(responseBody);
    console.log(`\n  Response:`);
    console.log(JSON.stringify(json, null, 2).split('\n').map(l => `  ${l}`).join('\n'));
  } catch {
    console.log(`\n  Raw Response: ${responseBody.slice(0, 500)}`);
  }

  console.log(`\n  ─────────────────────────────────────`);

  if (paidRes.status === 200) {
    console.log('  PAYMENT VERIFIED — endpoint returned data');
  } else if (paidRes.status === 402) {
    console.log('  PAYMENT REJECTED — insufficient or invalid payment');
  } else if (paidRes.status === 400) {
    console.log('  PAYMENT ERROR — check the error message above');
  } else {
    console.log(`  UNEXPECTED STATUS: ${paidRes.status}`);
  }

  console.log(`  ─────────────────────────────────────\n`);
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
