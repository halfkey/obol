import { describe, it, expect } from 'vitest';
import { getEndpointPrice, requiresPayment, endpointPricing } from '../src/config/pricing.js';

describe('Pricing', () => {
  describe('getEndpointPrice', () => {
    it('returns correct price for wallet overview', () => {
      expect(getEndpointPrice('/api/v1/wallet/SomeAddress123/overview')).toBe(0.01);
    });

    it('returns correct price for wallet portfolio', () => {
      expect(getEndpointPrice('/api/v1/wallet/SomeAddress123/portfolio')).toBe(0.05);
    });

    it('returns correct price for wallet activity', () => {
      expect(getEndpointPrice('/api/v1/wallet/SomeAddress123/activity')).toBe(0.05);
    });

    it('returns correct price for wallet risk', () => {
      expect(getEndpointPrice('/api/v1/wallet/SomeAddress123/risk')).toBe(0.10);
    });

    it('returns correct price for wallet P&L', () => {
      expect(getEndpointPrice('/api/v1/wallet/SomeAddress123/pnl')).toBe(0.15);
    });

    it('returns correct price for token price', () => {
      expect(getEndpointPrice('/api/v1/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/price')).toBe(0.005);
    });

    it('returns correct price for token metadata', () => {
      expect(getEndpointPrice('/api/v1/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/metadata')).toBe(0.01);
    });

    it('returns correct price for swap quote', () => {
      expect(getEndpointPrice('/api/v1/defi/swap/quote')).toBe(0.005);
    });

    it('returns correct price for swap execute', () => {
      expect(getEndpointPrice('/api/v1/defi/swap/execute')).toBe(0.25);
    });

    it('returns correct price for DeFi positions', () => {
      expect(getEndpointPrice('/api/v1/defi/positions/SomeAddress123')).toBe(0.10);
    });

    it('returns correct price for LST yields', () => {
      expect(getEndpointPrice('/api/v1/defi/lst/yields')).toBe(0.02);
    });

    it('strips query params before lookup', () => {
      expect(getEndpointPrice('/api/v1/defi/swap/quote?inputMint=SOL&outputMint=USDC&amount=100')).toBe(0.005);
    });

    it('throws for unknown endpoints', () => {
      expect(() => getEndpointPrice('/api/v1/unknown/route')).toThrow();
    });
  });

  describe('requiresPayment', () => {
    it('returns false for root', () => {
      expect(requiresPayment('/')).toBe(false);
    });

    it('returns false for health', () => {
      expect(requiresPayment('/health')).toBe(false);
    });

    it('returns false for RPC proxy', () => {
      expect(requiresPayment('/api/v1/rpc')).toBe(false);
    });

    it('returns true for wallet overview', () => {
      expect(requiresPayment('/api/v1/wallet/SomeAddr/overview')).toBe(true);
    });

    it('returns true for token price', () => {
      expect(requiresPayment('/api/v1/token/SomeMint/price')).toBe(true);
    });

    it('returns true for swap quote', () => {
      expect(requiresPayment('/api/v1/defi/swap/quote')).toBe(true);
    });

    it('returns true for LST yields', () => {
      expect(requiresPayment('/api/v1/defi/lst/yields')).toBe(true);
    });

    it('returns true for DeFi positions', () => {
      expect(requiresPayment('/api/v1/defi/positions/SomeAddr')).toBe(true);
    });

    it('returns true for wallet P&L', () => {
      expect(requiresPayment('/api/v1/wallet/SomeAddr/pnl')).toBe(true);
    });

    it('returns false for non-api paths', () => {
      expect(requiresPayment('/random/path')).toBe(false);
    });

    it('returns false for unknown api endpoints', () => {
      expect(requiresPayment('/api/v1/something/unknown')).toBe(false);
    });
  });

  describe('endpointPricing registry', () => {
    it('has exactly 11 priced endpoints', () => {
      expect(Object.keys(endpointPricing)).toHaveLength(11);
    });

    it('all prices are positive numbers', () => {
      for (const [route, config] of Object.entries(endpointPricing)) {
        expect(config.priceUSDC, `${route} price`).toBeGreaterThan(0);
        expect(config.priceUSDC, `${route} price`).toBeLessThan(1); // sanity — no endpoint should cost $1+
      }
    });

    it('all endpoints have descriptions', () => {
      for (const [route, config] of Object.entries(endpointPricing)) {
        expect(config.description, `${route} description`).toBeTruthy();
        expect(config.description.length).toBeGreaterThan(5);
      }
    });
  });
});
