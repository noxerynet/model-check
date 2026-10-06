# Model Check

OpenAI-compatible API endpoints için model discovery, availability testing and response verification tool.

Powered by [Noxery](https://noxery.net).

## Features

- Add any OpenAI-compatible provider with base URL and API key
- Discover models via `GET /v1/models`
- Verify models with real `POST /v1/chat/completions` requests
- Model identity check (requested vs. returned model ID)
- Test suite: basic, arithmetic, instruction following, JSON, identity, streaming
- Chat with streaming, latency and token usage
- SSRF protection, rate limiting, timeouts, response size limits

## Requirements

- Node.js 20+
- npm

## Installation

```bash
git clone https://github.com/noxery/model-check.git
cd model-check
npm install
cp .env.example .env
```

## Configuration

See `.env.example`. Main variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PROVIDER_TIMEOUT_MS` | `30000` | Upstream request timeout |
| `PROVIDER_MAX_BYTES` | `2097152` | Max upstream response size |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Allow LAN/localhost providers (local testing only) |
| `ALLOWED_ORIGINS` | empty | Comma-separated CORS origins |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `60` | API rate limit |

## Running

```bash
npm run dev     # development
npm run build   # build to dist/
npm start       # run production build
```

Open `http://localhost:3000`.

## Docker

```bash
docker build -t model-check .
docker run -p 3000:3000 model-check
```

Or with compose:

```bash
docker compose up --build
```

## Environment Variables

Copy `.env.example` to `.env` and adjust. Never commit real API keys.

## API

| Method | Endpoint | Body |
| --- | --- | --- |
| `GET` | `/api/health` | — |
| `POST` | `/api/providers/test` | `{ baseUrl, apiKey, headers? }` |
| `POST` | `/api/providers/models` | `{ baseUrl, apiKey, headers? }` |
| `POST` | `/api/models/test` | `{ baseUrl, apiKey, model, tests? }` |
| `POST` | `/api/models/chat` | `{ baseUrl, apiKey, model, messages, stream? }` |

API keys are request-scoped only: forwarded to the provider, never stored or logged.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
