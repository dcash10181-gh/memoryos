import Anthropic from '@anthropic-ai/sdk';
import { runQuery, runWrite } from '../graph/client.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/loader.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Gap types the reflection engine can detect ───────────────────────────────
type GapType =
  | 'orphaned_decision'      // Decision with no supporting artifacts
  | 'unlinked_cross_ref'     // Jira ticket mentioned in Slack but not linked in graph
  | 'missing_rationale'      // High-activity artifact with no Decision nodes
  | 'isolated_artifact'      // Artifact with zero relationships
  | 'unknown_stakeholder'    // Person mentioned but no profile data
  | 'stale_context';         // Context node older than 90 days with no updates

interface KnowledgeGap {
  type: GapType;
  description: string;
  affected_node_id: string;
  affected_node_title: string;
  confidence: number;
  suggested_action: string;
}

// ─── Run the reflection pass ──────────────────────────────────────────────────
export async function runReflectionPass(): Promise<KnowledgeGap[]> {
  const config = getConfig();
  logger.info('[reflection] Starting reflection pass...');

  const gaps: KnowledgeGap[] = await Promise.all([
    detectOrphanedDecisions(),
    detectUnlinkedCrossReferences(),
    detectMissingRationale(),
    detectIsolatedArtifacts(),
  ]).then(results => results.flat());

  const significant = gaps.filter(g => g.confidence >= config.reflection.min_confidence_threshold);
  logger.info(`[reflection] Found ${gaps.length} gaps, ${significant.length} above threshold`);

  // Persist gaps as a special node type for observability
  await persistGaps(significant);

  // Use LLM to synthesize a reflection report
  if (significant.length > 0) {
    await synthesizeReflectionReport(significant);
  }

  return significant;
}

// ─── Gap detectors ────────────────────────────────────────────────────────────

async function detectOrphanedDecisions(): Promise<KnowledgeGap[]> {
  const orphans = await runQuery<{ id: string; title: string; rationale: string }>(`
    MATCH (d:Decision)
    WHERE NOT (d)-[:RATIONALE_FOR]->()
    RETURN d.id AS id, d.title AS title, d.rationale AS rationale
    LIMIT 20
  `);

  return orphans.map(d => ({
    type: 'orphaned_decision' as GapType,
    description: `Decision "${d.title}" has no linked source artifacts. The rationale exists but we can't trace WHERE this decision came from.`,
    affected_node_id: d.id,
    affected_node_title: d.title,
    confidence: 0.9,
    suggested_action: `Search for Slack threads or documents that discuss "${d.title}" and link them manually or re-run sync.`,
  }));
}

async function detectUnlinkedCrossReferences(): Promise<KnowledgeGap[]> {
  // Find external ID patterns (PROJ-123, #456) mentioned in artifact bodies
  // that don't have corresponding graph edges
  const artifacts = await runQuery<{ id: string; title: string; body: string; source: string }>(`
    MATCH (a:Artifact)
    WHERE a.body =~ '.*(JIRA|[A-Z]+-\\\\d+|PR #\\\\d+|issue #\\\\d+).*'
    AND NOT (a)-[:LINKED_TO]->()
    RETURN a.id AS id, a.title AS title, a.body AS body, a.source_system AS source
    LIMIT 30
  `);

  const gaps: KnowledgeGap[] = [];
  const refPattern = /\b([A-Z]{2,8}-\d{1,6})\b|#(\d{3,6})\b/g;

  for (const a of artifacts) {
    const matches = [...(a.body ?? '').matchAll(refPattern)];
    if (matches.length > 0) {
      gaps.push({
        type: 'unlinked_cross_ref',
        description: `"${a.title}" (${a.source}) mentions ${matches.map(m => m[0]).join(', ')} but those cross-references are not in the graph.`,
        affected_node_id: a.id,
        affected_node_title: a.title,
        confidence: 0.75,
        suggested_action: `Enable ${matches[0][0].includes('-') ? 'Jira' : 'GitHub'} connector to capture the referenced artifacts.`,
      });
    }
  }

  return gaps;
}

