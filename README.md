# obol

Pay the ferryman. Solana agent gateway via x402.

Obol is a pay-per-use Solana API for AI agents. No API keys, no subscriptions — agents pay per request in USDC using the [x402 payment protocol](https://x402.org). Solana's sub-cent transaction costs make micropayments viable for the first time.

Named after the coin placed on the tongue of the dead to pay Charon for passage across the River Styx. The original micropayment.

## How it works

1. Agent requests data from a paid endpoint
2. Obol returns HTTP 402 with a payment requirement (amount, recipient, memo)
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

### Token Data
| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/v1/token/:mint/price` | $0.005 | Real-time price via Jupiter |
| `GET /api/v1/token/:mint/metadata` | $0.01 | Name, symbol, supply, holder count |

### Free
| Endpoint | Description |
|----------|-------------|
| `GET /` | API info and pricing |
| `GET /health` | Service status |
| `POST /api/v1/rpc` | Proxied Helius RPC (allowlisted methods) |

## Stack

- **Fastify 5** — high-performance HTTP
- **@x402/svm** — official x402 SDK for Solana
- **Helius** — RPC + DAS API
- **Jupiter** — token prices
- **Upstash Redis** — cache + payment receipts
- **TypeScript** — full type safety
- **Zod** — runtime validation

## Setup

```bash
git clone https://github.com/halfkey/obol.git
cd obol
pnpm install
cp .env.example .env
# Edit .env with your Helius key and merchant wallet address
pnpm dev
```

## Environment

See `.env.example`. Key variables:

- `PAYMENT_MODE` — `mock` (dev, auto-approve) or `onchain` (production)
- `PAYMENT_RECIPIENT_ADDRESS` — your Solana wallet that receives USDC
- `HELIUS_API_KEY` — Helius RPC access
- `UPSTASH_REDIS_REST_URL` / `TOKEN` — cache layer

## Roadmap

- [ ] Jupiter swap quotes and execution
- [ ] DeFi position aggregation
- [ ] LST yield comparison (Sanctum, Marinade, Jito)
- [ ] Wallet P&L calculation
- [ ] WebSocket subscriptions for wallet monitoring
- [ ] Dynamic congestion-based pricing

## License

MIT
