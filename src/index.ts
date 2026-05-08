import cron from 'node-cron';
import { loadConfig } from './config/loader.js';
import { getDriver, healthCheck } from './graph/client.js';
import { initSchema } from './graph/schema.js';
import { SlackConnector } from './connectors/slack.js';
import { GitHubConnector } from './connectors/github.js';
import { JiraConnector } from './connectors/jira.js';
import { Connector, SyncCursor } from './connectors/base.js';
import { ingestEvent } from './pipeline/ingestion.js';
import { deduplicatePersons, deduplicateArtifacts } from './pipeline/deduplication.js';
import { runReflectionPass } from './reflection/executor.js';
import { startMCPServer } from './mcp/server.js';
import { logger } from './utils/logger.js';

// ─── In-memory cursor store (replace with DB-backed store for multi-node) ─────
const cursors = new Map<string, SyncCursor>();

function getCursor(connector: string): SyncCursor {
  return cursors.get(connector) ?? {
    connector,
    last_synced_at: new Date(0).toISOString(),
  };
}

// ─── Build active connector list from config ──────────────────────────────────
function buildConnectors(config: ReturnType<typeof loadConfig>): Connector[] {
  const active: Connector[] = [];
  const cfg = config.connectors;

  if (cfg.slack?.enabled)      active.push(new SlackConnector());
  if (cfg.github?.enabled)     active.push(new GitHubConnector());
  if (cfg.jira?.enabled)       active.push(new JiraConnector());
  // Tier 3 connectors follow same pattern — add ConfluenceConnector, NotionConnector, EmailConnector

  return active;
}

// ─── Full historical sync (run once on first start) ───────────────────────────
async function runFullSync(connectors: Connector[]): Promise<void> {
  logger.info('[daemon] Starting full historical sync...');

  for (const connector of connectors) {
    logger.info(`[daemon] Full sync: ${connector.name}`);
    try {
      let eventCount = 0;
      await connector.fullSync(async event => {
        await ingestEvent(event);
        eventCount++;
        if (eventCount % 500 === 0) logger.info(`[daemon] ${connector.name}: ${eventCount} events ingested`);
      });

      cursors.set(connector.name, {
        connector: connector.name,
        last_synced_at: new Date().toISOString(),
      });

      logger.info(`[daemon] ${connector.name}: full sync complete — ${eventCount} events`);
    } catch (err) {
      logger.error({ err, connector: connector.name }, '[daemon] Full sync failed for connector');
    }
  }

  // Post-sync deduplication and reflection
  logger.info('[daemon] Running post-sync deduplication...');
  await deduplicatePersons();
  await deduplicateArtifacts();

  logger.info('[daemon] Running initial reflection pass...');
  const gaps = await runReflectionPass();
  if (gaps.length > 0) {
    logger.warn(`[daemon] Reflection found ${gaps.length} knowledge gaps — run 'memoryos gaps' to review`);
  }
}

// ─── Incremental sync (runs every sync_interval seconds) ─────────────────────
async function runIncrementalSync(connectors: Connector[]): Promise<void> {
  logger.info('[daemon] Running incremental sync...');

  for (const connector of connectors) {
    try {
      const cursor = getCursor(connector.name);
      const updatedCursor = await connector.incrementalSync(cursor, ingestEvent);
      cursors.set(connector.name, updatedCursor);
      logger.debug(`[daemon] ${connector.name}: incremental sync complete`);
    } catch (err) {
      logger.error({ err, connector: connector.name }, '[daemon] Incremental sync failed');
    }
  }
}

// ─── Main daemon bootstrap ────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';
  const config = loadConfig();

  logger.info(`[daemon] MemoryOS v1.0.0 — command: ${command}`);

  // Verify graph connectivity
  const graphReady = await healthCheck();
  if (!graphReady) {
    logger.error('[daemon] Cannot connect to Neo4j. Run: docker compose up -d neo4j');
    process.exit(1);
  }

  // Apply schema constraints + indexes
  await initSchema();

  // Build active connectors
  const connectors = buildConnectors(config);
  if (connectors.length === 0) {
    logger.warn('[daemon] No connectors enabled. Edit ~/.memoryos/config/config.yaml to enable sources.');
  }

  // Validate all connector credentials
  const validationResults = await Promise.all(
    connectors.map(async c => ({ name: c.name, valid: await c.validate() }))
  );
  const invalid = validationResults.filter(r => !r.valid);
  if (invalid.length > 0) {
    logger.warn(`[daemon] ${invalid.map(i => i.name).join(', ')} connector(s) failed validation — check credentials`);
  }
  const validConnectors = connectors.filter((_, i) => validationResults[i].valid);

  switch (command) {
    case 'start': {
      // Start MCP server
      await startMCPServer();

      // Check if this is a fresh install (no cursors set)
      const isFirstRun = validConnectors.every(c => !cursors.has(c.name));
      if (isFirstRun && validConnectors.length > 0) {
        logger.info('[daemon] First run detected — starting full historical sync (this may take a while)');
        await runFullSync(validConnectors);
      }

      // Schedule incremental sync
      const intervalSeconds = config.daemon.sync_interval;
      cron.schedule(`*/${Math.ceil(intervalSeconds / 60)} * * * *`, () => {
        runIncrementalSync(validConnectors).catch(err =>
          logger.error({ err }, '[daemon] Scheduled sync failed')
        );
      });

      // Schedule reflection pass
      if (config.reflection.enabled) {
        const reflectionMinutes = Math.ceil(config.reflection.gap_detection_interval / 60);
        cron.schedule(`0 */${reflectionMinutes} * * *`, () => {
          runReflectionPass().catch(err =>
            logger.error({ err }, '[daemon] Scheduled reflection failed')
          );
        });
      }

      logger.info('[daemon] MemoryOS daemon running. Press Ctrl+C to stop.');
      break;
    }

    case 'sync': {
      const isFull = args.includes('--full');
      if (isFull) {
        await runFullSync(validConnectors);
      } else {
        await runIncrementalSync(validConnectors);
      }
      await getDriver().close();
      break;
    }

    case 'gaps': {
      const { getReflectionStatus } = await import('./reflection/executor.js');
      const status = await getReflectionStatus();
      console.log(JSON.stringify(status, null, 2));
      await getDriver().close();
      break;
    }

    default:
      logger.error(`Unknown command: ${command}. Use: start | sync [--full] | gaps`);
      process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[daemon] Shutting down gracefully...');
  const { closeDriver } = await import('./graph/client.js');
  await closeDriver();
  process.exit(0);
});

main().catch(err => {
  logger.error({ err }, '[daemon] Fatal error');
  process.exit(1);
});