async function detectMissingRationale(): Promise<KnowledgeGap[]> {
  // High-activity artifacts (many comments/links) with no Decision nodes
  const highActivity = await runQuery<{
    id: string; title: string; artifact_type: string; link_count: number;
  }>(`
    MATCH (a:Artifact)
    WHERE a.artifact_type IN ['pr', 'ticket']
    WITH a, count{ (a)<-[:PART_OF]-() } AS link_count
    WHERE link_count >= 5
    AND NOT ()-[:RATIONALE_FOR]->(a)
    RETURN a.id AS id, a.title AS title, a.artifact_type AS artifact_type, link_count
    ORDER BY link_count DESC
    LIMIT 15
  `);

  return highActivity.map(a => ({
    type: 'missing_rationale' as GapType,
    description: `"${a.title}" (${a.artifact_type}) has ${a.link_count} related discussions but no explicit Decision node capturing why this was done.`,
    affected_node_id: a.id,
    affected_node_title: a.title,
    confidence: 0.8,
    suggested_action: `Review the discussion thread for "${a.title}" and create an explicit Decision record capturing the rationale.`,
  }));
}

async function detectIsolatedArtifacts(): Promise<KnowledgeGap[]> {
  const isolated = await runQuery<{ id: string; title: string; source: string; created_at: string }>(`
    MATCH (a:Artifact)
    WHERE NOT (a)--()
    AND a.artifact_type IN ['document', 'pr', 'ticket']
    AND a.created_at >= datetime() - duration({days: 30})
    RETURN a.id AS id, a.title AS title, a.source_system AS source, a.created_at AS created_at
    LIMIT 20
  `);

  return isolated.map(a => ({
    type: 'isolated_artifact' as GapType,
    description: `"${a.title}" (${a.source}, created ${new Date(a.created_at).toLocaleDateString()}) has zero relationships in the knowledge graph.`,
    affected_node_id: a.id,
    affected_node_title: a.title,
    confidence: 0.7,
    suggested_action: `Investigate why this artifact is isolated. It may indicate a sync gap in the ${a.source} connector or a content extraction failure.`,
  }));
}

// ─── Persist gaps for observability dashboard ──────────────────────────────────
async function persistGaps(gaps: KnowledgeGap[]): Promise<void> {
  for (const gap of gaps) {
    await runWrite(`
      MERGE (g:KnowledgeGap {affected_node_id: $id, type: $type})
      SET g.description = $description,
          g.confidence = $confidence,
          g.suggested_action = $suggested_action,
          g.detected_at = datetime(),
          g.resolved = false
    `, {
      id: gap.affected_node_id,
      type: gap.type,
      description: gap.description,
      confidence: gap.confidence,
      suggested_action: gap.suggested_action,
    });
  }
}

// ─── LLM synthesis of the reflection report ────────────────────────────────────
async function synthesizeReflectionReport(gaps: KnowledgeGap[]): Promise<void> {
  try {
    const gapSummary = gaps.slice(0, 10).map((g, i) =>
      `${i + 1}. [${g.type}] ${g.description}\n   Action: ${g.suggested_action}`
    ).join('\n\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are analyzing gaps in a company's knowledge graph. Review these gaps and provide a prioritized action plan (3-5 bullets, most impactful first):\n\n${gapSummary}`,
      }]
    });

    const report = response.content[0].type === 'text' ? response.content[0].text : '';
    logger.info({ report, gap_count: gaps.length }, '[reflection] Reflection report generated');

    // Persist as a system artifact for humans to review
    await runWrite(`
      MERGE (r:ReflectionReport {id: 'latest'})
      SET r.report = $report,
          r.gap_count = $count,
          r.generated_at = datetime()
    `, { report, count: gaps.length });

  } catch (err) {
    logger.warn({ err }, '[reflection] Report synthesis failed');
  }
}

// ─── Get latest reflection report ─────────────────────────────────────────────
export async function getReflectionStatus() {
  const report = await runQuery(`
    MATCH (r:ReflectionReport {id: 'latest'})
    RETURN r.report AS report, r.gap_count AS gap_count, r.generated_at AS generated_at
  `);

  const openGaps = await runQuery(`
    MATCH (g:KnowledgeGap {resolved: false})
    RETURN g.type AS type, count(*) AS count
    ORDER BY count DESC
  `);

  return { latest_report: report[0] ?? null, open_gaps_by_type: openGaps };
}
