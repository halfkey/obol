#!/usr/bin/env npx tsx
/**
 * STYX — Whale Intelligence Agent
 *
 * Monitors Solana whale wallets using Obol's paid endpoints,
 * paying for each data call in USDC via x402 micropayments.
 *
 * For each tracked wallet, Styx builds a complete intelligence
 * profile: portfolio breakdown, recent activity, risk assessment,
 * DeFi positions, and P&L analysis. It then generates an
 * actionable intelligence report highlighting notable moves.
 *
 * This is a reference agent showing how to build real products
 * on top of Obol's pay-per-use Solana data infrastructure.
 *
 * Usage:
 *   npx tsx agents/styx/styx.ts                     # discovery mode (no wallet needed)
 *   AGENT_PRIVATE_KEY=... npx tsx agents/styx/styx.ts  # full auto-pay mode
 *
 * Environment:
 *   OBOL_URL           — Obol instance (default: production)
 *   AGENT_PRIVATE_KEY  — base58 Solana keypair with USDC balance
 *   SOLANA_RPC         — RPC endpoint (default: public mainnet)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  getAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { StyxTwitterClient } from './twitter.js';
import { formatMorningScan, formatChangeTweets } from './formatter.js';
import { loadState, saveState } from './state.js';
import { logger } from './logger.js';

// ── Config ──

const OBOL_URL = process.env.OBOL_URL ?? 'https://obol-production.up.railway.app';
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const OBOL_INTERNAL_KEY = process.env.OBOL_INTERNAL_KEY ?? '';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

// ── Known Whale Wallets ──
// These are well-known Solana whale/fund wallets for demo purposes.
// In production, you'd maintain a dynamic watchlist.

const WHALE_WATCHLIST: { address: string; label: string }[] = [
  { address: '7rhxnLV8C73BKXRN4oPsbGMGjCdmkvLgLFi3Q36aJtHg', label: 'Whale Alpha' },
  { address: 'FDKJvWkFJnPYMj79v8JGnBsqGPGbwCPCfYWSnEWBcSME', label: 'DeFi Degen' },
  { address: 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq', label: 'Sanctum Whale' },
];

// ── Types ──

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

interface WalletOverview {
  address: string;
  solBalance: number;
  solValueUSD: number;
  tokenCount: number;
  totalValueUSD: number;
  timestamp: string;
}

interface TokenHolding {
  mint: string;
  symbol: string;
  name: string;
  amount: number;
  valueUSD: number;
  pricePerToken: number;
  percentOfPortfolio: number;
}

interface WalletPortfolio {
  address: string;
  totalValueUSD: number;
  solBalance: number;
  solValueUSD: number;
  tokens: TokenHolding[];
  nftCount: number;
  timestamp: string;
}

interface ActivityItem {
  signature: string;
  type: string;
  description: string;
  timestamp: string;
  fee: number;
}

interface WalletActivity {
  address: string;
  transactions: ActivityItem[];
  totalTransactions: number;
  timestamp: string;
}

interface RiskFactor {
  name: string;
  score: number;
  description: string;
}

interface WalletRisk {
  address: string;
  overallScore: number;
  riskLevel: string;
  factors: RiskFactor[];
  timestamp: string;
}

interface DefiPositions {
  address: string;
  lst: { positions: { mint: string; name: string; amount: number; valueUSD: number }[]; totalValueUSD: number };
  lp: { positions: { mint: string; name: string; amount: number; valueUSD: number }[]; totalValueUSD: number };
  lending: { positions: { mint: string; name: string; amount: number; valueUSD: number }[]; totalValueUSD: number };
  totalDefiValueUSD: number;
  timestamp: string;
}

interface WhaleProfile {
  label: string;
  address: string;
  overview: WalletOverview | null;
  portfolio: WalletPortfolio | null;
  activity: WalletActivity | null;
  risk: WalletRisk | null;
  defi: DefiPositions | null;
  totalCost: number;
  errors: string[];
}

// ── Obol Client (embedded — no external deps) ──

class ObolClient {
  private baseUrl: string;
  private connection: Connection;
  private wallet: Keypair | null = null;
  private totalSpent = 0;
  private callCount = 0;

  constructor() {
    this.baseUrl = OBOL_URL;
    this.connection = new Connection(SOLANA_RPC, 'confirmed');
  }

  loadWallet(privateKeyBase58: string): void {
    this.wallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  }

  get walletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() ?? null;
  }

  get stats() {
    return { totalSpent: this.totalSpent, callCount: this.callCount };
  }

  /** Make a request to Obol — uses internal API key if available, falls back to x402 payment */
  async fetch<T>(endpoint: string): Promise<T | null> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      // Use internal API key if available (bypasses x402 payment)
      if (OBOL_INTERNAL_KEY) {
        headers['X-API-KEY'] = OBOL_INTERNAL_KEY;
      }

      const res = await fetch(`${this.baseUrl}${endpoint}`, { headers });

      if (res.status === 200) {
        this.callCount++;
        const body = await res.json() as { data: T };
        console.log(`    ✓ ${endpoint}`);
        return body.data;
      }

      if (res.status !== 402) {
        console.log(`    ⚠ ${endpoint} returned ${res.status}`);
        return null;
      }

      // 402 — need to pay (only when no internal key)
      if (!this.wallet) {
        const body = await res.json() as PaymentRequired402;
        const req = body.accepts[0];
        const cost = Number(req.maxAmountRequired) / 10 ** USDC_DECIMALS;
        console.log(`    💰 ${endpoint} — $${cost} USDC (no wallet, skipping)`);
        return null;
      }

      const body = await res.json() as PaymentRequired402;
      const requirement = body.accepts[0];
      if (!requirement) return null;

      const cost = Number(requirement.maxAmountRequired) / 10 ** USDC_DECIMALS;

      // Send payment
      const signature = await this.pay(requirement);

      // Retry with proof
      const paymentPayload = { payload: { signature } };
      const retryRes = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
        },
      });

      if (retryRes.status === 200) {
        this.totalSpent += cost;
        this.callCount++;
        console.log(`    ✓ ${endpoint} — paid $${cost} USDC`);
        const retryBody = await retryRes.json() as { data: T };
        return retryBody.data;
      }

      console.log(`    ✗ ${endpoint} — payment sent but request failed (${retryRes.status})`);
      return null;
    } catch (err) {
      console.log(`    ✗ ${endpoint} — ${(err as Error).message}`);
      return null;
    }
  }

  private async pay(requirement: PaymentRequirement): Promise<string> {
    if (!this.wallet) throw new Error('No wallet');

    const amount = BigInt(requirement.maxAmountRequired);
    const recipient = new PublicKey(requirement.payTo);

    const senderATA = await getAssociatedTokenAddress(USDC_MINT, this.wallet.publicKey);
    const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);

    const senderAccount = await getAccount(this.connection, senderATA);
    if (senderAccount.amount < amount) {
      throw new Error(`Insufficient USDC: have ${senderAccount.amount}, need ${amount}`);
    }

    const instruction = createTransferInstruction(
      senderATA, recipientATA, this.wallet.publicKey, amount, [], TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction().add(instruction);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = this.wallet.publicKey;
    tx.sign(this.wallet);

    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    return signature;
  }
}

