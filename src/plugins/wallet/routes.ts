import type { FastifyInstance } from 'fastify';
import { validateSolanaAddress } from '../../middleware/validation.js';
import { helius } from '../../services/helius.js';
import { config } from '../../config/env.js';
import { cache } from '../../services/cache.js';

/**
 * Wallet analytics plugin — all /api/v1/wallet/* routes
 *
 * Endpoints:
 *   GET /api/v1/wallet/:address/overview   ($0.01)
 *   GET /api/v1/wallet/:address/portfolio  ($0.05)
 *   GET /api/v1/wallet/:address/activity   ($0.05)
 *   GET /api/v1/wallet/:address/risk       ($0.10)
 *   GET /api/v1/wallet/:address/pnl        ($0.15)
 */
export async function walletPlugin(app: FastifyInstance): Promise<void> {
  const rateConfig = {
    config: {
      rateLimit: {
        max: config.security.rateLimitMaxRequests,
        timeWindow: config.security.rateLimitWindowMs,
      },
    },
  };

  // ── Overview ──
  app.get(
    '/api/v1/wallet/:address/overview',
    { preHandler: validateSolanaAddress, ...rateConfig },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      try {
        const data = await helius.getWalletOverview(address);
        return reply.send({
          success: true,
          wallet: address,
          payment: request.payment,
          data,
        });
      } catch (error) {
        app.log.error({ error, address }, 'Wallet overview failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch wallet overview',
        });
      }
    },
  );

  // ── Portfolio ──
  app.get(
    '/api/v1/wallet/:address/portfolio',
    { preHandler: validateSolanaAddress, ...rateConfig },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      try {
        const data = await helius.getWalletPortfolio(address);
        return reply.send({
          success: true,
          wallet: address,
          payment: request.payment,
          data,
        });
      } catch (error) {
        app.log.error({ error, address }, 'Wallet portfolio failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch portfolio',
        });
      }
    },
  );

  // ── Activity ──
  app.get(
    '/api/v1/wallet/:address/activity',
    { preHandler: validateSolanaAddress, ...rateConfig },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      try {
        const data = await helius.getWalletActivity(address);
        return reply.send({
          success: true,
          wallet: address,
          payment: request.payment,
          data,
        });
      } catch (error) {
        app.log.error({ error, address }, 'Wallet activity failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch activity',
        });
      }
    },
  );

  // ── Risk ──
  app.get(
    '/api/v1/wallet/:address/risk',
    { preHandler: validateSolanaAddress, ...rateConfig },
    async (request, reply) => {
      const { address } = request.params as { address: string };
      try {
        const data = await helius.getWalletRisk(address);
        return reply.send({
          success: true,
          wallet: address,
          payment: request.payment,
          data,
        });
      } catch (error) {
        app.log.error({ error, address }, 'Wallet risk failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch risk assessment',
        });
      }
    },
  );

  // ── P&L ──
  app.get(
    '/api/v1/wallet/:address/pnl',
    { preHandler: validateSolanaAddress, ...rateConfig },
    async (request, reply) => {
      const { address } = request.params as { address: string };

      try {
        const cacheKey = `wallet-pnl:${address}`;
        const cached = await cache.get<WalletPnL>(cacheKey);
        if (cached) {
          return reply.send({ success: true, wallet: address, payment: request.payment, data: cached });
        }

        const heliusApiKey = config.solana.heliusApiKey;
        if (!heliusApiKey) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'Helius API not configured',
          });
        }

        // Step 1: Get current portfolio state
        const portfolio = await helius.getWalletPortfolio(address);

        // Step 2: Get parsed transaction history to compute cost basis
        // Use Helius Enhanced Transactions API for cleaner data
        const rpcUrl = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${heliusApiKey}&limit=100`;
        const txResponse = await fetch(rpcUrl);

        if (!txResponse.ok) {
          return reply.code(502).send({
            error: 'Helius API Error',
            message: 'Failed to fetch transaction history for P&L',
          });
        }

        const transactions = await txResponse.json() as EnhancedTransaction[];

        // Step 3: Walk transactions to compute per-token cost basis
        const tokenFlows: Record<string, { totalIn: number; totalOut: number; costBasisUSD: number }> = {};

        for (const tx of transactions) {
          if (tx.transactionError) continue;

          for (const transfer of tx.tokenTransfers ?? []) {
            const mint = transfer.mint;
            if (!mint) continue;

            if (!tokenFlows[mint]) {
              tokenFlows[mint] = { totalIn: 0, totalOut: 0, costBasisUSD: 0 };
            }

            const amount = transfer.tokenAmount ?? 0;

            if (transfer.toUserAccount === address) {
              // Inflow — tokens received
              tokenFlows[mint].totalIn += amount;
            } else if (transfer.fromUserAccount === address) {
              // Outflow — tokens sent
              tokenFlows[mint].totalOut += amount;
            }
          }

          // Track SOL flows
          for (const transfer of tx.nativeTransfers ?? []) {
            const solMint = 'SOL';
            if (!tokenFlows[solMint]) {
              tokenFlows[solMint] = { totalIn: 0, totalOut: 0, costBasisUSD: 0 };
            }

            const amount = (transfer.amount ?? 0) / 1e9; // lamports to SOL

            if (transfer.toUserAccount === address) {
              tokenFlows[solMint].totalIn += amount;
            } else if (transfer.fromUserAccount === address) {
              tokenFlows[solMint].totalOut += amount;
            }
          }
        }

        // Step 4: Get current prices for all tokens in flows
        const mintAddresses = Object.keys(tokenFlows).filter(m => m !== 'SOL');
        let currentPrices: Record<string, number> = {};

        if (mintAddresses.length > 0) {
          const priceResponse = await fetch(
            `https://lite-api.jup.ag/price/v3?ids=${mintAddresses.join(',')}`,
          );
          const priceData = await priceResponse.json() as Record<string, { usdPrice?: number }>;
          for (const [mint, data] of Object.entries(priceData)) {
            if (data?.usdPrice) currentPrices[mint] = data.usdPrice;
          }
        }

        // Add SOL price
        const solPriceResponse = await fetch(
          'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
        );
        const solPriceData = await solPriceResponse.json() as Record<string, { usdPrice?: number }>;
        const solPrice = solPriceData['So11111111111111111111111111111111111111112']?.usdPrice ?? 0;
        currentPrices['SOL'] = solPrice;

        // Step 5: Compute P&L per token
        const tokenPnL: TokenPnLEntry[] = [];
        let totalUnrealizedUSD = 0;
        let totalCurrentValueUSD = 0;

        for (const [mint, flows] of Object.entries(tokenFlows)) {
          const netTokens = flows.totalIn - flows.totalOut;
          const currentPrice = currentPrices[mint] ?? 0;
          const currentValue = netTokens * currentPrice;

          // We can track flows but true cost basis requires swap price data
          // which enhanced transactions don't always provide.
          // Report holdings value and flow summary — agents can layer on cost basis.
          if (Math.abs(netTokens) > 0.0001) {
            tokenPnL.push({
              mint,
              netTokens: Number(netTokens.toFixed(6)),
              totalIn: Number(flows.totalIn.toFixed(6)),
              totalOut: Number(flows.totalOut.toFixed(6)),
              currentPriceUSD: currentPrice,
              currentValueUSD: Number(currentValue.toFixed(2)),
            });

            if (currentValue > 0) {
              totalCurrentValueUSD += currentValue;
            }
            totalUnrealizedUSD += currentValue;
          }
        }

        // Sort by absolute value descending
        tokenPnL.sort((a, b) => Math.abs(b.currentValueUSD) - Math.abs(a.currentValueUSD));

        const pnl: WalletPnL = {
          address,
          portfolioValueUSD: portfolio.totalValueUSD ?? 0,
          tokenFlows: tokenPnL,
          totalCurrentValueFromFlows: Number(totalCurrentValueUSD.toFixed(2)),
          transactionsAnalyzed: transactions.length,
          note: 'P&L is computed from the last 100 transactions. Cost basis requires full history and swap price data for precision.',
          timestamp: new Date().toISOString(),
        };

        await cache.set(cacheKey, pnl, 180); // 3 min cache

        return reply.send({ success: true, wallet: address, payment: request.payment, data: pnl });
      } catch (error) {
        app.log.error({ error, address }, 'Wallet P&L failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to compute wallet P&L',
        });
      }
    },
  );
}

// ── Types ──

interface WalletPnL {
  address: string;
  portfolioValueUSD: number;
  tokenFlows: TokenPnLEntry[];
  totalCurrentValueFromFlows: number;
  transactionsAnalyzed: number;
  note: string;
  timestamp: string;
}

interface TokenPnLEntry {
  mint: string;
  netTokens: number;
  totalIn: number;
  totalOut: number;
  currentPriceUSD: number;
  currentValueUSD: number;
}

interface EnhancedTransaction {
  transactionError?: string | null;
  tokenTransfers?: Array<{
    mint?: string;
    tokenAmount?: number;
    fromUserAccount?: string;
    toUserAccount?: string;
  }>;
  nativeTransfers?: Array<{
    amount?: number;
    fromUserAccount?: string;
    toUserAccount?: string;
  }>;
}
