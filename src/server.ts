import { createApp } from './app.js';
import { config } from './config/env.js';
import { cache } from './services/cache.js';
import { helius } from './services/helius.js';
import { logger } from './utils/logger.js';

async function start(): Promise<void> {
  // Initialize services
  await cache.connect();
  await helius.warmup();

  // Create and start server
  const app = await createApp();

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    logger.info({
      port: config.server.port,
      mode: config.payment.mode,
      network: config.solana.network,
    }, 'obol running');
  } catch (error) {
    logger.fatal({ error }, 'Server failed to start');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await cache.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  logger.fatal({ error }, 'Startup failed');
  process.exit(1);
});