// ── Whale Intelligence Engine ──

async function buildWhaleProfile(client: ObolClient, wallet: { address: string; label: string }): Promise<WhaleProfile> {
  const profile: WhaleProfile = {
    label: wallet.label,
    address: wallet.address,
    overview: null,
    portfolio: null,
    activity: null,
    risk: null,
    defi: null,
    totalCost: 0,
    errors: [],
  };

  const addr = wallet.address;

  console.log(`\n  ── ${wallet.label} (${addr.slice(0, 8)}...${addr.slice(-4)}) ──`);

  // Parallel fetch all data for this whale
  const [overview, portfolio, activity, risk, defi] = await Promise.all([
    client.fetch<WalletOverview>(`/api/v1/wallet/${addr}/overview`),
    client.fetch<WalletPortfolio>(`/api/v1/wallet/${addr}/portfolio`),
    client.fetch<WalletActivity>(`/api/v1/wallet/${addr}/activity`),
    client.fetch<WalletRisk>(`/api/v1/wallet/${addr}/risk`),
    client.fetch<DefiPositions>(`/api/v1/defi/positions/${addr}`),
  ]);

  profile.overview = overview;
  profile.portfolio = portfolio;
  profile.activity = activity;
  profile.risk = risk;
  profile.defi = defi;

  return profile;
}

// ── Report Generator ──

