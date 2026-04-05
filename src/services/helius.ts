import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config/env.js';
import { cache } from './cache.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface TokenAccount {
  mint: string;
  address: string;
  owner: string;
  amount: string;
  decimals: number;
  uiAmount: number;
  symbol?: string;
  name?: string;
  logoURI?: string;
  priceUSD?: number;
  valueUSD?: number;
}

export interface NFT {
  mint: string;
  name?: string;
  symbol?: string;
  collection?: string;
  imageUrl?: string;
  verified: boolean;
}

export interface WalletOverview {
  address: string;
  solBalance: number;
  solBalanceUSD: number;
  totalValueUSD: number;
  tokenCount: number;
  nftCount: number;
  isActive: boolean;
  topTokens: TokenAccount[];
}

export interface WalletPortfolio {
  address: string;
  totalValueUSD: number;
  solBalance: number;
  solBalanceUSD: number;
  tokens: TokenAccount[];
  nfts: NFT[];
  breakdown: { sol: number; tokens: number; nfts: number };
}

export interface WalletTransaction {
  signature: string;
  timestamp: string;
  type: string;
  status: 'success' | 'failed';
  fee: number;
  description: string;
}

export interface WalletActivity {
  address: string;
  transactionCount: number;
  firstTransaction?: string;
  lastTransaction?: string;
  recentTransactions: WalletTransaction[];
}

export interface RiskFactor {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  impact: number;
}

export interface WalletRisk {
  address: string;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  factors: RiskFactor[];
  warnings: string[];
}

// ──────────────────────────────────────────────
// Helius Service
// ──────────────────────────────────────────────

