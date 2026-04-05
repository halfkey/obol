/**
 * STYX — State Persistence
 *
 * Saves a snapshot of whale data after each scan.
 * On next run, compares current state to previous snapshot
 * to detect meaningful changes worth tweeting about.
 *
 * State is stored as a JSON file — simple, portable, no DB needed.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

// Re-export WhaleProfile type from styx.ts for use in formatter
export interface WhaleProfile {
  label: string;
  address: string;
  overview: {
    address: string;
    solBalance: number;
    solValueUSD: number;
    tokenCount: number;
    totalValueUSD: number;
    timestamp: string;
  } | null;
  portfolio: {
    address: string;
    totalValueUSD: number;
    solBalance: number;
    solValueUSD: number;
    tokens: Array<{
      mint: string;
      symbol: string;
      name: string;
      amount: number;
      valueUSD: number;
      pricePerToken: number;
      percentOfPortfolio: number;
    }>;
    nftCount: number;
    timestamp: string;
  } | null;
  activity: {
    address: string;
    transactions: Array<{
      signature: string;
      type: string;
      description: string;
      timestamp: string;
      fee: number;
    }>;
    totalTransactions: number;
    timestamp: string;
  } | null;
  risk: {
    address: string;
    overallScore: number;
    riskLevel: string;
    factors: Array<{ name: string; score: number; description: string }>;
    timestamp: string;
  } | null;
  defi: {
    address: string;
    lst: { positions: Array<{ mint: string; name: string; amount: number; valueUSD: number }>; totalValueUSD: number };
    lp: { positions: Array<{ mint: string; name: string; amount: number; valueUSD: number }>; totalValueUSD: number };
    lending: { positions: Array<{ mint: string; name: string; amount: number; valueUSD: number }>; totalValueUSD: number };
    totalDefiValueUSD: number;
    timestamp: string;
  } | null;
  totalCost: number;
  errors: string[];
}

export interface WalletSnapshot {
  address: string;
  label: string;
  totalValueUSD: number;
  solBalance: number;
  defiValueUSD: number;
  lstValueUSD: number;
  lpValueUSD: number;
  lendingValueUSD: number;
  tokenCount: number;
  topHoldings: string[]; // top 5 token symbols
  riskScore: number;
  riskLevel: string;
  timestamp: string;
}

export interface StateSnapshot {
  version: number;
  timestamp: string;
  wallets: Record<string, WalletSnapshot>;
}

const STATE_VERSION = 1;
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_PATH = join(__dirname, 'styx-state.json');

/**
 * Load the previous state snapshot from disk.
 * Returns null if no prior state exists.
 */
export async function loadState(path?: string): Promise<StateSnapshot | null> {
  const filePath = path ?? DEFAULT_STATE_PATH;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const state = JSON.parse(raw) as StateSnapshot;
    if (state.version !== STATE_VERSION) {
      logger.warn(`State version mismatch (got ${state.version}, expected ${STATE_VERSION}), ignoring`);
      return null;
    }
    logger.info(`Loaded previous state from ${state.timestamp} (${Object.keys(state.wallets).length} wallets)`);
    return state;
  } catch {
    logger.info('No previous state found — first run');
    return null;
  }
}

/**
 * Save the current state snapshot to disk.
 */
export async function saveState(profiles: WhaleProfile[], path?: string): Promise<void> {
  const filePath = path ?? DEFAULT_STATE_PATH;
  const wallets: Record<string, WalletSnapshot> = {};

  for (const p of profiles) {
    if (!p.overview) continue;

    const topHoldings = (p.portfolio?.tokens ?? [])
      .sort((a, b) => b.valueUSD - a.valueUSD)
      .slice(0, 5)
      .map(t => t.symbol || t.name || t.mint.slice(0, 8));

    wallets[p.address] = {
      address: p.address,
      label: p.label,
      totalValueUSD: p.overview.totalValueUSD,
      solBalance: p.overview.solBalance,
      defiValueUSD: p.defi?.totalDefiValueUSD ?? 0,
      lstValueUSD: p.defi?.lst?.totalValueUSD ?? 0,
      lpValueUSD: p.defi?.lp?.totalValueUSD ?? 0,
      lendingValueUSD: p.defi?.lending?.totalValueUSD ?? 0,
      tokenCount: p.overview.tokenCount,
      topHoldings,
      riskScore: p.risk?.overallScore ?? 0,
      riskLevel: p.risk?.riskLevel ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  const snapshot: StateSnapshot = {
    version: STATE_VERSION,
    timestamp: new Date().toISOString(),
    wallets,
  };

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(snapshot, null, 2));
    logger.info(`State saved (${Object.keys(wallets).length} wallets)`);
  } catch (err) {
    logger.error(`Failed to save state: ${(err as Error).message}`);
  }
}
