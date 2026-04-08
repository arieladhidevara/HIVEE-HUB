# Hivee Hub

Hivee Hub is the installable bridge that:
- Connects outbound to Hivee Cloud
- Discovers runtime agents (OpenClaw first)
- Syncs discovered agents and agent cards into Hivee Cloud
- Sends periodic hub heartbeats

## Quick Install (Ubuntu)

```bash
python3 -m pip install --upgrade "git+https://github.com/arieladhidevara/HIVEE-HUB.git"

hivee-hub connect \
  --cloud-url "https://hivee.cloud" \
  --connection-id "<connection_id>" \
  --install-token "<install_token>" \
  --runtime openclaw \
  --openclaw-base-url "<openclaw_base_url>" \
  --openclaw-api-key "<openclaw_api_key>"
```

Notes:
- The process runs continuously (daemon-style loop) until stopped.
- If OpenClaw is not reachable, Hub keeps heartbeat alive and retries discovery.

## Docker (build from HIVEE-HUB repo)

```bash
git clone https://github.com/arieladhidevara/HIVEE-HUB.git
cd HIVEE-HUB
docker build -t hivee-hub:local .

docker run -d --name hivee-hub --restart unless-stopped \
  -e HIVEE_CLOUD_URL="https://hivee.cloud" \
  -e HIVEE_CONNECTION_ID="<connection_id>" \
  -e HIVEE_INSTALL_TOKEN="<install_token>" \
  -e HIVEE_RUNTIME_TYPE="openclaw" \
  -e OPENCLAW_BASE_URL="<openclaw_base_url>" \
  -e OPENCLAW_API_KEY="<openclaw_api_key>" \
  hivee-hub:local
```

Optional fallback if runtime listing is unavailable:

```bash
-e HIVEE_RUNTIME_AGENT_IDS="planner-alpha,builder-beta"
```

## Environment Variables

Required:
- `HIVEE_CLOUD_URL`
- `HIVEE_INSTALL_TOKEN`

Recommended:
- `HIVEE_CONNECTION_ID`
- `HIVEE_RUNTIME_TYPE` (default: `openclaw`)
- `HIVEE_HUB_HEARTBEAT_SEC` (default: `30`)
- `HIVEE_HUB_DISCOVERY_SEC` (default: `60`)
- `HIVEE_HUB_LOG_LEVEL` (default: `INFO`)

OpenClaw adapter:
- `OPENCLAW_BASE_URL`
- `OPENCLAW_API_KEY`
- `OPENCLAW_INSECURE` (`1/true/yes` to disable TLS verification)

## Commands

- `hivee-hub connect ...` runs with explicit flags
- `hivee-hub run` reads env vars and runs