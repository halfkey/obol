import { Redis } from '@upstash/redis';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Upstash Redis cache — handles response caching and payment receipt storage */
class CacheService {
  private client: Redis | null = null;
  private connected = false;

  async connect(): Promise<void> {
    if (!config.redis.restUrl || !config.redis.restToken) {
      logger.warn('Redis not configured — running without cache');
      return;
    }

    try {
      this.client = new Redis({
        url: config.redis.restUrl,
        token: config.redis.restToken,
      });

      const result = await this.client.ping();
      if (result === 'PONG') {
        this.connected = true;
        logger.info('Redis connected');
      }
    } catch (error) {
      logger.error({ error }, 'Redis connection failed');
      this.client = null;
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.connected = false;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client || !this.connected) return null;
    try {
      return await this.client.get<T>(key);
    } catch (error) {
      logger.error({ error, key }, 'Cache get error');
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.connected) return;
    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
    } catch (error) {
      logger.error({ error, key }, 'Cache set error');
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client || !this.connected) return false;
    try {
      return (await this.client.exists(key)) === 1;
    } catch {
      return false;
    }
  }

  /** Record a payment receipt (for analytics and replay prevention) */
  async recordPayment(memo: string, receipt: PaymentReceipt): Promise<void> {
    await this.set(`payment:${memo}`, receipt, 86400); // 24h TTL
  }

  /** Check if a payment memo has already been used (replay prevention) */
  async isPaymentUsed(memo: string): Promise<boolean> {
    return this.exists(`payment:${memo}`);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

export interface PaymentReceipt {
  txSignature: string;
  fromAddress: string;
  amount: number;
  endpoint: string;
  timestamp: string;
}

export const cache = new CacheService();
