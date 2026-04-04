#!/usr/bin/env npx tsx
/**
 * Obol Agent Client — Reference Implementation
 *
 * Shows how an AI agent discovers Obol's endpoints, prices,
 * and pays for data using x402 micropayments in USDC.
 *
 * This is a self-contained example that any agent developer can
 * copy and adapt. It handles the full flow:
 *
 *   1. Discover — hit root to get endpoint pricing
 *   2. Request — hit a paid endpoint, get 402 back
 *   3. Parse — extract payment requirements from 402
 *   4. Pay — send USDC on Solana
 *   5. Retry — hit the same endpoint with tx signature
 *   6. Receive — get the data
 *
 * Usage:
 *   npx tsx examples/agent-client.ts
 *
 * Requirements:
 *   - AGENT_PRIVATE_KEY env var (base58 Solana keypair)
 *   - Agent wallet must have USDC balance
 *   - Obol must be running (local or production)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  getAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';

// ── Config ──

const OBOL_URL = process.env.OBOL_URL ?? 'https://obol-production.up.railway.app';
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

// ── Types ──

interface ObolRoot {
  name: string;
  version: string;
  paymentMode: string;
  endpoints: Record<string, { price: string; description: string }>;
  freeEndpoints: string[];
}

interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
}

interface PaymentRequired402 {
  x402Version: number;
  error: string;
  accepts: PaymentRequirement[];
}

// ── Agent Client ──

export class ObolAgent {
  private baseUrl: string;
  private connection: Connection;
  private wallet: Keypair | null = null;
  private pricing: ObolRoot['endpoints'] | null = null;

  constructor(baseUrl?: string, rpcUrl?: string) {
    this.baseUrl = baseUrl ?? OBOL_URL;
    this.connection = new Connection(rpcUrl ?? SOLANA_RPC, 'confirmed');
  }

  /** Load agent wallet from base58 private key */
  loadWallet(privateKeyBase58: string): void {
    this.wallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    console.log(`  Agent wallet: ${this.wallet.publicKey.toBase58()}`);
  }

  /** Step 1: Discover available endpoints and pricing */
  async discover(): Promise<ObolRoot> {
    const res = await fetch(this.baseUrl);
    const root = await res.json() as ObolRoot;
    this.pricing = root.endpoints;

    console.log(`\n  Obol v${root.version} — ${root.paymentMode} mode`);
    console.log(`  ${Object.keys(root.endpoints).length} paid endpoints available\n`);

    return root;
  }

  /** Step 2: Get price for an endpoint (in USDC) */
  getPrice(endpoint: string): number | null {
    if (!this.pricing) return null;
    const match = Object.entries(this.pricing).find(([pattern]) => {
      // Simple pattern matching — replace :param with wildcard
      const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
      return regex.test(endpoint);
    });
    if (!match) return null;
    return parseFloat(match[1].price);
  }

  /** Step 3: Hit a paid endpoint — returns data or payment requirements */
  async request<T>(endpoint: string, options?: {
    method?: string;
    body?: unknown;
    paymentSignature?: string;
  }): Promise<{ success: true; data: T } | { success: false; paymentRequired: PaymentRequired402 }> {
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // If we have a payment signature, include it
    if (options?.paymentSignature) {
      const paymentPayload = {
        payload: { signature: options.paymentSignature },
      };
      headers['X-PAYMENT'] = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
    }

    const res = await fetch(url, {
      method: options?.method ?? 'GET',
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 402) {
      const body = await res.json() as PaymentRequired402;
      return { success: false, paymentRequired: body };
    }

    const body = await res.json() as { data: T };
    return { success: true, data: body.data };
  }

  /** Step 4: Send USDC payment to Obol's merchant wallet */
  async pay(requirement: PaymentRequirement): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not loaded — call loadWallet() first');

    const amount = BigInt(requirement.maxAmountRequired);
    const recipient = new PublicKey(requirement.payTo);

    // Get associated token accounts
    const senderATA = await getAssociatedTokenAddress(USDC_MINT, this.wallet.publicKey);
    const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);

    // Verify sender has enough USDC
    const senderAccount = await getAccount(this.connection, senderATA);
    if (senderAccount.amount < amount) {
      throw new Error(
        `Insufficient USDC: have ${senderAccount.amount}, need ${amount} (${Number(amount) / 10 ** USDC_DECIMALS} USDC)`,
      );
    }

    // Build transfer instruction
    const instruction = createTransferInstruction(
      senderATA,
      recipientATA,
      this.wallet.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID,
    );

    // Build and send transaction
    const tx = new Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = this.wallet.publicKey;
    tx.sign(this.wallet);

    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    console.log(`  Payment sent: ${Number(amount) / 10 ** USDC_DECIMALS} USDC`);
    console.log(`  Tx: ${signature}`);

    return signature;
  }

  /**
   * Full flow: request → pay if needed → get data
   *
   * This is the main method agents should use. It handles the entire
   * 402 flow transparently — the agent just asks for data.
   */
  async fetch<T>(endpoint: string, options?: {
    method?: string;
    body?: unknown;
  }): Promise<T> {
    // First attempt — may get 402
    const first = await this.request<T>(endpoint, options);
    if (first.success) return first.data;

    // Need to pay
    const requirement = first.paymentRequired.accepts[0];
    if (!requirement) throw new Error('No payment requirements in 402 response');

    console.log(`  402 received — ${endpoint} costs ${Number(requirement.maxAmountRequired) / 10 ** USDC_DECIMALS} USDC`);

    // Send payment
    const signature = await this.pay(requirement);

    // Retry with payment proof
    const second = await this.request<T>(endpoint, {
      ...options,
      paymentSignature: signature,
    });

    if (!second.success) {
      throw new Error(`Payment accepted but request still failed: ${JSON.stringify(second.paymentRequired)}`);
    }

    return second.data;
  }
}

