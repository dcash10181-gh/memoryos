import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { getDecisionBackstory } from '../tools/backstory.js';
import { traceRationale } from '../tools/rationale.js';
import { surfaceProactiveContext } from '../tools/proactive.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/loader.js';

// ─── Tool definitions — these are the "What can I do here?" discovery surface ─
const TOOLS: Tool[] = [
  {
    name: 'get_decision_backstory',
    description: `Retrieves the complete conversational backstory behind a specific Jira ticket or GitHub PR.
    Use this when you need to understand WHY a decision was made, not just what the ticket says.
    Returns related Slack threads, PR comments, and email discussions that led to this artifact.`,
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: {
          type: 'string',
          description: 'The Jira ticket key (e.g., PROJ-123) or GitHub PR number (e.g., org/repo::pr::456)',
        },
        include_persons: {
          type: 'boolean',
          description: 'Whether to include stakeholder information (default: true)',
          default: true,
        },
        max_depth: {
          type: 'number',
          description: 'How many hops to traverse in the knowledge graph (1-3, default: 2)',
          default: 2,
        },
      },
      required: ['artifact_id'],
    },
  },
  {
    name: 'trace_rationale',
    description: `Follows the complete reasoning path behind a system architecture change or technical decision.
    Traces backwards through the knowledge graph to surface: the original problem, who proposed the solution,
    what alternatives were considered, and what tradeoffs were accepted.
    Ideal for onboarding new engineers or understanding legacy code choices.`,
    inputSchema: {
      type: 'object',
      properties: {
        decision_query: {
          type: 'string',
          description: 'Natural language description of the decision or system change to investigate',
        },
        time_range_days: {
          type: 'number',
          description: 'How far back to look (default: 365 days)',
          default: 365,
        },
        focus_on: {
          type: 'string',
          enum: ['why', 'who', 'alternatives', 'tradeoffs', 'full'],
          description: 'What aspect of the rationale to focus on (default: full)',
          default: 'full',
        },
      },
      required: ['decision_query'],
    },
  },
  {
    name: 'surface_proactive_context',
    description: `Automatically surfaces relevant institutional knowledge for a given work context.
    Use this when a user opens a ticket, starts a PR review, or asks a domain question —
    it proactively retrieves related prior decisions, similar past problems, and subject-matter experts.
    This is the "what should I know before I start?" tool.`,
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'The user\'s current work context or question (e.g., "reviewing auth service changes")',
        },
        context_type: {
          type: 'string',
          enum: ['ticket', 'pr_review', 'document', 'question', 'onboarding'],
          description: 'The type of work context',
          default: 'question',
        },
        top_k: {
          type: 'number',
          description: 'Number of relevant context items to return (default: 5)',
          default: 5,
        },
        find_experts: {
          type: 'boolean',
          description: 'Whether to identify subject-matter experts for this topic (default: true)',
          default: true,
        },
      },
      required: ['intent'],
    },
  },
  {
    name: 'who_knows_about',
    description: `Identifies which team members have the most context on a specific topic, technology, or system.
    Returns a ranked list of stakeholders with their relevant contributions and context depth.
    Use when you need to know who to ask about a particular domain.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic, system, or technology to find experts for',
        },
        active_within_days: {
          type: 'number',
          description: 'Only include people who were active within this many days (default: 180)',
          default: 180,
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'find_similar_decisions',
    description: `Searches the knowledge graph for past decisions similar to a current problem.
    Prevents teams from re-solving already-solved problems.
    Returns previously accepted solutions, their rationale, and whether they succeeded or were superseded.`,
    inputSchema: {
      type: 'object',
      properties: {
        problem_description: {
          type: 'string',
          description: 'Description of the current problem or decision being considered',
        },
        include_superseded: {
          type: 'boolean',
          description: 'Include decisions that were later superseded (default: false)',
          default: false,
        },
      },
      required: ['problem_description'],
    },
  },
];

// ─── Tool router ──────────────────────────────────────────────────────────────
async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'get_decision_backstory':
      return getDecisionBackstory(
        args.artifact_id as string,
        { includePerson: args.include_persons !== false, maxDepth: (args.max_depth as number) ?? 2 }
      );

    case 'trace_rationale':
      return traceRationale(
        args.decision_query as string,
        { timeRangeDays: (args.time_range_days as number) ?? 365, focusOn: (args.focus_on as string) ?? 'full' }
      );

    case 'surface_proactive_context':
      return surfaceProactiveContext(
        args.intent as string,
        {
          contextType: (args.context_type as string) ?? 'question',
          topK: (args.top_k as number) ?? 5,
          findExperts: args.find_experts !== false,
        }
      );

    case 'who_knows_about':
      return whoKnowsAbout(args.topic as string, (args.active_within_days as number) ?? 180);

    case 'find_similar_decisions':
      return findSimilarDecisions(args.problem_description as string, !!args.include_superseded);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Build and start MCP server ───────────────────────────────────────────────
export async function startMCPServer(): Promise<void> {
  const config = getConfig();
  const server = new Server(
    { name: 'memoryos', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Tool discovery — "What can I do here?"
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info({ tool: name, args }, '[mcp] Tool called');

    try {
      const result = await executeTool(name, args ?? {});
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      logger.error({ err, tool: name }, '[mcp] Tool execution error');
      return {
        content: [{
          type: 'text',
          text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  });

  // ─── HTTP/SSE transport for Claude.ai and other HTTP-based AI clients ──────
  const app = express();
  app.use(express.json());

  const transports: Map<string, SSEServerTransport> = new Map();

  app.get('/mcp', (req, res) => {
    const transport = new SSEServerTransport('/mcp/message', res);
    const sessionId = Math.random().toString(36).substring(2);
    transports.set(sessionId, transport);
    res.setHeader('X-Session-Id', sessionId);
    server.connect(transport);
    req.on('close', () => transports.delete(sessionId));
  });

  app.post('/mcp/message', async (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  });

  app.get('/health', async (_, res) => {
    const { healthCheck } = await import('../graph/client.js');
    const healthy = await healthCheck();
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', version: '1.0.0' });
  });

  app.get('/tools', (_, res) => res.json({ tools: TOOLS }));

  app.listen(config.daemon.port, () => {
    logger.info(`[mcp] MemoryOS MCP server running on http://localhost:${config.daemon.port}/mcp`);
    logger.info(`[mcp] Connect Claude Desktop: add to claude_desktop_config.json`);
    logger.info(`[mcp]   "memoryos": { "url": "http://localhost:${config.daemon.port}/mcp" }`);
  });

  // Also expose stdio transport for direct Claude Desktop integration
  if (process.env.MCP_STDIO === '1') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

