import neo4j, { Driver, Session, QueryResult } from 'neo4j-driver';
import { getConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';

// ─── Singleton driver ─────────────────────────────────────────────────────────
let _driver: Driver | null = null;

export function getDriver(): Driver {
  if (_driver) return _driver;
  const { graph } = getConfig();
  _driver = neo4j.driver(
    graph.uri,
    neo4j.auth.basic(graph.user, graph.password),
    {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30_000,
      logging: neo4j.logging.console('warn'),
    }
  );
  return _driver;
}

export async function closeDriver(): Promise<void> {
  await _driver?.close();
  _driver = null;
}

// ─── Convenience query wrapper ─────────────────────────────────────────────────
export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  database = 'neo4j'
): Promise<T[]> {
  const session: Session = getDriver().session({ database });
  try {
    const result: QueryResult = await session.run(cypher, params);
    return result.records.map(r => {
      const obj: Record<string, unknown> = {};
      r.keys.forEach(k => { obj[String(k)] = r.get(k); });
      return obj as T;
    });
  } finally {
    await session.close();
  }
}

// ─── Write transaction helper ─────────────────────────────────────────────────
export async function runWrite<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const session: Session = getDriver().session();
  try {
    const result = await session.writeTransaction(tx => tx.run(cypher, params));
    return result.records.map(r => {
      const obj: Record<string, unknown> = {};
      r.keys.forEach(k => { obj[String(k)] = r.get(k); });
      return obj as T;
    });
  } finally {
    await session.close();
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────
export async function healthCheck(): Promise<boolean> {
  try {
    await runQuery('RETURN 1 AS ok');
    return true;
  } catch (err) {
    logger.error({ err }, 'Neo4j health check failed');
    return false;
  }
}
