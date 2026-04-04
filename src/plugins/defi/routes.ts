import type { FastifyInstance } from 'fastify';
import { validateSolanaAddress } from '../../middleware/validation.js';
import { config } from '../../config/env.js';
import { cache } from '../../services/cache.js';

/**
 * DeFi plugin — all /api/v1/defi/* routes
 *
 * Endpoints:
 *   GET  /api/v1/defi/swap/quote       ($0.005) — Jupiter swap quote
 *   GET  /api/v1/defi/positions/:addr   ($0.10)  — DeFi positions aggregation
 *   GET  /api/v1/defi/lst/yields        ($0.02)  — LST yield comparison
 */
export async function defiPlugin(app: FastifyInstance): Promise<void> {
  const rateConfig = {
    config: {
      rateLimit: {
        max: config.security.rateLimitMaxRequests,
        timeWindow: config.security.rateLimitWindowMs,
      },
    },
  };

  // ── Swap Quote (Jupiter v6) ──
  app.get(
    '/api/v1/defi/swap/quote',
    rateConfig,
    async (request, reply) => {
      const query = request.query as {
        inputMint?: string;
        outputMint?: string;
        amount?: string;
        slippageBps?: string;
      };

      if (!query.inputMint || !query.outputMint || !query.amount) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Required query params: inputMint, outputMint, amount (in atomic units)',
        });
      }

      const slippageBps = query.slippageBps ?? '50'; // default 0.5%

      try {
        const cacheKey = `swap-quote:${query.inputMint}:${query.outputMint}:${query.amount}:${slippageBps}`;
        const cached = await cache.get<SwapQuote>(cacheKey);
        if (cached) {
          return reply.send({ success: true, payment: request.payment, data: cached });
        }

        const params = new URLSearchParams({
          inputMint: query.inputMint,
          outputMint: query.outputMint,
          amount: query.amount,
          slippageBps,
        });

        const response = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`);

        if (!response.ok) {
          const text = await response.text();
          return reply.code(response.status).send({
            error: 'Jupiter API Error',
            message: text || 'Failed to get swap quote',
          });
        }

        const jupiterQuote = await response.json() as JupiterQuoteResponse;

        const quote: SwapQuote = {
          inputMint: jupiterQuote.inputMint,
          outputMint: jupiterQuote.outputMint,
          inAmount: jupiterQuote.inAmount,
          outAmount: jupiterQuote.outAmount,
          otherAmountThreshold: jupiterQuote.otherAmountThreshold,
          priceImpactPct: jupiterQuote.priceImpactPct,
          slippageBps: Number(slippageBps),
          routePlan: jupiterQuote.routePlan?.map(r => ({
            swapInfo: {
              ammKey: r.swapInfo.ammKey,
              label: r.swapInfo.label ?? 'Unknown',
              inAmount: r.swapInfo.inAmount,
              outAmount: r.swapInfo.outAmount,
              feeAmount: r.swapInfo.feeAmount,
              feeMint: r.swapInfo.feeMint,
            },
            percent: r.percent,
          })) ?? [],
          timestamp: new Date().toISOString(),
        };

        await cache.set(cacheKey, quote, 10); // 10s cache — quotes are time-sensitive

        return reply.send({ success: true, payment: request.payment, data: quote });
      } catch (error) {
        app.log.error({ error }, 'Swap quote failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch swap quote',
        });
      }
    },
  );

  // ── DeFi Positions ──
  app.get(
    '/api/v1/defi/positions/:address',
    { preHandler: validateSolanaAddress, ...rateConfig },
    async (request, reply) => {
      const { address } = request.params as { address: string };

      try {
        const cacheKey = `defi-positions:${address}`;
        const cached = await cache.get<DefiPositions>(cacheKey);
        if (cached) {
          return reply.send({ success: true, address, payment: request.payment, data: cached });
        }

        const heliusApiKey = config.solana.heliusApiKey;
        if (!heliusApiKey) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'Helius API not configured',
          });
        }

        // Fetch all token accounts to identify DeFi positions
        const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

        // Get all assets via DAS — includes staked, lent, LP positions
        const dasResponse = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'defi-positions',
            method: 'searchAssets',
            params: {
              ownerAddress: address,
              displayOptions: { showFungible: true, showNativeBalance: true },
            },
          }),
        });

        const dasResult = await dasResponse.json() as {
          result?: { items?: DasAssetItem[]; nativeBalance?: { lamports: number } };
          error?: { message: string };
        };

        if (dasResult.error || !dasResult.result?.items) {
          return reply.code(502).send({
            error: 'DAS Error',
            message: dasResult.error?.message ?? 'Failed to fetch assets',
          });
        }

        const items = dasResult.result.items;

        // Categorize assets into DeFi positions
        const lstPositions: LstPosition[] = [];
        const lpPositions: LpPosition[] = [];
        const lendingPositions: GenericPosition[] = [];
        const otherDefi: GenericPosition[] = [];

        // Known LST mints
        const LST_MINTS: Record<string, string> = {
          'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL (Marinade)',
          'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL (Jito)',
          'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 'bSOL (BlazeStake)',
          '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn': 'jSOL (JPOOL)',
          'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A': 'hSOL (Helius)',
          'vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7': 'vSOL (The Vault)',
          'LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp': 'lstSOL (Sanctum Infinity)',
          'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v': 'jupSOL (Jupiter)',
          'Comp4ssDzXcLeu2MnLuGNNFC4cmLPMng8qWHPvzAMU1h': 'compassSOL (Compass)',
          'picobAEvs6w7QEknPce34wAE4gknZA9v5tTonnmHYdX': 'picoSOL',
          'inf5RhVRucEPaQTCE24a9EkwMHiajbGFRMGjgwrsCWK': 'infSOL (Sanctum)',
        };

        // Known LP / DeFi protocol indicators
        const DEFI_PROTOCOLS = ['Raydium', 'Orca', 'Meteora', 'Kamino', 'Marinade', 'Lulo', 'Drift', 'Mango'];

        for (const item of items) {
          const mint = item.id;
          const name = item.content?.metadata?.name ?? '';
          const symbol = item.content?.metadata?.symbol ?? '';
          const amount = item.token_info?.balance
            ? Number(item.token_info.balance) / Math.pow(10, item.token_info.decimals ?? 0)
            : 0;

          if (amount === 0) continue;

          const pricePerToken = item.token_info?.price_info?.price_per_token ?? 0;
          const valueUSD = amount * pricePerToken;

          // Check if it's an LST
          if (LST_MINTS[mint]) {
            lstPositions.push({
              mint,
              name: LST_MINTS[mint],
              amount,
              valueUSD,
              pricePerToken,
            });
            continue;
          }

          // Check if it's a known DeFi protocol position
          const isDefi = DEFI_PROTOCOLS.some(p =>
            name.toLowerCase().includes(p.toLowerCase()) ||
            symbol.toLowerCase().includes(p.toLowerCase()),
          );

          if (isDefi) {
            // Try to determine if it's LP, lending, or other
            const isLp = name.toLowerCase().includes('lp') ||
              symbol.toLowerCase().includes('lp') ||
              name.toLowerCase().includes('pool');

            if (isLp) {
              lpPositions.push({
                mint,
                name: name || symbol,
                amount,
                valueUSD,
                protocol: DEFI_PROTOCOLS.find(p => name.toLowerCase().includes(p.toLowerCase())) ?? 'Unknown',
              });
            } else {
              lendingPositions.push({ mint, name: name || symbol, amount, valueUSD });
            }
            continue;
          }

          // Check by symbol patterns common in DeFi
          if (symbol.includes('LP') || symbol.includes('CLMM') || name.includes('Position')) {
            lpPositions.push({
              mint,
              name: name || symbol,
              amount,
              valueUSD,
              protocol: 'Unknown',
            });
          }
        }

        const positions: DefiPositions = {
          address,
          lst: {
            positions: lstPositions,
            totalValueUSD: lstPositions.reduce((s, p) => s + p.valueUSD, 0),
          },
          lp: {
            positions: lpPositions,
            totalValueUSD: lpPositions.reduce((s, p) => s + p.valueUSD, 0),
          },
          lending: {
            positions: lendingPositions,
            totalValueUSD: lendingPositions.reduce((s, p) => s + p.valueUSD, 0),
          },
          other: {
            positions: otherDefi,
            totalValueUSD: otherDefi.reduce((s, p) => s + p.valueUSD, 0),
          },
          totalDefiValueUSD:
            lstPositions.reduce((s, p) => s + p.valueUSD, 0) +
            lpPositions.reduce((s, p) => s + p.valueUSD, 0) +
            lendingPositions.reduce((s, p) => s + p.valueUSD, 0) +
            otherDefi.reduce((s, p) => s + p.valueUSD, 0),
          timestamp: new Date().toISOString(),
        };

        await cache.set(cacheKey, positions, 120); // 2 min cache

        return reply.send({ success: true, address, payment: request.payment, data: positions });
      } catch (error) {
        app.log.error({ error, address }, 'DeFi positions failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch DeFi positions',
        });
      }
    },
  );

  // ── LST Yield Comparison ──
  app.get(
    '/api/v1/defi/lst/yields',
    rateConfig,
    async (request, reply) => {
      try {
        const cacheKey = 'lst-yields';
        const cached = await cache.get<LstYieldComparison>(cacheKey);
        if (cached) {
          return reply.send({ success: true, payment: request.payment, data: cached });
        }

        // Fetch from Sanctum's API — canonical source for LST yields
        const [sanctumResponse, solPriceResponse] = await Promise.all([
          fetch('https://sanctum-extra-api.ngrok.dev/v1/apy/latest'),
          fetch('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112'),
        ]);

        let sanctumApys: Record<string, number> = {};
        if (sanctumResponse.ok) {
          const sanctumData = await sanctumResponse.json() as { apys: Record<string, number> };
          sanctumApys = sanctumData.apys ?? {};
        }

        const solPriceData = await solPriceResponse.json() as Record<string, { usdPrice?: number }>;
        const solPrice = solPriceData['So11111111111111111111111111111111111111112']?.usdPrice ?? 0;

        // Known LSTs with their mints
        const LST_INFO: Array<{ mint: string; name: string; provider: string }> = [
          { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', name: 'mSOL', provider: 'Marinade' },
          { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', name: 'jitoSOL', provider: 'Jito' },
          { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', name: 'bSOL', provider: 'BlazeStake' },
          { mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', name: 'jupSOL', provider: 'Jupiter' },
          { mint: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', name: 'hSOL', provider: 'Helius' },
          { mint: 'vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7', name: 'vSOL', provider: 'The Vault' },
          { mint: 'LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp', name: 'lstSOL', provider: 'Sanctum Infinity' },
          { mint: 'Comp4ssDzXcLeu2MnLuGNNFC4cmLPMng8qWHPvzAMU1h', name: 'compassSOL', provider: 'Compass' },
          { mint: 'inf5RhVRucEPaQTCE24a9EkwMHiajbGFRMGjgwrsCWK', name: 'infSOL', provider: 'Sanctum' },
        ];

        // Fetch exchange rates from Jupiter for each LST
        const mintIds = LST_INFO.map(l => l.mint).join(',');
        const priceResponse = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mintIds}`);
        const priceData = await priceResponse.json() as Record<string, { usdPrice?: number }>;

        const yields: LstYield[] = LST_INFO.map(lst => {
          const apy = sanctumApys[lst.mint] ?? null;
          const lstPrice = priceData[lst.mint]?.usdPrice ?? 0;
          const exchangeRate = solPrice > 0 ? lstPrice / solPrice : 0;

          return {
            mint: lst.mint,
            name: lst.name,
            provider: lst.provider,
            apy: apy !== null ? Number((apy * 100).toFixed(2)) : null,
            exchangeRate: Number(exchangeRate.toFixed(6)),
            priceUSD: lstPrice,
            solPrice,
          };
        }).sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));

        const comparison: LstYieldComparison = {
          yields,
          solPriceUSD: solPrice,
          bestYield: yields.find(y => y.apy !== null) ?? null,
          timestamp: new Date().toISOString(),
        };

        await cache.set(cacheKey, comparison, 300); // 5 min cache

        return reply.send({ success: true, payment: request.payment, data: comparison });
      } catch (error) {
        app.log.error({ error }, 'LST yields failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch LST yields',
        });
      }
    },
  );
}

