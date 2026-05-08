import Anthropic from '@anthropic-ai/sdk';
import { runQuery } from '../graph/client.js';
import { embedText } from '../pipeline/embedding.js';
import { logger } from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface TraceOptions {
  timeRangeDays: number;
  focusOn: string;
}

// ─── trace_rationale: follows the reasoning path of a technical decision ──────
export async function traceRationale(
  decisionQuery: string,
  options: TraceOptions
): Promise<unknown> {
  logger.info({ decisionQuery }, '[rationale] Tracing rationale');

  const queryEmbedding = await embedText(decisionQuery);
  const since = new Date(Date.now() - options.timeRangeDays * 86_400_000).toISOString();

  // 1. Find semantically similar Decisions in the graph
  const decisions = await runQuery<{
    id: string; title: string; rationale: string;
    tradeoffs_made: string[]; status: string; created_at: string;
    similarity: number;
  }>(`
    MATCH (d:Decision)
    WHERE d.created_at >= $since AND d.embedding IS NOT NULL
    WITH d, gds.similarity.cosine(d.embedding, $embedding) AS similarity
    WHERE similarity > 0.6
    RETURN d.id AS id, d.title AS title, d.rationale AS rationale,
           d.tradeoffs_made AS tradeoffs_made, d.status AS status,
           d.created_at AS created_at, similarity
    ORDER BY similarity DESC
    LIMIT 5
  `, { embedding: queryEmbedding, since });

  // 2. For each candidate decision, traverse the full rationale chain
  const rationalePaths = await Promise.all(
    decisions.map(async dec => {
      const chain = await runQuery<{
        node_type: string; node_title: string; node_body: string;
        node_source: string; author_name: string; created_at: string;
        relationship: string;
      }>(`
        MATCH path = (d:Decision {id: $decId})-[:RATIONALE_FOR|EXTRACTED_FROM|PART_OF|LINKED_TO*1..4]->(leaf)
        WITH leaf, relationships(path) AS rels
        OPTIONAL MATCH (author:Person)-[:AUTHORED]->(leaf)
        RETURN labels(leaf)[0] AS node_type,
               coalesce(leaf.title, leaf.summary) AS node_title,
               left(coalesce(leaf.body, leaf.summary), 400) AS node_body,
               leaf.source_system AS node_source,
               author.name AS author_name,
               leaf.created_at AS created_at,
               [r IN rels | type(r)][-1] AS relationship
        ORDER BY leaf.created_at ASC
        LIMIT 15
      `, { decId: dec.id });

      return { decision: dec, chain };
    })
  );

  // 3. Synthesize the full rationale narrative
  const focusInstructions: Record<string, string> = {
    why: 'Focus on the core problem and why this solution was chosen over alternatives.',
    who: 'Focus on who was involved, their roles, and their specific contributions to the decision.',
    alternatives: 'Focus on what alternatives were considered and why they were rejected.',
    tradeoffs: 'Focus on the tradeoffs made and what was sacrificed to achieve the chosen outcome.',
    full: 'Provide a comprehensive analysis covering the problem, alternatives, tradeoffs, and outcome.',
  };

  const contextData = rationalePaths.map(rp => `
DECISION: ${rp.decision.title} (similarity: ${rp.decision.similarity.toFixed(2)})
STATUS: ${rp.decision.status}
DATE: ${rp.decision.created_at}
RATIONALE: ${rp.decision.rationale}
TRADEOFFS: ${(rp.decision.tradeoffs_made ?? []).join(', ')}

EVIDENCE CHAIN:
${rp.chain.map(n =>
  `  [${n.node_type}|${n.node_source}] ${n.node_title} — by ${n.author_name ?? 'unknown'}\n  ${n.node_body}`
).join('\n\n')}
  `).join('\n\n---\n\n');

  let narrative = '';
  if (decisions.length > 0) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are analyzing institutional knowledge to trace the rationale behind technical decisions.

Query: "${decisionQuery}"
Focus: ${focusInstructions[options.focusOn] ?? focusInstructions.full}

Here is the evidence from the company's knowledge graph:

${contextData}

Write a clear, structured rationale trace that would help a new engineer understand the history of this decision. 
Include: the original problem, the decision path, key stakeholders, alternatives considered, and the tradeoffs made.`,
        }]
      });
      narrative = response.content[0].type === 'text' ? response.content[0].text : '';
    } catch (err) {
      logger.warn({ err }, '[rationale] LLM synthesis failed');
    }
  }

  return {
    query: decisionQuery,
    decisions_found: decisions.length,
    rationale_paths: rationalePaths.map(rp => ({
      decision: {
        title: rp.decision.title,
        rationale: rp.decision.rationale,
        tradeoffs: rp.decision.tradeoffs_made,
        status: rp.decision.status,
        similarity_score: rp.decision.similarity,
      },
      evidence_chain: rp.chain.map(n => ({
        type: n.node_type,
        title: n.node_title,
        source: n.node_source,
        author: n.author_name,
        date: n.created_at,
        relationship: n.relationship,
        excerpt: n.node_body,
      })),
    })),
    synthesized_narrative: narrative || `No decisions found matching "${decisionQuery}" in the last ${options.timeRangeDays} days.`,
  };
}
