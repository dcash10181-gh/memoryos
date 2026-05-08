import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { z } from 'zod';

// ─── Load .env before everything else ───────────────────────────────────────
const envPath = path.join(process.env.MEMORYOS_HOME ?? `${process.env.HOME}/.memoryos`, 'config', '.env');
dotenv.config({ path: envPath });

// ─── Zod Schema ─────────────────────────────────────────────────────────────
const ConnectorSchema = z.object({
  enabled: z.boolean().default(false),
}).passthrough();

const ConfigSchema = z.object({
  version: z.string(),
  daemon: z.object({
    port: z.number().default(7890),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    sync_interval: z.number().default(300),
  }),
  graph: z.object({
    uri: z.string().default('bolt://localhost:7687'),
    user: z.string().default('neo4j'),
    password: z.string(),
  }),
  embedding: z.object({
    provider: z.enum(['openai', 'voyage', 'local']).default('openai'),
    model: z.string().default('text-embedding-3-small'),
    api_key: z.string().optional(),
    dimensions: z.number().default(1536),
  }),
  llm: z.object({
    provider: z.enum(['anthropic', 'openai']).default('anthropic'),
    model: z.string().default('claude-sonnet-4-20250514'),
    api_key: z.string().optional(),
  }),
  connectors: z.object({
    slack:      ConnectorSchema.optional(),
    email:      ConnectorSchema.optional(),
    github:     ConnectorSchema.optional(),
    jira:       ConnectorSchema.optional(),
    confluence: ConnectorSchema.optional(),
    notion:     ConnectorSchema.optional(),
  }),
  reflection: z.object({
    enabled: z.boolean().default(true),
    gap_detection_interval: z.number().default(3600),
    min_confidence_threshold: z.number().default(0.65),
  }),
});

export type MemoryOSConfig = z.infer<typeof ConfigSchema>;

// ─── Env variable interpolation  ─────────────────────────────────────────────
function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnv);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v)])
    );
  }
  return obj;
}

// ─── Singleton loader ─────────────────────────────────────────────────────────
let _config: MemoryOSConfig | null = null;

export function loadConfig(configPath?: string): MemoryOSConfig {
  if (_config) return _config;

  const resolvedPath = configPath
    ?? process.env.MEMORYOS_CONFIG
    ?? path.join(process.env.MEMORYOS_HOME ?? `${process.env.HOME}/.memoryos`, 'config', 'config.yaml');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `MemoryOS config not found at ${resolvedPath}.\n` +
      `Run the installer first: curl -fsSL https://raw.githubusercontent.com/memoryos/core/main/install.sh | bash`
    );
  }

  const raw = yaml.load(fs.readFileSync(resolvedPath, 'utf8'));
  const interpolated = interpolateEnv(raw);
  const result = ConfigSchema.safeParse(interpolated);

  if (!result.success) {
    throw new Error(`Invalid MemoryOS config:\n${result.error.format()}`);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): MemoryOSConfig {
  if (!_config) return loadConfig();
  return _config;
}
