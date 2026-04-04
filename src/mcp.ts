#!/usr/bin/env node
/**
 * Obol MCP Server
 *
 * Exposes Obol's Solana data endpoints as MCP tools that any
 * AI agent can discover and call. Runs over stdio transport.
 *
 * The MCP server proxies requests to either:
 *   - A live Obol instance (default: production)
 *   - A local dev instance
 *
 * In MCP mode, the server operates in "proxy" payment mode:
 *   - If OBOL_URL points to a mock-mode instance, data is free
 *   - If OBOL_URL points to an onchain instance, the MCP server
 *     can optionally include a payment signature via AGENT_PRIVATE_KEY
 *
 * Usage:
 *   npx tsx src/mcp.ts                              # stdio transport
 *   OBOL_URL=http://localhost:3000 npx tsx src/mcp.ts  # local dev
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "obol": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/obol/src/mcp.ts"],
 *         "env": {
 *           "OBOL_URL": "https://obol-production.up.railway.app"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const OBOL_URL = process.env.OBOL_URL ?? 'https://obol-production.up.railway.app';

// ── Helpers ──

async function obolFetch(path: string, options?: { method?: string; body?: unknown }): Promise<{ status: number; data: unknown }> {
  const url = `${OBOL_URL}${path}`;

  // For MCP, we call the API without payment headers.
  // If the server is in mock mode, it returns data.
  // If in onchain mode, it returns 402 with pricing info.
  const res = await fetch(url, {
    method: options?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

function formatResult(result: { status: number; data: unknown }): string {
  if (result.status === 402) {
    return JSON.stringify({
      error: 'Payment required',
      message: 'This endpoint requires USDC payment via x402. The Obol instance is running in onchain mode.',
      paymentInfo: result.data,
    }, null, 2);
  }
  return JSON.stringify(result.data, null, 2);
}

// ── Server ──

const server = new McpServer({
  name: 'obol',
  version: '2.0.0',
});

// ── Wallet Tools ──

server.tool(
  'obol_wallet_overview',
  'Get a Solana wallet overview — SOL balance, token count, total value. Costs $0.01 USDC.',
  { address: z.string().describe('Solana wallet address') },
  async ({ address }) => {
    const result = await obolFetch(`/api/v1/wallet/${address}/overview`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_wallet_portfolio',
  'Get full wallet portfolio — all token holdings with prices, NFTs, and breakdown. Costs $0.05 USDC.',
  { address: z.string().describe('Solana wallet address') },
  async ({ address }) => {
    const result = await obolFetch(`/api/v1/wallet/${address}/portfolio`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_wallet_activity',
  'Get wallet transaction history with categorization (swaps, transfers, etc). Costs $0.05 USDC.',
  { address: z.string().describe('Solana wallet address') },
  async ({ address }) => {
    const result = await obolFetch(`/api/v1/wallet/${address}/activity`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_wallet_risk',
  'Multi-factor risk assessment for a Solana wallet — age, diversification, activity patterns. Costs $0.10 USDC.',
  { address: z.string().describe('Solana wallet address') },
  async ({ address }) => {
    const result = await obolFetch(`/api/v1/wallet/${address}/risk`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_wallet_pnl',
  'Wallet P&L analysis — token flows, current values, transaction history analysis. Costs $0.15 USDC.',
  { address: z.string().describe('Solana wallet address') },
  async ({ address }) => {
    const result = await obolFetch(`/api/v1/wallet/${address}/pnl`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

// ── Token Tools ──

server.tool(
  'obol_token_price',
  'Get real-time token price via Jupiter. Costs $0.005 USDC.',
  { mint: z.string().describe('Token mint address (e.g., USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)') },
  async ({ mint }) => {
    const result = await obolFetch(`/api/v1/token/${mint}/price`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_token_metadata',
  'Get token metadata — name, symbol, supply, decimals. Costs $0.01 USDC.',
  { mint: z.string().describe('Token mint address') },
  async ({ mint }) => {
    const result = await obolFetch(`/api/v1/token/${mint}/metadata`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

// ── DeFi Tools ──

server.tool(
  'obol_swap_quote',
  'Get a Jupiter swap quote with route planning and price impact. Costs $0.005 USDC.',
  {
    inputMint: z.string().describe('Input token mint address (e.g., SOL: So11111111111111111111111111111111111111112)'),
    outputMint: z.string().describe('Output token mint address'),
    amount: z.string().describe('Amount in atomic units (e.g., 1000000000 for 1 SOL)'),
    slippageBps: z.string().optional().describe('Slippage tolerance in basis points (default: 50 = 0.5%)'),
  },
  async ({ inputMint, outputMint, amount, slippageBps }) => {
    const params = new URLSearchParams({ inputMint, outputMint, amount });
    if (slippageBps) params.set('slippageBps', slippageBps);
    const result = await obolFetch(`/api/v1/defi/swap/quote?${params}`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_swap_execute',
  'Build a Jupiter swap transaction for signing. Returns a serialized transaction the agent must sign and submit. Costs $0.25 USDC.',
  {
    inputMint: z.string().describe('Input token mint address'),
    outputMint: z.string().describe('Output token mint address'),
    amount: z.string().describe('Amount in atomic units'),
    userPublicKey: z.string().describe('The wallet public key that will sign and submit the transaction'),
    slippageBps: z.string().optional().describe('Slippage in basis points (default: 50)'),
    priorityFee: z.string().optional().describe('Priority fee in lamports (default: auto)'),
  },
  async ({ inputMint, outputMint, amount, userPublicKey, slippageBps, priorityFee }) => {
    const result = await obolFetch('/api/v1/defi/swap/execute', {
      method: 'POST',
      body: { inputMint, outputMint, amount, userPublicKey, slippageBps, priorityFee },
    });
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_defi_positions',
  'Get DeFi positions for a wallet — LSTs, LP tokens, lending positions, categorized by protocol. Costs $0.10 USDC.',
  { address: z.string().describe('Solana wallet address') },
  async ({ address }) => {
    const result = await obolFetch(`/api/v1/defi/positions/${address}`);
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_lst_yields',
  'Compare LST yields across Solana — jitoSOL, mSOL, bSOL, jupSOL, hSOL, and more. APYs from Sanctum, exchange rates from Jupiter. Costs $0.02 USDC.',
  {},
  async () => {
    const result = await obolFetch('/api/v1/defi/lst/yields');
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

// ── Free Tools ──

server.tool(
  'obol_health',
  'Check Obol API health and status. Free.',
  {},
  async () => {
    const result = await obolFetch('/health');
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

server.tool(
  'obol_info',
  'Get Obol API info — all available endpoints, pricing, and payment mode. Free.',
  {},
  async () => {
    const result = await obolFetch('/');
    return { content: [{ type: 'text', text: formatResult(result) }] };
  },
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Obol MCP server error:', err);
  process.exit(1);
});
