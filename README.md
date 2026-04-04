# obol

Pay the ferryman. Solana agent gateway via x402.

Obol is a pay-per-use Solana API for AI agents. No API keys, no subscriptions — agents pay per request in USDC using the [x402 payment protocol](https://x402.org). Solana's sub-cent transaction costs make micropayments viable for the first time.

Named after the coin placed on the tongue of the dead to pay Charon for passage across the River Styx. The original micropayment.

## How it works

1. Agent requests data from a paid endpoint
2. Obol returns HTTP 402 with a payment requirement (amount, recipient, network)
3. Agent sends USDC on Solana matching the requirement
4. Agent retries with transaction proof in the `X-PAYMENT` header
5. Obol verifies on-chain and returns the data

No accounts. No tokens. No onboarding. Just pay and go.

## Endpoints

### Wallet Analytics
| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/v1/wallet/:addr/overview` | $0.01 | SOL balance, token count, total value |
| `GET /api/v1/wallet/:addr/portfolio` | $0.05 | Full holdings with prices, NFTs, breakdown |
| `GET /api/v1/wallet/:addr/activity` | $0.05 | Transaction history with categorization |
| `GET /api/v1/wallet/:addr/risk` | $0.10 | Multi-factor risk assessment |
| `GET /api/v1/wallet/:addr/pnl` | $0.15 | Token flow analysis, current values, P&L |

### Token Data
| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/v1/token/:mint/price` | $0.005 | Real-time price via Jupiter |
| `GET /api/v1/token/:mint/metadata` | $0.01 | Name, symbol, supply, decimals |

### DeFi
| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/v1/defi/swap/quote` | $0.005 | Jupiter swap quote with route planning |
| `POST /api/v1/defi/swap/execute` | $0.25 | Jupiter swap transaction builder |
| `GET /api/v1/defi/positions/:addr` | $0.10 | DeFi positions — LSTs, LPs, lending |
| `GET /api/v1/defi/lst/yields` | $0.02 | LST yield comparison across Solana |

### Free
| Endpoint | Description |
|----------|-------------|
| `GET /` | API info and pricing |
| `GET /health` | Service status |
| `POST /api/v1/rpc` | Proxied Helius RPC (allowlisted methods) |

## Agent Example

See `examples/agent-client.ts` for a full reference implementation. The key flow:

```typescript
import { ObolAgent } from './examples/agent-client';

const agent = new ObolAgent();
await agent.discover();  // fetch pricing
agent.loadWallet(process.env.AGENT_PRIVATE_KEY);

// Auto-discovers price, pays, and returns data
const price = await agent.fetch('/api/v1/token/USDC_MINT/price');
```

Run in discovery-only mode (no wallet needed):
```bash
npx tsx examples/agent-client.ts
```

## Stack

- **Fastify 5** — high-performance HTTP
- **@x402/svm** — official x402 SDK for Solana
- **Helius** — RPC + DAS API
- **Jupiter** — token prices + swap execution
- **Upstash Redis** — cache + payment receipts
- **TypeScript** — full type safety
- **Zod** — runtime validation

## Setup

```bash
git clone https://github.com/halfkey/obol.git
cd obol
npm install
cp .env.example .env
# Edit .env with your Helius key and merchant wallet address
npm run dev
```

## Testing

```bash
# Unit + integration tests (46 tests)
npm test -- --run

# Smoke test against live deployment
npx tsx scripts/smoke-test.ts https://obol-production.up.railway.app

# Manual payment test
npx tsx scripts/test-payment.ts <tx-signature>
```

## Environment

See `.env.example`. Key variables:

- `PAYMENT_MODE` — `mock` (dev, auto-approve) or `onchain` (production)
- `PAYMENT_RECIPIENT_ADDRESS` — your Solana wallet that receives USDC
- `HELIUS_API_KEY` — Helius RPC access
- `UPSTASH_REDIS_REST_URL` / `TOKEN` — cache layer

## Roadmap

- [x] 11 paid endpoints (wallet, token, DeFi, LST, P&L)
- [x] On-chain USDC verification with replay prevention
- [x] Test suite (46 vitest + 20-point smoke test)
- [x] Agent client reference implementation
- [x] GitHub Actions CI
- [ ] WebSocket subscriptions for wallet monitoring
- [ ] Dynamic congestion-based pricing
- [ ] Multi-chain support

## License

MIT
