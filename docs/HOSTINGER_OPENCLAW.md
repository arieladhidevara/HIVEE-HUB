# Hostinger / one-click OpenClaw note

This note exists because some deployments look healthy in a browser but still fail from the connector.

## The pattern

A common failure pattern looks like this:

- the public OpenClaw page loads
- `/v1/models` may appear to work on one surface
- chat from another container fails
- the connector sees HTML or `connection refused`

This usually means the connector is not reaching the same local gateway surface that OpenClaw itself is using internally.

## Why this happens

In some one-click deployments, OpenClaw can expose a public-facing UI surface while the raw local gateway remains effectively loopback-only from the perspective of peer containers.

That means:
- inside the OpenClaw container, `127.0.0.1:18789` may work
- from a sibling container, `openclaw:18789` may still fail

## Practical workaround

Expose an internal bridge port that forwards to the real local gateway.

Example idea:
- internal OpenClaw gateway: `127.0.0.1:18789`
- bridge exposed to sibling containers: `0.0.0.0:18790`

Then point the connector to the bridge instead of the loopback-only port.

## Example connector env

```env
OPENCLAW_BASE_URL=http://openclaw:18790
OPENCLAW_DISCOVERY_CANDIDATES=http://openclaw:18790,http://openclaw-izjk-openclaw-1:18790
OPENCLAW_TOKEN=YOUR_GATEWAY_TOKEN
OPENCLAW_TRANSPORT=http
```

## Recommended verification order

1. From inside the connector container, test:

```bash
curl -i http://openclaw:18790/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN"
```

2. Then test chat:

```bash
curl -i http://openclaw:18790/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"ping"}]}'
```

3. Only after those succeed should you trust the admin UI discovery result.

## Important warning

Do not confuse:
- the public OpenClaw UI port
- the raw local OpenAI-compatible gateway port
- the bridge port used by sibling containers

Those can be different, and mixing them is one of the fastest ways to end up with HTML instead of JSON.
