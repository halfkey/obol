import type { FastifyInstance } from 'fastify';
import { validateSolanaAddress } from '../../middleware/validation.js';
import { helius } from '../../services/helius.js';
import { config } from '../../config/env.js';

/**
 * Wallet analytics plugin — all /api/v1/wallet/* routes
 *
 * Endpoints:
 *   GET /api/v1/wallet/:address/overview   ($0.01)
 *   GET /api/v1/wallet/:address/portfolio  ($0.05)
 *   GET /api/v1/wallet/:address/activity   ($0.05)
 *   GET /api/v1/wallet/:address/risk       ($0.10)
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
}
