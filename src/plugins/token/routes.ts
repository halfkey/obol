import type { FastifyInstance } from 'fastify';
import { validateMintAddress } from '../../middleware/validation.js';
import { config } from '../../config/env.js';
import { cache } from '../../services/cache.js';


/**
 * Token data plugin — all /api/v1/token/* routes
 *
 * Endpoints:
 *   GET /api/v1/token/:mint/price     ($0.005)
 *   GET /api/v1/token/:mint/metadata  ($0.01)
 */
export async function tokenPlugin(app: FastifyInstance): Promise<void> {
  const rateConfig = {
    config: {
      rateLimit: {
        max: config.security.rateLimitMaxRequests,
        timeWindow: config.security.rateLimitWindowMs,
      },
    },
  };

  // ── Price ──
  app.get(
    '/api/v1/token/:mint/price',
    { preHandler: validateMintAddress, ...rateConfig },
    async (request, reply) => {
      const { mint } = request.params as { mint: string };

      try {
        const cacheKey = `token-price:${mint}`;
        const cached = await cache.get<TokenPrice>(cacheKey);
        if (cached !== null) {
          return reply.send({ success: true, mint, payment: request.payment, data: cached });
        }

        const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
        const data = await response.json() as Record<string, JupiterPriceV3>;
        const info = data[mint];

        if (!info?.usdPrice) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `No price data for token: ${mint}`,
          });
        }

        const price: TokenPrice = {
          mint,
          priceUSD: info.usdPrice,
          confidence: info.confidenceLevel ?? 'unknown',
          timestamp: new Date().toISOString(),
        };

        await cache.set(cacheKey, price, 60); // 1 min cache for prices

        return reply.send({ success: true, mint, payment: request.payment, data: price });
      } catch (error) {
        app.log.error({ error, mint }, 'Token price failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch token price',
        });
      }
    },
  );

  // ── Metadata ──
  app.get(
    '/api/v1/token/:mint/metadata',
    { preHandler: validateMintAddress, ...rateConfig },
    async (request, reply) => {
      const { mint } = request.params as { mint: string };

      try {
        const cacheKey = `token-meta:${mint}`;
        const cached = await cache.get<TokenMetadata>(cacheKey);
        if (cached !== null) {
          return reply.send({ success: true, mint, payment: request.payment, data: cached });
        }

        const heliusApiKey = config.solana.heliusApiKey;
        if (!heliusApiKey) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: 'Helius API not configured',
          });
        }

        const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'token-metadata',
            method: 'getAsset',
            params: { id: mint },
          }),
        });

        const result = await response.json() as { result?: HeliusAsset; error?: { message: string } };

        if (result.error || !result.result) {
          return reply.code(404).send({
            error: 'Not Found',
            message: `No metadata for token: ${mint}`,
          });
        }

        const asset = result.result;
        const metadata: TokenMetadata = {
          mint,
          name: asset.content?.metadata?.name ?? 'Unknown',
          symbol: asset.content?.metadata?.symbol ?? 'UNKNOWN',
          decimals: asset.token_info?.decimals ?? 0,
          supply: asset.token_info?.supply ? Number(asset.token_info.supply) : undefined,
          logoURI: asset.content?.links?.image || asset.content?.files?.[0]?.uri,
          description: asset.content?.metadata?.description,
        };

        await cache.set(cacheKey, metadata, 3600); // 1 hr cache for metadata

        return reply.send({ success: true, mint, payment: request.payment, data: metadata });
      } catch (error) {
        app.log.error({ error, mint }, 'Token metadata failed');
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch token metadata',
        });
      }
    },
  );
}

// ── Types ──

interface TokenPrice {
  mint: string;
  priceUSD: number;
  confidence: string;
  timestamp: string;
}

interface JupiterPriceV3 {
  usdPrice?: number;
  confidenceLevel?: string;
}

interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply?: number;
  logoURI?: string;
  description?: string;
}

interface HeliusAsset {
  content?: {
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string }>;
  };
  token_info?: {
    decimals?: number;
    supply?: string;
  };
}
