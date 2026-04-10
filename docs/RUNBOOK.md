# RUNBOOK

This runbook is for operators who want the shortest path from "it does not connect" to "it works".

## 1. Start from the connector, not from the public URL

When debugging Hivee Connector, always verify the local OpenClaw path that the connector itself can reach.

Do not start from the public browser URL first.

Why:
- the public OpenClaw page may be a control UI surface
- the connector needs machine-readable JSON endpoints
- a public UI page can look healthy while the connector still cannot talk to the real local gateway

## 2. Preferred first test

Use HTTP first.

```json
{
  "method": "GET",
  "path": "/v1/models"
}
```

Expected result:
- `200` + JSON = the local HTTP path is alive
- `401` + JSON = the path is alive but token is wrong
- `200` + HTML = wrong surface, likely UI instead of API
- `connection refused` = host or port is wrong from the connector network's point of view

## 3. Then test chat

Once `/v1/models` works, test chat.

Example payload:

```json
{
  "message": "hello from connector admin",
  "agentId": "openclaw/main"
}
```

If your deployment exposes `openclaw/default`, that can also work, but `openclaw/main` is often easier to reason about during setup.

## 4. Recommended starting env

```env
OPENCLAW_TRANSPORT=http
OPENCLAW_REQUEST_TIMEOUT_MS=20000
```

Use `http` first. Do not start by assuming WebSocket is the most stable path.

## 5. Fast diagnosis table

### Case A — HTML instead of JSON
Cause:
- you are probably talking to the wrong HTTP surface

Fix:
- verify `OPENCLAW_BASE_URL`
- test `/v1/models`
- confirm the response `Content-Type` is `application/json`

### Case B — Unauthorized
Cause:
- token mismatch

Fix:
- verify `OPENCLAW_TOKEN`
- verify you are sending `Authorization: Bearer <token>`

### Case C — Connection refused
Cause:
- hostname resolves, but nothing is listening on that port for the connector

Fix:
- verify container network wiring
- verify the listener is exposed to peer containers
- verify you are not accidentally targeting a loopback-only service from another container

## 6. Hostinger / one-click OpenClaw warning

Some one-click OpenClaw deployments can behave like this:
- OpenClaw works inside its own container
- a public UI is reachable
- the raw gateway still behaves like a loopback-only service from another container

In that case, a practical workaround is to expose an internal bridge port, for example `18790`, that forwards traffic to `127.0.0.1:18789` inside the OpenClaw network namespace.

See [`HOSTINGER_OPENCLAW.md`](HOSTINGER_OPENCLAW.md) for the detailed note.

## 7. Minimal success checklist

You are done when all of these are true:
- connector can reach `/v1/models`
- connector can reach `/v1/chat/completions`
- `openclaw.discover` shows a healthy local target
- `openclaw.chat` returns JSON, not HTML
