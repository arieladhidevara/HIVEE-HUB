# Hivee Connector

Hivee Connector is a small edge bridge that runs next to a local OpenClaw runtime.

It exists so Hivee Cloud can talk to OpenClaw without forcing users to expose OpenClaw directly to the public internet.

The connector is responsible for:
- discovering a local OpenClaw runtime
- tracking locally available agents and models
- sending heartbeats to Hivee Cloud
- polling commands from Hivee Cloud
- executing those commands against local OpenClaw
- exposing a lightweight local admin UI for diagnostics

## Quick start

### Local

```bash
npm install
cp .env.example .env
npm run dev
```

Then open:

```text
http://127.0.0.1:43137
```

### Docker

```bash
docker compose up --build -d
```

## Important environment variables

These are the most important values to understand before debugging local OpenClaw connectivity:

- `OPENCLAW_BASE_URL`
- `OPENCLAW_DISCOVERY_CANDIDATES`
- `OPENCLAW_TOKEN`
- `OPENCLAW_TRANSPORT`
- `OPENCLAW_REQUEST_TIMEOUT_MS`

For many deployments, `OPENCLAW_TRANSPORT=http` is the most stable starting point.

## Common commands

The connector supports these command types:

- `connector.ping`
- `openclaw.discover`
- `openclaw.list_agents`
- `openclaw.chat`
- `openclaw.proxy_http`

## Troubleshooting

If local discovery fails, do not guess. Test the local OpenClaw HTTP surface directly.

Start with:

```json
{
  "method": "GET",
  "path": "/v1/models"
}
```

If you get HTML instead of JSON, your base URL is pointing at the wrong surface.

If you get `401 Unauthorized`, your token is wrong or missing.

If you get `connection refused`, your connector can resolve the hostname but nothing is listening on that port from the connector's point of view.

## Documentation

- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — practical setup and debugging steps
- [`docs/HOSTINGER_OPENCLAW.md`](docs/HOSTINGER_OPENCLAW.md) — Hostinger / one-click OpenClaw note
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and communication model
- [`docs/HIVEE_CLOUD_EXPECTATIONS.md`](docs/HIVEE_CLOUD_EXPECTATIONS.md) — what Hivee Cloud is expected to provide

## Notes

This repo is the connector only.

It is intentionally separate from Hivee Cloud itself.
