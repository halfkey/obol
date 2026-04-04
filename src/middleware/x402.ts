/**
 * x402 Payment Middleware for Fastify
 *
 * Built on the @x402/core SDK for protocol-compliant header encoding/decoding.
 * Uses @x402/svm utilities for Solana-specific address validation.
 *
 * Architecture note:
 * The full @x402 SDK uses a Facilitator model (verify + settle via a remote
 * or local facilitator service). For Obol, we implement direct
 * on-chain verification because we want zero third-party dependencies in
 * the payment path. The SDK's header format and protocol types are used
 * to ensure protocol compliance.
 *
 * When the x402 ecosystem matures further, we can swap in the SDK's
 * x402HTTPResourceServer for full protocol support with one line change.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { PublicKey } from '@solana/web3.js';
import type { ParsedTransactionWithMeta, ParsedInstruction } from '@solana/web3.js';
import { config } from '../config/env.js';
import { getEndpointPrice, requiresPayment } from '../config/pricing.js';
import { cache } from '../services/cache.js';
import { helius } from '../services/helius.js';
import { logger } from '../utils/logger.js';

// SDK utilities for protocol compliance
import { validateSvmAddress, USDC_MAINNET_ADDRESS, SOLANA_MAINNET_CAIP2 } from '@x402/svm';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const X402_VERSION = 2; // SDK v2 protocol
const MAX_TX_AGE_SECONDS = 300;

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface PaymentInfo {
  wallet: string;
  amount: number;
  currency: string;
  verifiedAt: string;
  txSignature?: string;
  network?: string;
  mode: 'mock' | 'onchain';
}

declare module 'fastify' {
  interface FastifyRequest {
    payment?: PaymentInfo;
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function usdcToAtomicUnits(usdcAmount: number): string {
  return Math.floor(usdcAmount * 1_000_000).toString();
}

function generateMemo(): string {
  return `obol_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/** Build a protocol-compliant payment requirement */
function buildPaymentRequirement(resource: string, priceUSDC: number) {
  return {
    scheme: 'exact' as const,
    network: SOLANA_MAINNET_CAIP2,
    maxAmountRequired: usdcToAtomicUnits(priceUSDC),
    resource,
    description: `Obol: ${resource}`,
    mimeType: 'application/json',
    outputSchema: {},
    payTo: config.payment.recipientAddress,
    maxTimeoutSeconds: MAX_TX_AGE_SECONDS,
    asset: USDC_MAINNET_ADDRESS,
    extra: { memo: generateMemo() },
  };
}

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────

