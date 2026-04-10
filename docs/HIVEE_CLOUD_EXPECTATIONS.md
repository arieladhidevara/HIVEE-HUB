# Hivee Cloud expectations

This document defines what Hivee Cloud is expected to provide to the connector.

The goal is clarity, not bureaucracy.

## Connector lifecycle

At a minimum, Hivee Cloud should support:

1. connector registration
2. heartbeat ingestion
3. command polling or command delivery
4. command result submission
5. connector status inspection

## Minimum data Hivee Cloud should know about a connector

A connector record should include fields like:
- connector id
- display name
- environment or workspace id
- last heartbeat time
- local OpenClaw status summary
- discovered models and agents summary
- software version
- tags or labels useful for operations

## Minimum command contract

Hivee Cloud should be able to send these commands to the connector:
- `connector.ping`
- `openclaw.discover`
- `openclaw.list_agents`
- `openclaw.chat`
- `openclaw.proxy_http`

## Why `openclaw.proxy_http` matters

This command is especially useful for debugging because it lets operators test endpoints like `/v1/models` without SSHing into the VPS every time.

That is not product fluff. It is operationally valuable.

## Result contract

Command results should be structured enough to debug real failures.

At minimum, results should preserve:
- `ok`
- command type
- transport used
- status code if available
- error message if available
- response payload if safe

## What Hivee Cloud should not assume

Hivee Cloud should not assume:
- public OpenClaw exposure exists
- WebSocket is always the healthiest transport
- a public browser-success means the local connector path is healthy

## Recommended UX principle

If the connector can prove `/v1/models` returns JSON locally, Hivee Cloud should show that as a strong signal of health.

If the connector receives HTML instead of JSON, Hivee Cloud should surface that clearly instead of hiding it behind a vague generic failure.
