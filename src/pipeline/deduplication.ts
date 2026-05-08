import { v5 as uuidv5 } from 'uuid';
import { runQuery, runWrite } from '../graph/client.js';
import { embedText, cosineSimilarity } from './embedding.js';
import { logger } from '../utils/logger.js';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const SIMILARITY_THRESHOLD = 0.88;  // cosine similarity for entity merge

// ─── Canonical ID generation ──────────────────────────────────────────────────
// Ensures same entity always maps to the same node ID regardless of source
export function canonicalId(label: string, key: string): string {
  return uuidv5(`${label}::${key}`, NAMESPACE);
}

// ─── Person deduplication ─────────────────────────────────────────────────────
// Problem: "duane.cash" in Slack, "duane-cash" in GitHub, "Duane Cash" in Jira
// all represent the same person — we must merge them into one Person node.
export async function deduplicatePersons(): Promise<number> {
  logger.info('[dedup] Running person deduplication pass...');
  let mergeCount = 0;

  // Load all Person nodes with embeddings
  const persons = await runQuery<{
    id: string;
    name: string;
    email: string;
    embedding: number[] | null;
    external_ids: string[];
  }>(`
    MATCH (p:Person)
    RETURN p.id AS id, p.name AS name, p.email AS email,
           p.embedding AS embedding,
           collect(p.external_id) AS external_ids
  `);

  const resolved = new Set<string>();

  for (let i = 0; i < persons.length; i++) {
    if (resolved.has(persons[i].id)) continue;

    for (let j = i + 1; j < persons.length; j++) {
      if (resolved.has(persons[j].id)) continue;

      const a = persons[i];
      const b = persons[j];

      // Exact email match — highest confidence
      if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) {
        await mergePersonNodes(a.id, b.id);
        resolved.add(b.id);
        mergeCount++;
        continue;
      }

      // Name similarity + embedding cosine similarity
      if (a.embedding && b.embedding) {
        const sim = cosineSimilarity(a.embedding, b.embedding);
        const nameSim = normalizedLevenshtein(
          a.name.toLowerCase(),
          b.name.toLowerCase()
        );

        if (sim > SIMILARITY_THRESHOLD && nameSim > 0.7) {
          logger.debug({ a: a.name, b: b.name, sim, nameSim }, '[dedup] Merging persons');
          await mergePersonNodes(a.id, b.id);
          resolved.add(b.id);
          mergeCount++;
        }
      }
    }
  }

  logger.info(`[dedup] Person deduplication complete — ${mergeCount} merges`);
  return mergeCount;
}

// ─── Artifact deduplication ───────────────────────────────────────────────────
// Detects when the same document is indexed by two connectors
// (e.g., a Confluence page linked in a Slack message)
export async function deduplicateArtifacts(): Promise<number> {
  logger.info('[dedup] Running artifact deduplication pass...');
  let mergeCount = 0;

  const artifacts = await runQuery<{
    id: string;
    title: string;
    source_system: string;
    external_id: string;
    url: string | null;
    embedding: number[] | null;
  }>(`
    MATCH (a:Artifact)
    WHERE a.embedding IS NOT NULL
    RETURN a.id AS id, a.title AS title,
           a.source_system AS source_system,
           a.external_id AS external_id,
           a.url AS url,
           a.embedding AS embedding
  `);

  const resolved = new Set<string>();

  for (let i = 0; i < artifacts.length; i++) {
    if (resolved.has(artifacts[i].id)) continue;

    for (let j = i + 1; j < artifacts.length; j++) {
      if (resolved.has(artifacts[j].id)) continue;
      if (artifacts[i].source_system === artifacts[j].source_system) continue; // Different systems only

      const a = artifacts[i];
      const b = artifacts[j];

      // URL match (most reliable cross-system indicator)
      if (a.url && b.url && stripTracking(a.url) === stripTracking(b.url)) {
        await createSameAsRelationship(a.id, b.id);
        mergeCount++;
        continue;
      }

      // Embedding similarity for content deduplication
      if (a.embedding && b.embedding) {
        const sim = cosineSimilarity(a.embedding, b.embedding);
        if (sim > 0.95) {
          await createSameAsRelationship(a.id, b.id);
          mergeCount++;
          resolved.add(b.id);
        }
      }
    }
  }

  logger.info(`[dedup] Artifact deduplication complete — ${mergeCount} SAME_AS edges`);
  return mergeCount;
}

// ─── Merge two Person nodes into canonical node (keep higher-info node) ───────
async function mergePersonNodes(canonicalId: string, duplicateId: string): Promise<void> {
  // Re-point all relationships from duplicate → canonical, then delete duplicate
  await runWrite(`
    MATCH (dup:Person {id: $dupId})
    MATCH (can:Person {id: $canId})
    WITH dup, can
    CALL apoc.refactor.mergeNodes([can, dup], {
      properties: 'discard',
      mergeRels: true
    })
    YIELD node
    RETURN node
  `, { dupId: duplicateId, canId: canonicalId });
}

// ─── For artifacts we use a SAME_AS edge (don't fully merge, preserve provenance)
async function createSameAsRelationship(idA: string, idB: string): Promise<void> {
  await runWrite(`
    MATCH (a:Artifact {id: $idA}), (b:Artifact {id: $idB})
    MERGE (a)-[:SAME_AS]->(b)
  `, { idA, idB });
}

// ─── Levenshtein distance for name similarity ─────────────────────────────────
function normalizedLevenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    ['utm_source','utm_medium','utm_campaign','ref','source'].forEach(p => u.searchParams.delete(p));
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}
