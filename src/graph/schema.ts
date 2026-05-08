import { runWrite } from './client.js';
import { logger } from '../utils/logger.js';

// ─── Property Graph Schema ────────────────────────────────────────────────────
//
//  NODES (entities)
//  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
//  │  Person  │  │ Artifact │  │ Decision │  │ Context  │
//  └──────────┘  └──────────┘  └──────────┘  └──────────┘
//
//  EDGES (relationships)
//  Person  ──[AUTHORED]────────► Artifact
//  Person  ──[STAKEHOLDER_IN]──► Decision
//  Decision──[RATIONALE_FOR]───► Artifact | Context
//  Artifact──[LINKED_TO]───────► Artifact
//  Artifact──[REPLACES]────────► Artifact
//  Context ──[EXTRACTED_FROM]──► Artifact
//  Person  ──[MENTIONED_IN]────► Context
// ─────────────────────────────────────────────────────────────────────────────

const CONSTRAINTS = [
  // Uniqueness constraints ensure one canonical node per external ID
  'CREATE CONSTRAINT person_id        IF NOT EXISTS FOR (p:Person)   REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT artifact_id      IF NOT EXISTS FOR (a:Artifact) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT decision_id      IF NOT EXISTS FOR (d:Decision) REQUIRE d.id IS UNIQUE',
  'CREATE CONSTRAINT context_id       IF NOT EXISTS FOR (c:Context)  REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT source_id        IF NOT EXISTS FOR (s:Source)   REQUIRE s.id IS UNIQUE',
];

const INDEXES = [
  // Full-text search index across node labels for freetext queries
  `CREATE FULLTEXT INDEX memoryos_fulltext IF NOT EXISTS
   FOR (n:Person|Artifact|Decision|Context)
   ON EACH [n.name, n.title, n.body, n.rationale, n.summary]`,

  // Range indexes for time-windowed queries
  'CREATE INDEX artifact_created IF NOT EXISTS FOR (a:Artifact) ON (a.created_at)',
  'CREATE INDEX decision_created IF NOT EXISTS FOR (d:Decision) ON (d.created_at)',
  'CREATE INDEX context_created  IF NOT EXISTS FOR (c:Context)  ON (c.created_at)',

  // Source-system lookup — enables connector-level deduplication
  'CREATE INDEX person_source    IF NOT EXISTS FOR (p:Person)   ON (p.source_system, p.external_id)',
  'CREATE INDEX artifact_source  IF NOT EXISTS FOR (a:Artifact) ON (a.source_system, p.external_id)',
];

// ─── Node factory types ───────────────────────────────────────────────────────

export interface PersonNode {
  id: string;
  name: string;
  email?: string;
  role?: string;
  context_expertise: string[];   // topics/domains this person has context on
  tenure_days?: number;
  source_system: string;
  external_id: string;           // slack user_id, github login, jira accountId, etc.
  embedding?: number[];
}

export interface ArtifactNode {
  id: string;
  title: string;
  body?: string;
  artifact_type: 'message' | 'pr' | 'ticket' | 'document' | 'email' | 'commit' | 'comment';
  source_system: 'slack' | 'github' | 'jira' | 'confluence' | 'notion' | 'email';
  external_id: string;
  url?: string;
  created_at: string;    // ISO8601
  updated_at?: string;
  embedding?: number[];
}

export interface DecisionNode {
  id: string;
  title: string;
  rationale: string;
  tradeoffs_made: string[];
  status: 'proposed' | 'accepted' | 'superseded' | 'deprecated';
  created_at: string;
  embedding?: number[];
}

export interface ContextNode {
  id: string;
  summary: string;
  key_themes: string[];
  source_artifact_id: string;
  created_at: string;
  embedding?: number[];
}

// ─── Edge types ───────────────────────────────────────────────────────────────

export type RelationshipType =
  | 'AUTHORED'           // Person → Artifact
  | 'STAKEHOLDER_IN'     // Person → Decision
  | 'RATIONALE_FOR'      // Decision → Artifact | Context
  | 'LINKED_TO'          // Artifact → Artifact (cross-system reference)
  | 'REPLACES'           // Artifact → Artifact (evolution chain)
  | 'EXTRACTED_FROM'     // Context → Artifact
  | 'MENTIONED_IN'       // Person → Context
  | 'PART_OF';           // Artifact → Artifact (thread/comment hierarchy)

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

export async function initSchema(): Promise<void> {
  logger.info('Applying knowledge graph schema...');

  for (const constraint of CONSTRAINTS) {
    try {
      await runWrite(constraint);
    } catch (err: unknown) {
      // Constraint may already exist across versions — non-fatal
      if (!(err instanceof Error && err.message.includes('already exists'))) {
        logger.warn({ err, constraint }, 'Constraint creation warning');
      }
    }
  }

  for (const index of INDEXES) {
    try {
      await runWrite(index);
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.includes('already exists'))) {
        logger.warn({ err, index }, 'Index creation warning');
      }
    }
  }

  logger.info('Schema applied — constraints and indexes ready.');
}

// ─── Upsert helpers ───────────────────────────────────────────────────────────

export async function upsertPerson(p: PersonNode): Promise<void> {
  await runWrite(
    `MERGE (n:Person {id: $id})
     SET n += $props, n.updated_at = datetime()`,
    { id: p.id, props: p }
  );
}

export async function upsertArtifact(a: ArtifactNode): Promise<void> {
  await runWrite(
    `MERGE (n:Artifact {id: $id})
     SET n += $props, n.updated_at = datetime()`,
    { id: a.id, props: a }
  );
}

export async function upsertDecision(d: DecisionNode): Promise<void> {
  await runWrite(
    `MERGE (n:Decision {id: $id})
     SET n += $props, n.updated_at = datetime()`,
    { id: d.id, props: d }
  );
}

export async function upsertContext(c: ContextNode): Promise<void> {
  await runWrite(
    `MERGE (n:Context {id: $id})
     SET n += $props, n.updated_at = datetime()`,
    { id: c.id, props: c }
  );
}

export async function upsertRelationship(
  fromId: string,
  fromLabel: string,
  toId: string,
  toLabel: string,
  relType: RelationshipType,
  props: Record<string, unknown> = {}
): Promise<void> {
  await runWrite(
    `MATCH (a:${fromLabel} {id: $fromId})
     MATCH (b:${toLabel} {id: $toId})
     MERGE (a)-[r:${relType}]->(b)
     SET r += $props, r.updated_at = datetime()`,
    { fromId, toId, props }
  );
}
