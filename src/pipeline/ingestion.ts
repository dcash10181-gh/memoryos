import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';
import { RawIngestionEvent } from '../connectors/base.js';
import { embedText } from './embedding.js';
import { canonicalId } from './deduplication.js';
import {
  upsertArtifact, upsertPerson, upsertDecision, upsertContext, upsertRelationship,
  ArtifactNode, PersonNode, DecisionNode, ContextNode
} from '../graph/schema.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/loader.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const limit = pLimit(5);  // max 5 concurrent LLM calls

// ─── LLM extraction prompt ────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are an institutional knowledge extractor. Analyze the following piece of corporate content and extract structured information.

Return a JSON object with this exact shape:
{
  "summary": "2-3 sentence summary of the key information",
  "key_themes": ["theme1", "theme2", "theme3"],
  "decisions": [
    {
      "title": "Decision title",
      "rationale": "Why this decision was made",
      "tradeoffs": ["tradeoff1", "tradeoff2"],
      "status": "proposed|accepted|superseded|deprecated"
    }
  ],
  "mentions_external_ids": ["JIRA-123", "PR-456"],
  "is_decision_content": true|false,
  "contains_rationale": true|false,
  "expertise_topics": ["topic this person seems expert in"]
}

If no decisions are present, return "decisions": [].
Respond ONLY with valid JSON, no explanation.`;

// ─── Main ingestion pipeline ───────────────────────────────────────────────────
export async function ingestEvent(event: RawIngestionEvent): Promise<void> {
  if (!event.body?.trim()) return;

  try {
    // 1. Create or upsert Artifact node
    const artifactId = canonicalId('Artifact', `${event.source}::${event.external_id}`);
    const artifact: ArtifactNode = {
      id: artifactId,
      title: event.title ?? event.body.slice(0, 80),
      body: event.body.slice(0, 8_000),  // cap stored body size
      artifact_type: event.type,
      source_system: event.source as ArtifactNode['source_system'],
      external_id: event.external_id,
      url: event.url,
      created_at: event.created_at,
      updated_at: event.updated_at,
    };

    // 2. Generate embedding
    artifact.embedding = await embedText(`${artifact.title}\n${artifact.body}`);
    await upsertArtifact(artifact);

    // 3. Upsert author Person node
    if (event.author_external_id || event.author_email) {
      const personKey = event.author_email ?? `${event.source}::${event.author_external_id}`;
      const personId = canonicalId('Person', personKey);
      const person: PersonNode = {
        id: personId,
        name: event.author_name ?? event.author_external_id ?? 'Unknown',
        email: event.author_email,
        context_expertise: [],
        source_system: event.source,
        external_id: event.author_external_id ?? event.author_email ?? '',
      };
      await upsertPerson(person);
      await upsertRelationship(personId, 'Person', artifactId, 'Artifact', 'AUTHORED');
    }

    // 4. Thread/parent relationships
    if (event.parent_id) {
      const parentArtifactId = canonicalId('Artifact', `${event.source}::${event.parent_id}`);
      await upsertRelationship(artifactId, 'Artifact', parentArtifactId, 'Artifact', 'PART_OF');
    }

    // 5. LLM extraction for high-signal content
    const isHighSignal = event.body.length > 100 &&
      (event.type === 'pr' || event.type === 'ticket' ||
       (event.type === 'message' && event.body.length > 200) ||
       event.type === 'document');

    if (isHighSignal) {
      await limit(() => extractAndPersist(event, artifactId));
    }

  } catch (err) {
    logger.error({ err, external_id: event.external_id, source: event.source }, '[pipeline] Ingestion error');
  }
}

// ─── LLM extraction + graph enrichment ───────────────────────────────────────
async function extractAndPersist(event: RawIngestionEvent, artifactId: string): Promise<void> {
  let extraction: {
    summary: string;
    key_themes: string[];
    decisions: Array<{ title: string; rationale: string; tradeoffs: string[]; status: string }>;
    mentions_external_ids: string[];
    contains_rationale: boolean;
    expertise_topics: string[];
  };

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',   // Use fast/cheap model for extraction
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\n---\nSOURCE: ${event.source}\nTYPE: ${event.type}\nTITLE: ${event.title ?? 'N/A'}\n\n${event.body.slice(0, 4000)}`
      }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    extraction = JSON.parse(text.replace(/```json\n?|```/g, '').trim());
  } catch (err) {
    logger.debug({ err }, '[pipeline] LLM extraction failed — skipping enrichment');
    return;
  }

  // Persist Context node
  const contextId = uuidv4();
  const context: ContextNode = {
    id: contextId,
    summary: extraction.summary,
    key_themes: extraction.key_themes ?? [],
    source_artifact_id: artifactId,
    created_at: event.created_at,
    embedding: await embedText(extraction.summary),
  };
  await upsertContext(context);
  await upsertRelationship(contextId, 'Context', artifactId, 'Artifact', 'EXTRACTED_FROM');

  // Persist Decision nodes
  for (const dec of extraction.decisions ?? []) {
    if (!dec.rationale) continue;
    const decisionId = canonicalId('Decision', `${artifactId}::${dec.title}`);
    const decision: DecisionNode = {
      id: decisionId,
      title: dec.title,
      rationale: dec.rationale,
      tradeoffs_made: dec.tradeoffs ?? [],
      status: (dec.status as DecisionNode['status']) ?? 'accepted',
      created_at: event.created_at,
      embedding: await embedText(`${dec.title} ${dec.rationale}`),
    };
    await upsertDecision(decision);
    await upsertRelationship(decisionId, 'Decision', artifactId, 'Artifact', 'RATIONALE_FOR');
    await upsertRelationship(decisionId, 'Decision', contextId, 'Context', 'RATIONALE_FOR');
  }

  // Cross-system reference edges (e.g., Slack message mentioning "JIRA-123")
  for (const refId of extraction.mentions_external_ids ?? []) {
    const referencedArtifactId = canonicalId('Artifact', refId);
    await upsertRelationship(artifactId, 'Artifact', referencedArtifactId, 'Artifact', 'LINKED_TO',
      { confidence: 'high', detected_by: 'llm' });
  }
}

// ─── Batch ingest with concurrency control ────────────────────────────────────
export async function batchIngest(events: RawIngestionEvent[]): Promise<void> {
  logger.info(`[pipeline] Batch ingesting ${events.length} events`);
  let processed = 0;

  await Promise.all(
    events.map(event => limit(async () => {
      await ingestEvent(event);
      processed++;
      if (processed % 100 === 0) {
        logger.info(`[pipeline] Progress: ${processed}/${events.length}`);
      }
    }))
  );

  logger.info(`[pipeline] Batch complete — ${processed} events ingested`);
}
