import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(43137),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DATA_DIR: z.string().default("./data"),
  CONNECTOR_NAME: z.string().default("Hivee Connector"),
  CONNECTOR_BIND_PUBLIC: z.coerce.boolean().default(false),

  CLOUD_BASE_URL: z.string().optional().default("https://hivee.cloud"),
  CLOUD_WS_URL: z.string().optional().default(""),
  PAIRING_TOKEN: z.string().optional().default(""),
  CONNECTOR_HEARTBEAT_INTERVAL_SEC: z.coerce.number().default(15),
  CONNECTOR_COMMAND_POLL_INTERVAL_SEC: z.coerce.number().default(5),
  CONNECTOR_DISCOVERY_INTERVAL_SEC: z.coerce.number().default(15),

  OPENCLAW_BASE_URL: z.string().optional().default(""),
  OPENCLAW_TOKEN: z.string().optional().default(""),
  OPENCLAW_TRANSPORT: z.enum(["auto", "ws", "http"]).default("auto"),
  OPENCLAW_WS_PATH: z.string().optional().default(""),
  OPENCLAW_REQUEST_TIMEOUT_MS: z.coerce.number().default(0),
  OPENCLAW_DISCOVERY_CANDIDATES: z.string().default("http://127.0.0.1:18789,http://127.0.0.1:43136,http://openclaw:18789,http://openclaw:43136,http://openclaw:18790,http://openclaw-izjk-openclaw-1:18790"),

  ENABLE_DOCKER_DISCOVERY: z.coerce.boolean().default(true),
  DOCKER_SOCKET_PATH: z.string().default("/var/run/docker.sock")
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  return schema.parse(process.env);
}
