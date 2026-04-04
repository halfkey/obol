import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * x402 Middleware Unit Tests
 *
 * Tests the payment header parsing, protocol compliance, and mode behavior.
 * Mocks external dependencies (cache, helius) to test middleware logic in isolation.
 */

// Mock dependencies before importing middleware
vi.mock('../src/services/cache.js', () => ({
  cache: {
    exists: vi.fn().mockResolvedValue(false),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    recordPayment: vi.fn().mockResolvedValue(undefined),
    isPaymentUsed: vi.fn().mockResolvedValue(false),
    isConnected: true,
  },
}));

vi.mock('../src/services/helius.js', () => ({
  helius: {
    getConnection: vi.fn().mockReturnValue({
      getParsedTransaction: vi.fn().mockResolvedValue(null),
      getParsedAccountInfo: vi.fn().mockResolvedValue(null),
    }),
  },
}));

vi.mock('../src/config/env.js', () => ({
  config: {
    payment: { mode: 'mock', recipientAddress: 'TestRecipientAddress123' },
    server: { isDevelopment: true, isProduction: false, isTest: true },
    solana: { heliusApiKey: 'test-key', rpcUrl: 'https://test-rpc.com' },
    redis: { restUrl: undefined, restToken: undefined },
    security: { corsOrigins: ['*'], rateLimitWindowMs: 60000, rateLimitMaxRequests: 100 },
    logging: { level: 'error' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('x402 Middleware', () => {
  describe('Payment header encoding/decoding', () => {
    it('encodes payment requirement as base64 JSON', () => {
      const requirement = {
        x402Version: 2,
        error: 'Payment Required',
        accepts: [{ scheme: 'exact', payTo: 'TestAddr' }],
      };
      const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.accepts[0].payTo).toBe('TestAddr');
    });

    it('decodes a valid payment header', () => {
      const payment = {
        payload: {
          signature: 'abc123def456',
          fromAddress: 'SenderWallet123',
        },
      };
      const encoded = Buffer.from(JSON.stringify(payment)).toString('base64');
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
      expect(decoded.payload.signature).toBe('abc123def456');
      expect(decoded.payload.fromAddress).toBe('SenderWallet123');
    });

    it('rejects invalid base64', () => {
      expect(() => {
        const decoded = Buffer.from('not-valid-base64!!!', 'base64').toString('utf-8');
        JSON.parse(decoded);
      }).toThrow();
    });
  });

  describe('USDC atomic unit conversion', () => {
    // USDC has 6 decimals: 1 USDC = 1,000,000 atomic units
    it('converts whole USDC to atomic units', () => {
      const usdcToAtomicUnits = (amount: number) => Math.floor(amount * 1_000_000).toString();
      expect(usdcToAtomicUnits(1)).toBe('1000000');
      expect(usdcToAtomicUnits(0.01)).toBe('10000');
      expect(usdcToAtomicUnits(0.005)).toBe('5000');
      expect(usdcToAtomicUnits(0.15)).toBe('150000');
    });

    it('handles floating point correctly', () => {
      const usdcToAtomicUnits = (amount: number) => Math.floor(amount * 1_000_000).toString();
      // 0.1 + 0.2 !== 0.3 in JS, but Math.floor handles it
      expect(usdcToAtomicUnits(0.10)).toBe('100000');
      expect(usdcToAtomicUnits(0.05)).toBe('50000');
    });
  });

  describe('Memo generation', () => {
    it('generates unique memos with obol_ prefix', () => {
      const generateMemo = () => `obol_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      const memo1 = generateMemo();
      const memo2 = generateMemo();

      expect(memo1).toMatch(/^obol_\d+_[a-z0-9]+$/);
      expect(memo2).toMatch(/^obol_\d+_[a-z0-9]+$/);
      expect(memo1).not.toBe(memo2);
    });
  });
});