function generateReport(profiles: WhaleProfile[], stats: { totalSpent: number; callCount: number }): string {
  const lines: string[] = [];
  const divider = '═'.repeat(60);
  const thinDivider = '─'.repeat(60);

  lines.push('');
  lines.push(divider);
  lines.push('  STYX — WHALE INTELLIGENCE REPORT');
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push(`  Wallets tracked: ${profiles.length}`);
  lines.push(`  Obol API calls: ${stats.callCount} | Total cost: $${stats.totalSpent.toFixed(4)} USDC`);
  lines.push(divider);

  for (const p of profiles) {
    lines.push('');
    lines.push(thinDivider);
    lines.push(`  ${p.label.toUpperCase()}`);
    lines.push(`  ${p.address}`);
    lines.push(thinDivider);

    // Overview
    if (p.overview) {
      lines.push('');
      lines.push('  OVERVIEW');
      lines.push(`    Total Value:   $${formatUSD(p.overview.totalValueUSD)}`);
      lines.push(`    SOL Balance:   ${p.overview.solBalance.toFixed(2)} SOL ($${formatUSD(p.overview.solValueUSD)})`);
      lines.push(`    Token Count:   ${p.overview.tokenCount}`);
    }

    // Top Holdings
    if (p.portfolio?.tokens?.length) {
      lines.push('');
      lines.push('  TOP HOLDINGS');
      const top = p.portfolio.tokens
        .sort((a, b) => b.valueUSD - a.valueUSD)
        .slice(0, 8);
      for (const t of top) {
        const pct = t.percentOfPortfolio?.toFixed(1) ?? '?';
        lines.push(`    ${(t.symbol || t.name || t.mint.slice(0, 8)).padEnd(12)} $${formatUSD(t.valueUSD).padStart(12)}  (${pct}%)`);
      }
      if (p.portfolio.nftCount > 0) {
        lines.push(`    + ${p.portfolio.nftCount} NFTs`);
      }
    }

    // DeFi Positions
    if (p.defi && p.defi.totalDefiValueUSD > 0) {
      lines.push('');
      lines.push('  DEFI EXPOSURE');
      lines.push(`    Total DeFi:    $${formatUSD(p.defi.totalDefiValueUSD)}`);
      if (p.defi.lst.totalValueUSD > 0) {
        lines.push(`    LSTs:          $${formatUSD(p.defi.lst.totalValueUSD)}`);
        for (const pos of p.defi.lst.positions) {
          lines.push(`      ${pos.name.padEnd(20)} ${pos.amount.toFixed(4).padStart(12)} ($${formatUSD(pos.valueUSD)})`);
        }
      }
      if (p.defi.lp.totalValueUSD > 0) {
        lines.push(`    LP Positions:  $${formatUSD(p.defi.lp.totalValueUSD)}`);
      }
      if (p.defi.lending.totalValueUSD > 0) {
        lines.push(`    Lending:       $${formatUSD(p.defi.lending.totalValueUSD)}`);
      }
    }

    // Risk Assessment
    if (p.risk) {
      lines.push('');
      lines.push('  RISK ASSESSMENT');
      lines.push(`    Overall:       ${p.risk.overallScore}/100 (${p.risk.riskLevel})`);
      if (p.risk.factors?.length) {
        for (const f of p.risk.factors.slice(0, 5)) {
          lines.push(`    ${f.name.padEnd(18)} ${f.score}/100  ${f.description}`);
        }
      }
    }

    // Recent Activity
    if (p.activity?.transactions?.length) {
      lines.push('');
      lines.push('  RECENT ACTIVITY');
      const recent = p.activity.transactions.slice(0, 5);
      for (const tx of recent) {
        const time = new Date(tx.timestamp).toLocaleString();
        lines.push(`    [${tx.type?.padEnd(10) ?? 'unknown   '}] ${tx.description?.slice(0, 50) ?? tx.signature.slice(0, 20)} — ${time}`);
      }
      if (p.activity.totalTransactions > 5) {
        lines.push(`    ... and ${p.activity.totalTransactions - 5} more transactions`);
      }
    }

    // Signals
    lines.push('');
    lines.push('  SIGNALS');
    const signals = detectSignals(p);
    if (signals.length === 0) {
      lines.push('    No notable signals detected.');
    } else {
      for (const s of signals) {
        lines.push(`    ${s}`);
      }
    }
  }

  // Summary
  lines.push('');
  lines.push(divider);
  lines.push('  CROSS-WALLET SUMMARY');
  lines.push(divider);

  const totalValue = profiles.reduce((sum, p) => sum + (p.overview?.totalValueUSD ?? 0), 0);
  const totalDefi = profiles.reduce((sum, p) => sum + (p.defi?.totalDefiValueUSD ?? 0), 0);

  lines.push(`  Combined portfolio value:  $${formatUSD(totalValue)}`);
  lines.push(`  Combined DeFi exposure:    $${formatUSD(totalDefi)}`);
  lines.push(`  Highest risk wallet:       ${profiles.sort((a, b) => (b.risk?.overallScore ?? 0) - (a.risk?.overallScore ?? 0))[0]?.label ?? 'N/A'}`);
  lines.push('');
  lines.push(`  Data cost: ${stats.callCount} API calls = $${stats.totalSpent.toFixed(4)} USDC`);
  lines.push(`  Powered by Obol (obol-mcp) — pay-per-use Solana data via x402`);
  lines.push(divider);
  lines.push('');

  return lines.join('\n');
}

