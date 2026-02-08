# @elizaos/plugin-x402

x402 HTTP payment protocol plugin for ElizaOS. Enables agents to send and receive crypto payments (USDC on EVM chains) using the [x402 protocol standard](https://www.x402.org/).

## Features

- **Send payments** — Pay for x402-protected HTTP resources
- **Receive payments** — Serve paywalled endpoints with automatic USDC settlement
- **Multiple storage backends** — Memory, SQLite, and PostgreSQL
- **Payment policies** — Configurable spending limits and circuit breakers
- **Facilitator integration** — Payment verification via x402 facilitator service
- **REST API** — Endpoints for payment history, summaries, and CSV export

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `X402_PRIVATE_KEY` | Wallet private key (hex, 0x-prefixed) | Yes |
| `X402_NETWORK` | Network name (e.g. `base-sepolia`, `base`) | No |
| `X402_PAY_TO` | Default payment recipient address | No |
| `X402_FACILITATOR_URL` | Facilitator service URL | No |
| `X402_MAX_PAYMENT_USD` | Max single payment (USD) | No |
| `X402_MAX_TOTAL_USD` | Max total payments (USD) | No |
| `X402_ENABLED` | Enable/disable plugin | No |

## Usage

```typescript
import { x402Plugin } from "@elizaos/plugin-x402";
```