// ── Types ──

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan?: Array<{
    swapInfo: {
      ammKey: string;
      label?: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  timestamp: string;
}

interface DasAssetItem {
  id: string;
  content?: {
    metadata?: { name?: string; symbol?: string };
  };
  token_info?: {
    balance?: number;
    decimals?: number;
    price_info?: { price_per_token?: number };
  };
}

interface LstPosition {
  mint: string;
  name: string;
  amount: number;
  valueUSD: number;
  pricePerToken: number;
}

interface LpPosition {
  mint: string;
  name: string;
  amount: number;
  valueUSD: number;
  protocol: string;
}

interface GenericPosition {
  mint: string;
  name: string;
  amount: number;
  valueUSD: number;
}

interface DefiPositions {
  address: string;
  lst: { positions: LstPosition[]; totalValueUSD: number };
  lp: { positions: LpPosition[]; totalValueUSD: number };
  lending: { positions: GenericPosition[]; totalValueUSD: number };
  other: { positions: GenericPosition[]; totalValueUSD: number };
  totalDefiValueUSD: number;
  timestamp: string;
}

interface LstYield {
  mint: string;
  name: string;
  provider: string;
  apy: number | null;
  exchangeRate: number;
  priceUSD: number;
  solPrice: number;
}

interface LstYieldComparison {
  yields: LstYield[];
  solPriceUSD: number;
  bestYield: LstYield | null;
  timestamp: string;
}