class HeliusService {
  private connection: Connection | null = null;
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = config.solana.heliusApiKey;
    this.baseUrl = config.solana.network === 'mainnet-beta'
      ? 'https://mainnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';
  }

  getConnection(): Connection {
    if (!this.connection) {
      if (!config.solana.rpcUrl) {
        throw new Error('Helius RPC URL not configured');
      }
      this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    }
    return this.connection;
  }

  private get rpcUrl(): string {
    return `${this.baseUrl}/?api-key=${this.apiKey}`;
  }

  /** DAS API call helper */
  private async dasCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    const data = await response.json() as { result?: T; error?: { message: string } };
    if (data.error) throw new Error(`Helius ${method}: ${data.error.message}`);
    return data.result as T;
  }

  // ── SOL ──

  async getSOLBalance(address: string): Promise<number> {
    return withRetry(async () => {
      const balance = await this.getConnection().getBalance(new PublicKey(address));
      return balance / LAMPORTS_PER_SOL;
    }, { maxRetries: 2 }, `SOL balance ${address}`);
  }

  async getSOLPrice(): Promise<number> {
    const cached = await cache.get<number>('price:SOL');
    if (cached !== null) return cached;

    try {
      const solMint = 'So11111111111111111111111111111111111111112';
      const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${solMint}`);
      const data = await response.json() as Record<string, { usdPrice?: number }>;
      const price = data[solMint]?.usdPrice ?? 0;
      await cache.set('price:SOL', price, 120);
      return price;
    } catch (error) {
      logger.warn({ error }, 'Failed to fetch SOL price');
      return 0;
    }
  }

  // ── Tokens ──

  async getTokenAccounts(address: string): Promise<TokenAccount[]> {
    const cacheKey = `tokens:${address}`;
    const cached = await cache.get<TokenAccount[]>(cacheKey);
    if (cached !== null) return cached;

    const pubkey = new PublicKey(address);
    const conn = this.getConnection();

    const [splAccounts, t22Accounts] = await Promise.all([
      conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
      conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const allAccounts = [...splAccounts.value, ...t22Accounts.value];

    const tokens: TokenAccount[] = allAccounts
      .map(acct => {
        const info = acct.account.data.parsed.info;
        const amt = info.tokenAmount;
        return {
          mint: info.mint,
          address: acct.pubkey.toString(),
          owner: info.owner,
          amount: amt.amount,
          decimals: amt.decimals,
          uiAmount: amt.uiAmount || 0,
        };
      })
      .filter(t => t.uiAmount > 0);

    // Enrich with metadata
    await this.enrichTokenMetadata(tokens);

    await cache.set(cacheKey, tokens, 300);
    return tokens;
  }

  private async enrichTokenMetadata(tokens: TokenAccount[]): Promise<void> {
    if (tokens.length === 0) return;
    try {
      const result = await this.dasCall<Array<{ id: string; content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string }; files?: Array<{ uri?: string }> } }>>('getAssetBatch', {
        ids: tokens.map(t => t.mint),
      });

      if (result) {
        const metaMap = new Map(result.map(a => [a.id, a]));
        for (const token of tokens) {
          const meta = metaMap.get(token.mint);
          if (meta?.content) {
            token.name = meta.content.metadata?.name;
            token.symbol = meta.content.metadata?.symbol;
            token.logoURI = meta.content.links?.image || meta.content.files?.[0]?.uri;
          }
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Token metadata enrichment failed (non-critical)');
    }
  }

  async getTokenPrices(mints: string[]): Promise<Map<string, number>> {
    if (mints.length === 0) return new Map();

    // Deduplicate mints
    const uniqueMints = [...new Set(mints)];

    // Check cache first (use sorted for consistent key)
    const cacheKey = `prices:${uniqueMints.sort().join(',')}`;
    const cached = await cache.get<Record<string, number>>(cacheKey);
    if (cached !== null) return new Map(Object.entries(cached));

    const priceMap = new Map<string, number>();

    try {
      // Jupiter API handles ~100 mints per request reliably
      const BATCH_SIZE = 100;
      const batches: string[][] = [];
      for (let i = 0; i < uniqueMints.length; i += BATCH_SIZE) {
        batches.push(uniqueMints.slice(i, i + BATCH_SIZE));
      }

      const batchResults = await Promise.all(
        batches.map(async (batch) => {
          try {
            const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${batch.join(',')}`);
            if (!response.ok) {
              logger.warn({ status: response.status, batch: batch.length }, 'Jupiter batch price fetch failed');
              return new Map<string, number>();
            }
            const data = await response.json() as Record<string, { usdPrice?: number }>;
            const map = new Map<string, number>();
            for (const [mint, info] of Object.entries(data)) {
              if (info?.usdPrice && info.usdPrice > 0) map.set(mint, info.usdPrice);
            }
            return map;
          } catch (err) {
            logger.warn({ error: err, batch: batch.length }, 'Jupiter batch failed');
            return new Map<string, number>();
          }
        }),
      );

      for (const batch of batchResults) {
        for (const [k, v] of batch) priceMap.set(k, v);
      }

      if (priceMap.size > 0) {
        await cache.set(cacheKey, Object.fromEntries(priceMap), 120);
      }
    } catch (error) {
      logger.warn({ error }, 'Jupiter price fetch failed');
    }

    return priceMap;
  }

  // ── NFTs ──

  async getNFTCount(address: string): Promise<number> {
    const cacheKey = `nft-count:${address}`;
    const cached = await cache.get<number>(cacheKey);
    if (cached !== null) return cached;

    try {
      const result = await this.dasCall<{ total?: number }>('getAssetsByOwner', {
        ownerAddress: address, page: 1, limit: 1,
        displayOptions: { showFungible: false },
      });
      const count = result?.total ?? 0;
      await cache.set(cacheKey, count, 600);
      return count;
    } catch (error) {
      logger.warn({ error, address }, 'NFT count failed');
      return 0;
    }
  }

  async getNFTs(address: string, limit = 50): Promise<NFT[]> {
    const cacheKey = `nfts:${address}:${limit}`;
    const cached = await cache.get<NFT[]>(cacheKey);
    if (cached !== null) return cached;

    try {
      const result = await this.dasCall<{ items?: Array<Record<string, unknown>> }>('getAssetsByOwner', {
        ownerAddress: address, page: 1, limit,
        displayOptions: { showFungible: false, showCollectionMetadata: true },
      });

      const nfts: NFT[] = (result?.items ?? []).map((asset: Record<string, unknown>) => {
        const content = asset.content as Record<string, unknown> | undefined;
        const metadata = content?.metadata as Record<string, string> | undefined;
        const links = content?.links as Record<string, string> | undefined;
        const files = content?.files as Array<{ uri?: string }> | undefined;
        const grouping = asset.grouping as Array<{ group_key: string; group_value: string }> | undefined;
        const creators = asset.creators as Array<{ verified: boolean }> | undefined;

        return {
          mint: asset.id as string,
          name: metadata?.name,
          symbol: metadata?.symbol,
          collection: grouping?.find(g => g.group_key === 'collection')?.group_value,
          imageUrl: links?.image || files?.[0]?.uri,
          verified: creators?.some(c => c.verified) ?? false,
        };
      });

      await cache.set(cacheKey, nfts, 600);
      return nfts;
    } catch (error) {
      logger.warn({ error, address }, 'NFT fetch failed');
      return [];
    }
  }

  // ── Activity ──

  async isWalletActive(address: string): Promise<boolean> {
    try {
      const sigs = await this.getConnection().getSignaturesForAddress(new PublicKey(address), { limit: 1 });
      if (sigs.length === 0) return false;
      const lastTxTime = sigs[0]?.blockTime;
      if (!lastTxTime) return false;
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
      return lastTxTime > thirtyDaysAgo;
    } catch {
      return false;
    }
  }

  async getWalletActivity(address: string, limit = 50): Promise<WalletActivity> {
    const cacheKey = `activity:${address}:${limit}`;
    const cached = await cache.get<WalletActivity>(cacheKey);
    if (cached !== null) return cached;

    const pubkey = new PublicKey(address);
    const conn = this.getConnection();
    const signatures = await conn.getSignaturesForAddress(pubkey, { limit });

    if (signatures.length === 0) {
      const empty: WalletActivity = { address, transactionCount: 0, recentTransactions: [] };
      await cache.set(cacheKey, empty, 300);
      return empty;
    }

    // Fetch parsed transactions individually (not batched — v1 had a bug here)
    const txPromises = signatures.slice(0, 10).map(async (sig) => {
      try {
        const tx = await conn.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        return { sig, tx };
      } catch {
        return { sig, tx: null };
      }
    });

    const results = await Promise.all(txPromises);

    const recentTransactions: WalletTransaction[] = results.map(({ sig, tx }) => ({
      signature: sig.signature,
      timestamp: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : new Date(0).toISOString(),
      type: inferTxType(tx),
      status: sig.err ? 'failed' as const : 'success' as const,
      fee: tx?.meta?.fee ? tx.meta.fee / LAMPORTS_PER_SOL : 0,
      description: describeTx(tx),
    }));

    const activity: WalletActivity = {
      address,
      transactionCount: signatures.length,
      firstTransaction: signatures.length > 0
        ? new Date((signatures[signatures.length - 1]?.blockTime ?? 0) * 1000).toISOString()
        : undefined,
      lastTransaction: signatures.length > 0
        ? new Date((signatures[0]?.blockTime ?? 0) * 1000).toISOString()
        : undefined,
      recentTransactions,
    };

    await cache.set(cacheKey, activity, 300);
    return activity;
  }

  // ── Composites ──

  async getWalletOverview(address: string): Promise<WalletOverview> {
    const cacheKey = `overview:${address}`;
    const cached = await cache.get<WalletOverview>(cacheKey);
    if (cached !== null) return cached;

    const [solBalance, tokens, nftCount, isActive, solPrice] = await Promise.all([
      this.getSOLBalance(address),
      this.getTokenAccounts(address),
      this.getNFTCount(address),
      this.isWalletActive(address),
      this.getSOLPrice(),
    ]);

    const prices = await this.getTokenPrices(tokens.map(t => t.mint));

    for (const token of tokens) {
      const price = prices.get(token.mint);
      if (price) {
        token.priceUSD = price;
        token.valueUSD = token.uiAmount * price;
      }
    }

    const solBalanceUSD = solBalance * solPrice;
    const tokenValueUSD = tokens.reduce((sum, t) => sum + (t.valueUSD ?? 0), 0);

    const topTokens = [...tokens]
      .filter(t => t.valueUSD && t.valueUSD > 0)
      .sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0))
      .slice(0, 5);

    const overview: WalletOverview = {
      address,
      solBalance,
      solBalanceUSD,
      totalValueUSD: solBalanceUSD + tokenValueUSD,
      tokenCount: tokens.length,
      nftCount,
      isActive,
      topTokens,
    };

    await cache.set(cacheKey, overview, 300);
    return overview;
  }

  async getWalletPortfolio(address: string): Promise<WalletPortfolio> {
    const cacheKey = `portfolio:${address}`;
    const cached = await cache.get<WalletPortfolio>(cacheKey);
    if (cached !== null) return cached;

    const [solBalance, tokens, nfts, solPrice] = await Promise.all([
      this.getSOLBalance(address),
      this.getTokenAccounts(address),
      this.getNFTs(address, 100),
      this.getSOLPrice(),
    ]);

    const prices = await this.getTokenPrices(tokens.map(t => t.mint));
    for (const token of tokens) {
      const price = prices.get(token.mint);
      if (price) { token.priceUSD = price; token.valueUSD = token.uiAmount * price; }
    }

    const solBalanceUSD = solBalance * solPrice;
    const tokensValueUSD = tokens.reduce((sum, t) => sum + (t.valueUSD ?? 0), 0);

    const portfolio: WalletPortfolio = {
      address,
      totalValueUSD: solBalanceUSD + tokensValueUSD,
      solBalance,
      solBalanceUSD,
      tokens: tokens.sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0)),
      nfts,
      breakdown: { sol: solBalanceUSD, tokens: tokensValueUSD, nfts: 0 },
    };

    await cache.set(cacheKey, portfolio, 300);
    return portfolio;
  }

  async getWalletRisk(address: string): Promise<WalletRisk> {
    const cacheKey = `risk:${address}`;
    const cached = await cache.get<WalletRisk>(cacheKey);
    if (cached !== null) return cached;

    const pubkey = new PublicKey(address);
    const conn = this.getConnection();

    const [overview, recentSigs] = await Promise.all([
      this.getWalletOverview(address),
      conn.getSignaturesForAddress(pubkey, { limit: 100 }),
    ]);

    // Find wallet age by paginating to first tx
    const firstTx = await this.getFirstTransaction(pubkey);

    const factors: RiskFactor[] = [];
    const warnings: string[] = [];
    let score = 0;

    // Wallet age
    if (firstTx?.blockTime) {
      const ageDays = Math.floor((Date.now() - firstTx.blockTime * 1000) / 86400000);
      if (ageDays < 7) {
        factors.push({ type: 'wallet_age', severity: 'high', description: `Very new wallet (${ageDays} days)`, impact: 30 });
        score += 30;
        warnings.push('Newly created wallet');
      } else if (ageDays < 30) {
        factors.push({ type: 'wallet_age', severity: 'medium', description: `New wallet (${ageDays} days)`, impact: 15 });
        score += 15;
      } else {
        factors.push({ type: 'wallet_age', severity: 'low', description: `Wallet age: ${ageDays} days`, impact: 0 });
      }
    }

    // Activity level
    const txCount = recentSigs.length;
    if (txCount < 5) {
      factors.push({ type: 'low_activity', severity: 'medium', description: `Very low activity (${txCount} recent txs)`, impact: 20 });
      score += 20;
      warnings.push('Low transaction history');
    }

    // Portfolio concentration
    if (overview.tokenCount === 0 && overview.solBalance < 0.1) {
      factors.push({ type: 'empty_wallet', severity: 'high', description: 'Minimal or no holdings', impact: 25 });
      score += 25;
      warnings.push('Empty or nearly empty wallet');
    }

    // Inactivity
    if (!overview.isActive) {
      factors.push({ type: 'inactive', severity: 'low', description: 'No activity in 30+ days', impact: 10 });
      score += 10;
    }

    const riskScore = Math.min(score, 100);
    const riskLevel = riskScore < 30 ? 'low' : riskScore < 60 ? 'medium' : 'high';

    const risk: WalletRisk = { address, riskScore, riskLevel, factors, warnings };
    await cache.set(cacheKey, risk, 600);
    return risk;
  }

  private async getFirstTransaction(pubkey: PublicKey): Promise<{ blockTime: number | null; signature: string } | null> {
    let oldest: { blockTime: number | null; signature: string } | null = null;
    let before: string | undefined;
    const conn = this.getConnection();

    for (let i = 0; i < 10; i++) {
      const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 1000, before });
      if (sigs.length === 0) break;

      const last = sigs[sigs.length - 1];
      if (last) oldest = { blockTime: last.blockTime ?? null, signature: last.signature };
      if (sigs.length < 1000) break;
      if (oldest) before = oldest.signature;
    }

    return oldest;
  }

  /** Warmup connections and caches */
  async warmup(): Promise<void> {
    try {
      const conn = this.getConnection();
      await conn.getVersion();
      await this.getSOLPrice();
      logger.info('Helius service warmed up');
    } catch (error) {
      logger.warn({ error }, 'Warmup failed (non-critical)');
    }
  }
}