// ─── Tool implementations for who_knows_about + find_similar_decisions ────────
import { runQuery } from '../graph/client.js';
import { embedText } from '../pipeline/embedding.js';

async function whoKnowsAbout(topic: string, activeWithinDays: number) {
  const topicEmbedding = await embedText(topic);
  const since = new Date(Date.now() - activeWithinDays * 86_400_000).toISOString();

  return runQuery(`
    MATCH (p:Person)-[:AUTHORED]->(a:Artifact)
    WHERE a.created_at >= $since
    WITH p, collect(a) AS artifacts, count(a) AS contribution_count
    WHERE contribution_count >= 2
    RETURN p.name AS name, p.email AS email,
           contribution_count,
           [a IN artifacts | {title: a.title, type: a.artifact_type, url: a.url}][0..5] AS sample_contributions
    ORDER BY contribution_count DESC
    LIMIT 10
  `, { since });
}

async function findSimilarDecisions(problem: string, includeSuperseded: boolean) {
  const embedding = await embedText(problem);
  const statusFilter = includeSuperseded ? '' : 'WHERE d.status <> "superseded"';

  return runQuery(`
    MATCH (d:Decision)
    ${statusFilter}
    WITH d, gds.similarity.cosine(d.embedding, $embedding) AS similarity
    WHERE similarity > 0.65
    MATCH (d)-[:RATIONALE_FOR]->(a:Artifact)
    RETURN d.title AS decision,
           d.rationale AS rationale,
           d.tradeoffs_made AS tradeoffs,
           d.status AS status,
           similarity,
           collect(a.title)[0] AS source_artifact
    ORDER BY similarity DESC
    LIMIT 5
  `, { embedding });
}