// ── Example Usage ──

async function main() {
  console.log('\n  ═══════════════════════════════════════');
  console.log('  OBOL AGENT CLIENT — Reference Example');
  console.log('  ═══════════════════════════════════════\n');

  const agent = new ObolAgent();

  // Step 1: Discover
  const root = await agent.discover();

  for (const [path, info] of Object.entries(root.endpoints)) {
    console.log(`  ${info.price.padEnd(12)} ${path}`);
  }

  // Step 2: Check if we have a wallet
  const privateKey = process.env.AGENT_PRIVATE_KEY;

  if (!privateKey) {
    console.log('\n  ─────────────────────────────────────');
    console.log('  No AGENT_PRIVATE_KEY set — running in discovery-only mode.');
    console.log('  To test the full payment flow, set AGENT_PRIVATE_KEY to a');
    console.log('  base58-encoded Solana keypair with some USDC balance.');
    console.log('  ─────────────────────────────────────\n');

    // Demo: hit a free endpoint
    console.log('  Hitting free endpoint /health...');
    const health = await agent.request('/health');
    console.log('  Result:', JSON.stringify(health, null, 2));

    // Demo: hit a paid endpoint without payment to see the 402
    console.log('\n  Hitting paid endpoint without payment...');
    const priceCheck = await agent.request(
      '/api/v1/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/price',
    );
    if (!priceCheck.success) {
      console.log('  Got 402 — payment required:');
      const req = priceCheck.paymentRequired.accepts[0];
      console.log(`    Amount: ${req.maxAmountRequired} atomic units`);
      console.log(`    Pay to: ${req.payTo}`);
      console.log(`    Asset:  ${req.asset} (USDC)`);
      console.log(`    Network: ${req.network}`);
    }

    return;
  }

  // Full flow with payment
  agent.loadWallet(privateKey);

  console.log('\n  Fetching USDC price (will auto-pay if needed)...\n');

  const price = await agent.fetch<{ mint: string; priceUSD: number; timestamp: string }>(
    '/api/v1/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/price',
  );

  console.log(`\n  USDC Price: $${price.priceUSD}`);
  console.log(`  Timestamp: ${price.timestamp}`);

  console.log('\n  ═══════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Agent error:', err.message);
  process.exit(1);
});
