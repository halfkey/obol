import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env.js';
import { x402PaymentMiddleware } from './middleware/x402.js';
import { endpointPricing } from './config/pricing.js';
// Plugins
import { walletPlugin } from './plugins/wallet/routes.js';
import { tokenPlugin } from './plugins/token/routes.js';

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.server.isDevelopment
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    trustProxy: true,
    requestTimeout: 30000,
    connectionTimeout: 60000,
  });

  // ── Security ──
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
  });

  await app.register(cors, {
    origin: config.server.isDevelopment ? '*'
      : config.security.corsOrigins?.[0] === '*' ? '*'
      : config.security.corsOrigins || false,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false,
    max: config.security.rateLimitMaxRequests,
    timeWindow: config.security.rateLimitWindowMs,
    cache: 10000,
    allowList: ['127.0.0.1'],
    keyGenerator: (request) => request.ip || 'unknown',
  });

  // ── x402 Payment Gate (global preHandler) ──
  app.addHook('preHandler', x402PaymentMiddleware);

  // ── Free Endpoints ──

  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.server.isDevelopment ? 'development' : 'production',
    });
  });

  app.get('/', async (_request, reply) => {
    return reply.send({
      name: 'obol',
      version: '2.0.0',
      description: 'Pay the ferryman. Solana agent gateway via x402.',
      paymentMode: config.payment.mode,
      endpoints: Object.fromEntries(
        Object.entries(endpointPricing).map(([path, info]) => [
          path,
          { price: `${info.priceUSDC} USDC`, description: info.description },
        ]),
      ),
      freeEndpoints: ['GET /', 'GET /health', 'POST /api/v1/rpc'],
      protocol: 'x402',
      docs: 'https://github.com/halfkey/obol',
    });
  });

  // ── RPC Proxy (free — for transaction creation) ──
  app.post('/api/v1/rpc', async (request, reply) => {
    const body = request.body as { method?: string; params?: unknown[] };

    const allowed = ['getAccountInfo', 'getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses'];
    if (!body?.method || !allowed.includes(body.method)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `RPC method '${body?.method ?? 'undefined'}' not allowed`,
      });
    }

    if (!config.solana.rpcUrl) {
      return reply.code(503).send({ error: 'Service Unavailable', message: 'RPC not configured' });
    }

    try {
      const response = await fetch(config.solana.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: body.method,
          params: body.params ?? [],
        }),
      });
      const data = await response.json();
      return reply.send(data);
    } catch (error) {
      app.log.error({ error }, 'RPC proxy error');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'RPC proxy failed' });
    }
  });

  // ── Register Endpoint Plugins ──
  await app.register(walletPlugin);
  await app.register(tokenPlugin);

  // ── 404 ──
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({
      error: 'Not Found',
      message: 'Endpoint does not exist',
    });
  });

  // ── Error Handler ──
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      error: error.name || 'InternalServerError',
      message: config.server.isProduction ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  return app;
}
