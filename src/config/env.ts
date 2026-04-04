import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Solana
  SOLANA_NETWORK: z.enum(['mainnet-beta', 'devnet']).default('mainnet-beta'),
  HELIUS_API_KEY: z.string().min(1).optional(),

  // x402 Payments
  PAYMENT_MODE: z.enum(['mock', 'onchain']).default('mock'),
  PAYMENT_RECIPIENT_ADDRESS: z.string().min(32).max(64).optional(),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Security
  CORS_ORIGINS: z.string().optional().transform(val => val ? val.split(',').map(s => s.trim()) : ['*']),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;

export const config = {
  server: {
    port: env.PORT,
    host: env.HOST,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  },
  solana: {
    network: env.SOLANA_NETWORK,
    heliusApiKey: env.HELIUS_API_KEY ?? '',
    rpcUrl: env.HELIUS_API_KEY
      ? `https://${env.SOLANA_NETWORK === 'mainnet-beta' ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
      : undefined,
  },
  payment: {
    mode: env.PAYMENT_MODE,
    recipientAddress: env.PAYMENT_RECIPIENT_ADDRESS ?? '',
  },
  redis: {
    restUrl: env.UPSTASH_REDIS_REST_URL,
    restToken: env.UPSTASH_REDIS_REST_TOKEN,
  },
  security: {
    corsOrigins: env.CORS_ORIGINS,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
  },
  logging: {
    level: env.LOG_LEVEL,
  },
} as const;

export type Config = typeof config;
