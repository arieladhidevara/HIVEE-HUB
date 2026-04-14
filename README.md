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

### First-time user (clone and run)

```bash
git clone https://github.com/arieladhidevara/HIVEE-HUB.git
cd HIVEE-HUB
docker compose up -d --build
```

Then open:

```text
http://127.0.0.1:43137
```

On a VPS, open `http://<your-server-ip>:43137`.

After the UI opens:

1. Fill your `Hivee Token` and `OpenClaw Token`.
2. Hivee Cloud URL is fixed internally to `https://hivee.cloud` (user does not need to enter URL).
3. The connector auto-scans Docker for OpenClaw candidates on startup and in the discovery loop.
4. If needed, click `Discover` to force a fresh Docker scan.

### VPS access (Hostinger / cloud firewall)

If browser shows timeout when opening `http://<server-ip>:43137`, the service is usually running but blocked by network firewall.

Verify on VPS:

```bash
docker compose ps
curl -m 5 http://127.0.0.1:43137/health
sudo ss -lntp | grep 43137
```

If local health works, allow inbound TCP `43137` in your VPS provider firewall/security rules.

If you use UFW:

```bash
sudo ufw allow 43137/tcp
sudo ufw reload
sudo ufw status
```

### Reverse proxy option (Traefik on 80/443)

If your VPS only exposes `80/443`, put Hivee Connector behind Traefik.

Create `docker-compose.traefik.yml`:

```yaml
services:
  hivee-connector:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.hivee.rule=Host(`hivee.your-domain.com`)"
      - "traefik.http.routers.hivee.entrypoints=websecure"
      - "traefik.http.routers.hivee.tls=true"
      - "traefik.http.services.hivee.loadbalancer.server.port=43137"
    networks:
      - default
      - traefik_proxy

networks:
  traefik_proxy:
    external: true
    name: traefik_default
```

Run with:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

Notes:

- Replace `hivee.your-domain.com` with your domain.
- Your external Traefik network name may differ; check with `docker network ls`.

### Local

```bash
npm install
npm run dev
```

Then open:

```text
http://127.0.0.1:43137
```

Optional:

```bash
cp .env.example .env
```

You only need `.env` if you want to pre-seed defaults before opening the admin UI.

Runtime values submitted from the admin UI are also persisted to `data/runtime.env` (`PAIRING_TOKEN`, `OPENCLAW_BASE_URL`, `OPENCLAW_TOKEN`), so clearing browser cache/cookies will not reset them.

### Docker

```bash
docker compose up --build -d
```

Then open:

```text
http://127.0.0.1:43137
```

On a VPS, open `http://<your-server-ip>:43137`.

By default, Docker discovery is enabled and `docker.sock` is mounted read-only in `docker-compose.yml`.

## Important environment variables

These are the most important values to understand before debugging local OpenClaw connectivity:

- `OPENCLAW_BASE_URL`
- `OPENCLAW_DISCOVERY_CANDIDATES`
- `OPENCLAW_TOKEN`
- `OPENCLAW_TRANSPORT`
- `OPENCLAW_REQUEST_TIMEOUT_MS`
- `ENABLE_DOCKER_DISCOVERY`
- `DOCKER_SOCKET_PATH`

For many deployments, `OPENCLAW_TRANSPORT=http` is the most stable starting point.
Set `OPENCLAW_REQUEST_TIMEOUT_MS=0` to disable request timeouts entirely.

## Docker-assisted discovery

With the default `docker-compose.yml` settings, the connector automatically:

- scan running Docker containers for likely OpenClaw targets
- build candidate base URLs from detected container hostnames and ports
- probe model endpoints and keep only healthy JSON candidates
- auto-apply the best healthy candidate and run OpenClaw discovery

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
