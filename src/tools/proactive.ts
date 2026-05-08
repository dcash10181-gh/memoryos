import Anthropic from '@anthropic-ai/sdk';
import { runQuery } from '../graph/client.js';
import { embedText } from '../pipeline/embedding.js';
import { logger } from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ProactiveOptions {
  contextType: string;
  topK: number;
  findExperts: boolean;
}

// ─── surface_proactive_context ────────────────────────────────────────────────
// The "what should I know before I start?" tool
// Triggered when a user opens a ticket, starts a review, or asks a question
export async function surfaceProactiveContext(
  intent: string,
  options: ProactiveOptions
): Promise<unknown> {
  logger.info({ intent, contextType: options.contextType }, '[proactive] Surfacing context');

  const intentEmbedding = await embedText(intent);

  // 1. Semantically similar artifacts (prior work on same topic)
  const similarArtifacts = await runQuery<{
    id: string; title: string; artifact_type: string;
    source_system: string; url: string; created_at: string;
    author_name: string; similarity: number;
  }>(`
    MATCH (a:Artifact)
    WHERE a.embedding IS NOT NULL
    WITH a, gds.similarity.cosine(a.embedding, $embedding) AS similarity
    WHERE similarity > 0.7
    OPTIONAL MATCH (p:Person)-[:AUTHORED]->(a)
    RETURN a.id AS id, a.title AS title, a.artifact_type AS artifact_type,
           a.source_system AS source_system, a.url AS url,
           a.created_at AS created_at, p.name AS author_name, similarity
    ORDER BY similarity DESC
    LIMIT $topK
  `, { embedding: intentEmbedding, topK: options.topK * 2 });

  // 2. Relevant decisions (similar context was decided on before)
  const relevantDecisions = await runQuery<{
    title: string; rationale: string; status: string;
    created_at: string; similarity: number;
  }>(`
    MATCH (d:Decision)
    WHERE d.embedding IS NOT NULL
    WITH d, gds.similarity.cosine(d.embedding, $embedding) AS similarity
    WHERE similarity > 0.65
    RETURN d.title AS title, d.rationale AS rationale,
           d.status AS status, d.created_at AS created_at, similarity
    ORDER BY similarity DESC
    LIMIT 3
  `, { embedding: intentEmbedding });

  // 3. Experts on this topic (people who authored most relevant artifacts)
  let experts: Array<{ name: string; email: string; contribution_count: number; sample_artifacts: string[] }> = [];
  if (options.findExperts) {
    const expertResults = await runQuery<{
      name: string; email: string; contribution_count: number;
      artifact_titles: string[];
    }>(`
      UNWIND $artifactIds AS artifactId
      MATCH (p:Person)-[:AUTHORED]->(a:Artifact {id: artifactId})
      WITH p, count(a) AS contribution_count, collect(a.title) AS artifact_titles
      WHERE contribution_count >= 1
      RETURN p.name AS name, p.email AS email,
             contribution_count, artifact_titles
      ORDER BY contribution_count DESC
      LIMIT 5
    `, { artifactIds: similarArtifacts.slice(0, 10).map(a => a.id) });

    experts = expertResults.map(e => ({
      name: e.name,
      email: e.email,
      contribution_count: e.contribution_count,
      sample_artifacts: (e.artifact_titles ?? []).slice(0, 3),
    }));
  }

  // 4. LLM synthesis — produce a proactive briefing
  const artifactContext = similarArtifacts.slice(0, 5).map(a =>
    `[${a.artifact_type}/${a.source_system}] "${a.title}" by ${a.author_name ?? 'unknown'} (${new Date(a.created_at).toLocaleDateString()}) — similarity: ${a.similarity.toFixed(2)}`
  ).join('\n');

  const decisionContext = relevantDecisions.map(d =>
    `Decision: "${d.title}" (${d.status}) — ${d.rationale}`
  ).join('\n');

  const expertContext = experts.map(e =>
    `${e.name} (${e.email ?? 'no email'}) — ${e.contribution_count} related contributions`
  ).join('\n');

  let briefing = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are surfacing institutional knowledge for someone starting work on a new task.

Their current work context: "${intent}"
Context type: ${options.contextType}

RELEVANT PRIOR WORK:
${artifactContext || 'None found'}

RELEVANT PAST DECISIONS:
${decisionContext || 'None found'}

SUBJECT-MATTER EXPERTS:
${expertContext || 'None identified'}

Write a concise (3-4 bullet points) proactive briefing that tells them:
1. The most important prior work they should review
2. Any past decisions that directly affect their work
3. Who to consult if they have questions

Be specific and actionable. Focus on what's most relevant, not everything you found.`,
      }]
    });
    briefing = response.content[0].type === 'text' ? response.content[0].text : '';
  } catch (err) {
    logger.warn({ err }, '[proactive] LLM briefing failed — returning raw results');
    briefing = `Found ${similarArtifacts.length} relevant artifacts, ${relevantDecisions.length} decisions, and ${experts.length} potential experts.`;
  }

  return {
    intent,
    context_type: options.contextType,
    proactive_briefing: briefing,
    relevant_artifacts: similarArtifacts.slice(0, options.topK).map(a => ({
      title: a.title,
      type: a.artifact_type,
      source: a.source_system,
      url: a.url,
      author: a.author_name,
      date: a.created_at,
      relevance_score: parseFloat(a.similarity.toFixed(3)),
    })),
    relevant_decisions: relevantDecisions.map(d => ({
      title: d.title,
      rationale: d.rationale,
      status: d.status,
      date: d.created_at,
      relevance_score: parseFloat(d.similarity.toFixed(3)),
    })),
    experts,
    total_related_items: similarArtifacts.length,
  };
}
