# ARCHITECTURE

Hivee Connector is the local bridge between Hivee Cloud and a private OpenClaw runtime.

## High-level model

```text
User Browser
   |
   v
Hivee Cloud
   |
   | heartbeats / commands / results
   v
Hivee Connector
   |
   | local HTTP and optional local WebSocket
   v
OpenClaw
```

## Design goal

The connector exists so Hivee Cloud does not need direct public access to OpenClaw.

That gives a cleaner user experience:
- less VPS setup confusion
- fewer reverse-proxy and WSS problems
- less accidental exposure of local OpenClaw surfaces

## What belongs in this repo

This connector should:
- discover a local OpenClaw runtime
- remember local pairing state
- inspect local agents and models
- poll commands from Hivee Cloud
- execute those commands locally
- return results back to Hivee Cloud
- expose a small admin UI for diagnostics

## What does not belong here

This repo should not become the full Hivee product.

These belong to Hivee Cloud or another backend:
- user authentication
- organizations and workspaces
- billing and usage
- command queue persistence
- long-term product frontend
- approvals and end-user workflow UI

## Transport model

For an MVP, the simplest stable split is:

- Hivee Cloud to Connector: HTTP polling and result submission
- Connector to OpenClaw: local HTTP first, optional local WebSocket second

Why this is a good default:
- easier to debug
- safer than telling users to expose OpenClaw directly
- works well for many VPS setups

## Why local HTTP matters so much

In practice, local HTTP is often the fastest path to clarity.

When something is wrong, `/v1/models` tells you whether the connector is actually seeing a machine-readable OpenClaw surface or just a UI page.

That makes HTTP a better first diagnostic path than guessing WebSocket details.

## Admin UI role

The local admin UI should stay small and practical.

Its purpose is to:
- inspect discovery state
- test commands manually
- confirm token, base URL, and transport settings
- help debug the local bridge

It is not the final user-facing product.
