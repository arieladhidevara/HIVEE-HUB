import fs from "node:fs";
import path from "node:path";
import type { Env } from "../config/env.js";
import { ensureTrailingSlashless } from "../utils/text.js";

const RUNTIME_ENV_FILE = "runtime.env";
const RUNTIME_ENV_KEYS = ["CLOUD_BASE_URL", "PAIRING_TOKEN", "OPENCLAW_BASE_URL", "OPENCLAW_TOKEN"] as const;

type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];
type RuntimeEnvValues = Partial<Record<RuntimeEnvKey, string>>;

function runtimeEnvPath(dataDir: string): string {
  return path.join(dataDir, RUNTIME_ENV_FILE);
}

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  return trimmed;
}

function encodeValue(value: string): string {
  return JSON.stringify(value);
}

function normalizeValue(key: RuntimeEnvKey, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (key === "OPENCLAW_BASE_URL" || key === "CLOUD_BASE_URL") {
    return ensureTrailingSlashless(trimmed);
  }
  return trimmed;
}

function parseRuntimeEnv(content: string): RuntimeEnvValues {
  const output: RuntimeEnvValues = {};
  const allowed = new Set<string>(RUNTIME_ENV_KEYS);

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!allowed.has(key)) continue;
    const rawValue = trimmed.slice(separator + 1);
    output[key as RuntimeEnvKey] = normalizeValue(key as RuntimeEnvKey, parseValue(rawValue));
  }

  return output;
}

export function loadRuntimeEnvValues(dataDir: string): RuntimeEnvValues {
  const filePath = runtimeEnvPath(dataDir);
  if (!fs.existsSync(filePath)) return {};

  try {
    return parseRuntimeEnv(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function persistRuntimeEnvValues(dataDir: string, patch: RuntimeEnvValues): RuntimeEnvValues {
  const next: RuntimeEnvValues = {
    ...loadRuntimeEnvValues(dataDir)
  };

  for (const key of RUNTIME_ENV_KEYS) {
    if (patch[key] === undefined) continue;
    next[key] = normalizeValue(key, String(patch[key] || ""));
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = runtimeEnvPath(dataDir);
  const lines = [
    "# Managed by Hivee Hub runtime",
    ...RUNTIME_ENV_KEYS.map((key) => `${key}=${encodeValue(next[key] ?? "")}`)
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return next;
}

export function applyRuntimeEnvOverrides(env: Env): Env {
  const runtime = loadRuntimeEnvValues(env.DATA_DIR);
  return {
    ...env,
    CLOUD_BASE_URL: runtime.CLOUD_BASE_URL ?? env.CLOUD_BASE_URL,
    PAIRING_TOKEN: runtime.PAIRING_TOKEN ?? env.PAIRING_TOKEN,
    OPENCLAW_BASE_URL: runtime.OPENCLAW_BASE_URL ?? env.OPENCLAW_BASE_URL,
    OPENCLAW_TOKEN: runtime.OPENCLAW_TOKEN ?? env.OPENCLAW_TOKEN
  };
}
