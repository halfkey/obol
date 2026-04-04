/** Endpoint pricing configuration for x402 payment gates */

export interface EndpointPrice {
  priceUSDC: number;
  description: string;
}

/** Registry of all paid endpoints and their prices */
export const endpointPricing: Record<string, EndpointPrice> = {
  // Phase 1: Core
  '/api/v1/wallet/:address/overview': {
    priceUSDC: 0.01,
    description: 'Wallet overview — SOL balance, token count, total value',
  },
  '/api/v1/wallet/:address/portfolio': {
    priceUSDC: 0.05,
    description: 'Full portfolio — tokens with prices, NFTs, breakdown',
  },
  '/api/v1/wallet/:address/activity': {
    priceUSDC: 0.05,
    description: 'Transaction history with categorization',
  },
  '/api/v1/wallet/:address/risk': {
    priceUSDC: 0.10,
    description: 'Multi-factor risk assessment',
  },
  '/api/v1/token/:mint/price': {
    priceUSDC: 0.005,
    description: 'Real-time token price via Jupiter',
  },
  '/api/v1/token/:mint/metadata': {
    priceUSDC: 0.01,
    description: 'Token name, symbol, supply, holder count',
  },
};

/** Paths that never require payment */
const FREE_PATHS = new Set(['/', '/health', '/api/v1/rpc']);

/** Normalize a real URL path to its route pattern */
function normalizeToRoute(path: string): string {
  // Strip query string
  const cleanPath = path.split('?')[0] ?? path;

  // /api/v1/wallet/<address>/overview → /api/v1/wallet/:address/overview
  const walletMatch = cleanPath.match(/^\/api\/v1\/wallet\/[^/]+\/(overview|portfolio|activity|risk)$/);
  if (walletMatch) {
    return `/api/v1/wallet/:address/${walletMatch[1]}`;
  }

  // /api/v1/token/<mint>/price → /api/v1/token/:mint/price
  const tokenMatch = cleanPath.match(/^\/api\/v1\/token\/[^/]+\/(price|metadata)$/);
  if (tokenMatch) {
    return `/api/v1/token/:mint/${tokenMatch[1]}`;
  }

  return cleanPath;
}

/** Get price for an endpoint in USDC. Throws if no pricing exists. */
export function getEndpointPrice(path: string): number {
  const route = normalizeToRoute(path);
  const pricing = endpointPricing[route];
  if (!pricing) {
    throw new Error(`No pricing configured for: ${path}`);
  }
  return pricing.priceUSDC;
}

/** Check if an endpoint requires payment */
export function requiresPayment(path: string): boolean {
  const cleanPath = path.split('?')[0] ?? path;
  if (FREE_PATHS.has(cleanPath)) return false;
  if (!cleanPath.startsWith('/api/')) return false;

  try {
    getEndpointPrice(path);
    return true;
  } catch {
    return false;
  }
}
