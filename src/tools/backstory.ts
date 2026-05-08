import { runQuery } from '../graph/client.js';
import { embedText } from '../pipeline/embedding.js';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface BackstoryOptions {
  includePerson: boolean;
  maxDepth: number;
}

interface BackstoryResult {
  artifact: {
    title: string;
    type: string;
    url: string;
    source: string;
    created_at: string;
  };
  stakeholders: Array<{ name: string; role: string; email: string }>;
  decisions: Array<{ title: string; rationale: string; tradeoffs: string[]; status: string }>;
  related_conversations: Array<{ source: string; title: string; body: string; author: string; url: string }>;
  synthesized_backstory: string;
  graph_path_count: number;
}

// ─── Main backstory tool ──────────────────────────────────────────────────────
export async function getDecisionBackstory(
  artifactId: string,
  options: BackstoryOptions
): Promise<BackstoryResult> {
  logger.info({ artifactId }, '[backstory] Fetching decision backstory');

  // 1. Find the target artifact (by external_id like "PROJ-123" or "org/repo::pr::456")
  const artifacts = await runQuery<{
    id: string; title: string; artifact_type: string;
    url: string; source_system: string; created_at: string; body: string;
  }>(`
    MATCH (a:Artifact)
    WHERE a.external_id = $id OR a.id = $id OR a.url CONTAINS $id
    RETURN a.id AS id, a.title AS title, a.artifact_type AS artifact_type,
           a.url AS url, a.source_system AS source_system,
           a.created_at AS created_at, a.body AS body
    LIMIT 1
  `, { id: artifactId });

  if (artifacts.length === 0) {
    return {
      artifact: { title: 'Not found', type: '', url: '', source: '', created_at: '' },
      stakeholders: [],
      decisions: [],
      related_conversations: [],
      synthesized_backstory: `No artifact found matching "${artifactId}". Try a different ID format.`,
      graph_path_count: 0,
    };
  }

  const target = artifacts[0];

  // 2. Multi-hop graph traversal — find all related nodes within maxDepth hops
  const related = await runQuery<{
    related_id: string; related_title: string; related_type: string;
    related_body: string; related_source: string; related_url: string;
    author_name: string; path_length: number; relationship_types: string[];
  }>(`
    MATCH path = (target:Artifact {id: $targetId})-[*1..${options.maxDepth}]-(related)
    WHERE related <> target AND (related:Artifact OR related:Context OR related:Decision)
    WITH related, length(path) AS path_length,
         [r IN relationships(path) | type(r)] AS relationship_types
    OPTIONAL MATCH (author:Person)-[:AUTHORED]->(related)
    RETURN related.id AS related_id,
           related.title AS related_title,
           labels(related)[0] AS related_type,
           related.body AS related_body,
           related.source_system AS related_source,
           related.url AS related_url,
           author.name AS author_name,
           path_length,
           relationship_types
    ORDER BY path_length ASC
    LIMIT 20
  `, { targetId: target.id });

  // 3. Fetch decisions linked to this artifact
  const decisions = await runQuery<{
    title: string; rationale: string; tradeoffs_made: string[]; status: string;
  }>(`
    MATCH (d:Decision)-[:RATIONALE_FOR]->(a:Artifact)
    WHERE a.id = $targetId OR a.external_id = $externalId
    RETURN d.title AS title, d.rationale AS rationale,
           d.tradeoffs_made AS tradeoffs_made, d.status AS status
    LIMIT 10
  `, { targetId: target.id, externalId: artifactId });

  // 4. Fetch stakeholders if requested
  const stakeholders = options.includePerson ? await runQuery<{
    name: string; email: string; role: string;
  }>(`
    MATCH (p:Person)-[:STAKEHOLDER_IN|AUTHORED]->(n)-[*0..2]-(a:Artifact {id: $targetId})
    WITH DISTINCT p
    RETURN p.name AS name, p.email AS email, p.role AS role
    LIMIT 10
  `, { targetId: target.id }) : [];

  // 5. Synthesize with Claude — produce a human-readable backstory narrative
  const rawContext = [
    `ARTIFACT: ${target.title} (${target.source_system})`,
    `CREATED: ${target.created_at}`,
    `\nCONTENT:\n${target.body}`,
    decisions.length > 0 ? `\nDECISIONS MADE:\n${decisions.map(d =>
      `- ${d.title}: ${d.rationale}`).join('\n')}` : '',
    related.length > 0 ? `\nRELATED DISCUSSIONS:\n${related.slice(0, 8).map(r =>
      `[${r.related_type}] ${r.related_title}: ${String(r.related_body ?? '').slice(0, 300)}`
    ).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  let synthesized_backstory = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Based on the following institutional knowledge graph data, write a clear, concise backstory (3-5 paragraphs) explaining WHY this artifact exists, what problem it was solving, what alternatives were considered, and what context someone new to this topic needs to understand it fully.\n\n${rawContext}`,
      }]
    });
    synthesized_backstory = response.content[0].type === 'text' ? response.content[0].text : '';
  } catch (err) {
    logger.warn({ err }, '[backstory] LLM synthesis failed — returning raw data');
    synthesized_backstory = `Found ${related.length} related items and ${decisions.length} explicit decisions. Raw data returned.`;
  }

  return {
    artifact: {
      title: target.title,
      type: target.artifact_type,
      url: target.url,
      source: target.source_system,
      created_at: target.created_at,
    },
    stakeholders,
    decisions: decisions.map(d => ({
      title: d.title,
      rationale: d.rationale,
      tradeoffs: d.tradeoffs_made ?? [],
      status: d.status,
    })),
    related_conversations: related.map(r => ({
      source: r.related_source ?? r.related_type,
      title: r.related_title ?? 'Untitled',
      body: String(r.related_body ?? '').slice(0, 500),
      author: r.author_name ?? 'Unknown',
      url: r.related_url ?? '',
    })),
    synthesized_backstory,
    graph_path_count: related.length,
  };
}