function detectSignals(profile: WhaleProfile): string[] {
  const signals: string[] = [];

  // High value wallet
  if (profile.overview && profile.overview.totalValueUSD > 1_000_000) {
    signals.push(`[SIZE] $${formatUSD(profile.overview.totalValueUSD)} portfolio — major whale`);
  }

  // Heavy concentration
  if (profile.portfolio?.tokens?.length) {
    const top = profile.portfolio.tokens[0];
    if (top && top.percentOfPortfolio > 50) {
      signals.push(`[CONCENTRATION] ${top.symbol || top.name} is ${top.percentOfPortfolio.toFixed(0)}% of portfolio`);
    }
  }

  // Significant DeFi exposure
  if (profile.defi && profile.overview) {
    const defiPct = (profile.defi.totalDefiValueUSD / profile.overview.totalValueUSD) * 100;
    if (defiPct > 30) {
      signals.push(`[DEFI] ${defiPct.toFixed(0)}% of portfolio in DeFi positions`);
    }
  }

  // LST heavy
  if (profile.defi?.lst?.totalValueUSD && profile.defi.lst.totalValueUSD > 100_000) {
    signals.push(`[LST] $${formatUSD(profile.defi.lst.totalValueUSD)} in liquid staking`);
  }

  // High risk
  if (profile.risk && profile.risk.overallScore > 70) {
    signals.push(`[RISK] Score ${profile.risk.overallScore}/100 — ${profile.risk.riskLevel}`);
  }

  // Low risk (interesting for a whale)
  if (profile.risk && profile.risk.overallScore < 30) {
    signals.push(`[SAFE] Score ${profile.risk.overallScore}/100 — conservative whale`);
  }

  return signals;
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

// ── Run Modes ──

type RunMode = 'scan' | 'report' | 'dry-run';

function getRunMode(): RunMode {
  const arg = process.argv[2];
  if (arg === '--report' || arg === '-r') return 'report';
  if (arg === '--dry-run' || arg === '-d') return 'dry-run';
  return 'scan';
}

// ── Main ──

async function main() {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║  STYX — Whale Intelligence Agent         ║');
  console.log('  ║  Powered by Obol x402 micropayments      ║');
  console.log('  ╚══════════════════════════════════════════╝');

  const mode = getRunMode();
  const client = new ObolClient();

  // Check for wallet
  const privateKey = process.env.AGENT_PRIVATE_KEY;
  if (privateKey) {
    client.loadWallet(privateKey);
    logger.info(`Agent wallet: ${client.walletAddress}`);
    logger.info('Mode: LIVE — will pay USDC for each data call');
  } else {
    logger.info('Mode: DISCOVERY — no wallet, showing what data costs');
    logger.info('Set AGENT_PRIVATE_KEY to enable auto-pay');
  }

  // Cost estimate
  const perWallet = 0.01 + 0.05 + 0.05 + 0.10 + 0.10;
  const totalEstimate = perWallet * WHALE_WATCHLIST.length;
  logger.info(`Tracking ${WHALE_WATCHLIST.length} wallets — est. $${totalEstimate.toFixed(2)} USDC`);

  // Load previous state for change detection
  const previousState = await loadState();

  // Build profiles
  const profiles: WhaleProfile[] = [];
  for (const whale of WHALE_WATCHLIST) {
    const profile = await buildWhaleProfile(client, whale);
    profiles.push(profile);
  }

  // Generate console report (always)
  const report = generateReport(profiles, client.stats);
  console.log(report);

  // Report-only mode: print report and exit
  if (mode === 'report') {
    logger.info('Report mode — skipping Twitter');
    await saveState(profiles);
    return;
  }

  // Twitter posting
  const isDryRun = mode === 'dry-run' || !process.env.TWITTER_APP_KEY;
  if (isDryRun && mode !== 'dry-run') {
    logger.info('No Twitter credentials found — running in dry-run mode');
  }

  const twitter = new StyxTwitterClient({ dryRun: isDryRun });

  // Verify credentials
  const me = await twitter.verify();
  if (!me) {
    logger.error('Twitter auth failed — skipping posting');
    await saveState(profiles);
    return;
  }

  // Decide what to tweet
  const changeTweets = formatChangeTweets(profiles, previousState);
  const morningScan = formatMorningScan(profiles);

  if (changeTweets.length > 0) {
    // We have regime shifts — post those (higher signal)
    logger.info(`Posting ${changeTweets.length} change detection tweets`);
    await twitter.thread(changeTweets);
  } else if (morningScan.length > 0) {
    // No changes detected — post the morning scan
    logger.info(`Posting morning scan (${morningScan.length} tweets)`);
    await twitter.thread(morningScan);
  } else {
    logger.info('Nothing interesting to tweet — staying silent');
  }

  // Save current state for next run's comparison
  await saveState(profiles);

  logger.info(`Done — ${client.stats.callCount} API calls, $${client.stats.totalSpent.toFixed(4)} USDC spent`);
}

main().catch(err => {
  console.error('\n  Styx error:', err.message);
  process.exit(1);
});