// ── Helpers ──

function inferTxType(tx: unknown): string {
  const t = tx as { transaction?: { message?: { instructions?: Array<{ programId?: { toString(): string }; program?: string }> } } } | null;
  const instructions = t?.transaction?.message?.instructions ?? [];
  for (const ix of instructions) {
    const pid = ix.programId?.toString() ?? '';
    if (pid === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return 'Token Transfer';
    if (pid === '11111111111111111111111111111111') return 'SOL Transfer';
    if (pid.includes('Swap') || pid.includes('whirl') || pid.includes('JUP')) return 'Swap';
    if (pid.includes('Stake')) return 'Staking';
  }
  return 'Transaction';
}

function describeTx(tx: unknown): string {
  const t = tx as { transaction?: { message?: { instructions?: Array<{ programId?: { toString(): string } }> } } } | null;
  const instructions = t?.transaction?.message?.instructions ?? [];
  if (instructions.length === 0) return 'Transaction';
  const pid = instructions[0]?.programId?.toString() ?? '';
  if (pid === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return 'Token operation';
  if (pid === '11111111111111111111111111111111') return 'SOL transfer';
  return `Program interaction (${instructions.length} instruction${instructions.length > 1 ? 's' : ''})`;
}

/** Singleton */
export const helius = new HeliusService();