export async function x402PaymentMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { url } = request;

  if (!requiresPayment(url)) return;

  let price: number;
  try {
    price = getEndpointPrice(url);
  } catch {
    return reply.code(404).send({ error: 'Not Found', message: 'Endpoint not configured' });
  }

  // Check for payment header (SDK uses X-PAYMENT or PAYMENT-SIGNATURE)
  const paymentHeader = (request.headers['x-payment'] ?? request.headers['payment-signature']) as string | undefined;

  if (!paymentHeader) {
    const requirement = buildPaymentRequirement(url, price);
    const paymentRequired = {
      x402Version: X402_VERSION,
      error: 'Payment Required',
      accepts: [requirement],
    };

    logger.info({ url, price }, '402: Payment required');

    // Set protocol-compliant header + JSON body
    reply.header('X-PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'));
    return reply.code(402).send(paymentRequired);
  }

  // Decode payment header (base64 JSON)
  let payment: Record<string, unknown>;
  try {
    const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
    payment = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Invalid payment header — could not decode',
    });
  }

  const payload = payment.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Invalid payment: missing payload',
    });
  }

  // ── Mock mode ──
  if (config.payment.mode === 'mock') {
    logger.debug({ url }, 'Mock: auto-approving');
    const walletId = (payload.fromAddress as string) ?? (payload.transaction as string)?.slice(0, 20) ?? 'mock-wallet';
    request.payment = {
      wallet: walletId,
      amount: price,
      currency: 'USDC',
      verifiedAt: new Date().toISOString(),
      mode: 'mock',
    };
    return;
  }

  // ── On-chain mode ──
  // SDK v2 sends { payload: { transaction: "base64..." } }
  // Legacy v1 sends { payload: { signature: "base58...", fromAddress: "..." } }
  const txSignature = (payload.signature as string) ?? (payload.transaction as string);
  const fromAddress = payload.fromAddress as string | undefined;

  if (!txSignature) {
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Missing transaction signature in payment payload',
    });
  }

  // Validate sender address if provided
  if (fromAddress && !validateSvmAddress(fromAddress)) {
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Invalid sender address',
    });
  }

  // ── Replay prevention: check if this tx signature was already used ──
  const txKey = `payment:tx:${txSignature}`;
  if (await cache.exists(txKey)) {
    logger.warn({ txSignature: String(txSignature).slice(0, 20) }, 'Replay rejected');
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Transaction already used for a previous payment',
    });
  }

  // ── Fetch parsed transaction from Solana via Helius ──
  let parsedTx: ParsedTransactionWithMeta | null;
  try {
    const conn = helius.getConnection();
    parsedTx = await conn.getParsedTransaction(String(txSignature), {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
  } catch (err) {
    logger.error({ err, txSignature: String(txSignature).slice(0, 20) }, 'Failed to fetch transaction');
    return reply.code(502).send({
      x402Version: X402_VERSION,
      error: 'Could not verify transaction — RPC error',
    });
  }

  if (!parsedTx) {
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Transaction not found on-chain. It may not be confirmed yet — retry in a few seconds.',
    });
  }

  // ── Verify transaction succeeded ──
  if (parsedTx.meta?.err) {
    return reply.code(400).send({
      x402Version: X402_VERSION,
      error: 'Transaction failed on-chain',
      details: parsedTx.meta.err,
    });
  }

  // ── Verify transaction age ──
  const txTimestamp = parsedTx.blockTime;
  if (txTimestamp) {
    const ageSeconds = Math.floor(Date.now() / 1000) - txTimestamp;
    if (ageSeconds > MAX_TX_AGE_SECONDS) {
      return reply.code(400).send({
        x402Version: X402_VERSION,
        error: `Transaction too old (${ageSeconds}s). Must be under ${MAX_TX_AGE_SECONDS}s.`,
      });
    }
    if (ageSeconds < -60) {
      // Clock skew guard — reject transactions "from the future" beyond 60s tolerance
      return reply.code(400).send({
        x402Version: X402_VERSION,
        error: 'Transaction timestamp is in the future',
      });
    }
  }

  // ── Find the USDC transfer to our merchant wallet ──
  const requiredAtomicUnits = BigInt(usdcToAtomicUnits(price));
  const recipientPubkey = config.payment.recipientAddress;
  const usdcMint = USDC_MAINNET_ADDRESS;

  let verifiedAmount = BigInt(0);
  let verifiedSender = 'unknown';

  const innerInstructions = parsedTx.meta?.innerInstructions ?? [];
  const allInstructions = [
    ...parsedTx.transaction.message.instructions,
    ...innerInstructions.flatMap(ix => ix.instructions),
  ];

  for (const ix of allInstructions) {
    // We need parsed instructions from the SPL Token program
    if (!('parsed' in ix)) continue;
    const parsed = ix as ParsedInstruction;
    if (parsed.program !== 'spl-token') continue;

    const { type, info } = parsed.parsed as {
      type: string;
      info: Record<string, string> & { tokenAmount?: { amount: string } };
    };

    // Match transfer or transferChecked
    if (type !== 'transfer' && type !== 'transferChecked') continue;

    const destination = info.destination ?? info.account;
    const amount = info.amount ?? info.tokenAmount?.amount;
    const mint = info.mint;

    if (!destination || !amount) continue;

    // For transferChecked, mint is in the instruction — reject if wrong mint.
    // For plain transfer, mint is absent — we verify via the token account below.
    if (mint && mint !== usdcMint) continue;

    // For plain transfers without mint field, we MUST verify via token account.
    // The token account lookup below enforces mint == USDC as a hard requirement.

    // Resolve destination token account → check if owner is our merchant wallet
    // The destination in SPL transfer is the token account, not the wallet.
    // We check if the recipient token account belongs to our merchant.
    try {
      const destAccountInfo = await helius.getConnection().getParsedAccountInfo(new PublicKey(destination));
      if (!destAccountInfo.value) continue;

      const accountData = destAccountInfo.value.data;
      if (!('parsed' in accountData)) continue;

      const tokenAccountInfo = accountData.parsed as { info?: { owner?: string; mint?: string } };
      const owner = tokenAccountInfo.info?.owner;
      const accountMint = tokenAccountInfo.info?.mint;

      // Verify: token account is owned by our wallet AND it's USDC
      // CRITICAL: both checks are mandatory — if either is missing, reject
      if (owner !== recipientPubkey) continue;
      if (!accountMint || accountMint !== usdcMint) continue;

      verifiedAmount += BigInt(amount);
      verifiedSender = info.authority ?? info.source ?? fromAddress ?? 'unknown';
    } catch {
      // If we can't resolve the account, skip this instruction
      continue;
    }
  }

  if (verifiedAmount < requiredAtomicUnits) {
    logger.warn({
      txSignature: String(txSignature).slice(0, 20),
      required: requiredAtomicUnits.toString(),
      found: verifiedAmount.toString(),
    }, 'Insufficient USDC payment');
    return reply.code(402).send({
      x402Version: X402_VERSION,
      error: 'Insufficient payment',
      required: requiredAtomicUnits.toString(),
      received: verifiedAmount.toString(),
      currency: 'USDC',
    });
  }

  // ── Payment verified — record receipt and pass through ──
  logger.info({
    url,
    txSignature: String(txSignature).slice(0, 20) + '...',
    amount: price,
    sender: verifiedSender,
  }, 'Payment verified on-chain');

  // Record by tx signature for replay prevention (24h TTL)
  await cache.set(txKey, {
    txSignature: String(txSignature),
    fromAddress: verifiedSender,
    amount: price,
    endpoint: url,
    timestamp: new Date().toISOString(),
  }, 86400);

  request.payment = {
    wallet: verifiedSender,
    amount: price,
    currency: 'USDC',
    verifiedAt: new Date().toISOString(),
    txSignature: String(txSignature),
    network: SOLANA_MAINNET_CAIP2,
    mode: 'onchain',
  };

  reply.header('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
    success: true,
    txHash: txSignature,
    networkId: SOLANA_MAINNET_CAIP2,
  })).toString('base64'));
}
