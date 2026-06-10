# MemoryOS

> **Your company's institutional brain — self-hosted, private, one-line install.**
>
> *A working architectural prototype exploring passive knowledge capture as a queryable property graph.*

Every year your company loses millions in institutional knowledge: engineers who leave and take context with them, Slack threads that die, Jira tickets written with no "why," PRs merged without rationale. MemoryOS captures it all passively and makes it queryable by any AI model.

```bash
curl -fsSL https://raw.githubusercontent.com/dcash10181-gh/memoryos/main/install.sh | bash
```

---

## What it does

MemoryOS is a lightweight daemon that:

1. **Passively indexes** your company's knowledge sources — Slack, GitHub, Jira, Confluence, Notion, email — with zero behavior change required from your team
2. **Builds a semantic property graph** in a self-hosted Neo4j instance, capturing not just *what* was said but *why* decisions were made and *who* has context
3. **Exposes an MCP server** so Claude, GitHub Copilot, Cursor, and any other AI tool automatically has access to your company's full context
4. **Surfaces knowledge proactively** — when you open a ticket, it shows you the three Slack threads explaining the backstory

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        DATA SOURCES                             │
│  Slack   GitHub   Jira   Confluence   Notion   Email            │
└────────────────────┬────────────────────────────────────────────┘
                     │ RawIngestionEvent stream
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    INGESTION PIPELINE                           │
│  Embedding Generation → LLM Extraction → Entity Deduplication  │
└────────────────────┬────────────────────────────────────────────┘
                     │ Graph operations (MERGE, SET)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│               KNOWLEDGE GRAPH  (Neo4j)                          │
│                                                                 │
│  Person ──[AUTHORED]──► Artifact ◄──[EXTRACTED_FROM]── Context  │
│    │                      │                                     │
│    └──[STAKEHOLDER_IN]─► Decision ──[RATIONALE_FOR]──► Artifact │
│                           │                                     │
│                           └──[REPLACES]──► Decision (old)       │
└────────────────────┬────────────────────────────────────────────┘
                     │ Cypher queries + vector similarity
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP SERVER  :7890                           │
│                                                                 │
│  get_decision_backstory   trace_rationale                       │
│  surface_proactive_context  who_knows_about                     │
│  find_similar_decisions                                         │
└────────────────────┬────────────────────────────────────────────┘
                     │ JSON-RPC 2.0 / SSE
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AI CLIENTS                                   │
│  Claude Desktop   GitHub Copilot   Cursor   Your internal bot   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/dcash10181-gh/memoryos/main/install.sh | bash
```

Requires: Node.js 18+, Docker. That's it.

### 2. Configure

```bash
nano ~/.memoryos/config/config.yaml
```

Enable connectors and add your API tokens:

```yaml
connectors:
  slack:
    enabled: true
    bot_token: ${SLACK_BOT_TOKEN}   # add to ~/.memoryos/config/.env

  github:
    enabled: true
    token: ${GITHUB_TOKEN}
    org: your-org
```

### 3. Start

```bash
memoryos start
```

First run performs a full historical sync (may take 10–30 min for large workspaces). Subsequent starts do incremental syncs.

### 4. Connect to Claude

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memoryos": {
      "url": "http://localhost:7890/mcp"
    }
  }
}
```

Now ask Claude: *"Why did we migrate from MongoDB to Postgres?"* and it will search your actual company history.

---

## CLI Reference

```bash
memoryos start              # Start daemon + MCP server
memoryos sync --full        # Force full historical re-sync
memoryos sync               # Run incremental sync now
memoryos ask "why X?"       # Query the knowledge graph directly
memoryos gaps               # Show knowledge graph gaps
memoryos status             # Health check
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_decision_backstory` | Fetches the Slack/email backstory behind a Jira ticket or PR |
| `trace_rationale` | Follows the complete reasoning path of an architecture decision |
| `surface_proactive_context` | "What should I know before starting this?" |
| `who_knows_about` | Find who has the most context on a topic |
| `find_similar_decisions` | Find past solutions to similar problems |

---

## Knowledge Graph Schema

```
NODES
  Person     — name, email, role, context_expertise[], tenure_days
  Artifact   — title, body, type, source_system, external_id, url, embedding[]
  Decision   — title, rationale, tradeoffs_made[], status, embedding[]
  Context    — summary, key_themes[], source_artifact_id, embedding[]

EDGES
  AUTHORED          Person  → Artifact
  STAKEHOLDER_IN    Person  → Decision
  RATIONALE_FOR     Decision → Artifact | Context
  LINKED_TO         Artifact → Artifact  (cross-system reference)
  REPLACES          Artifact → Artifact  (evolution chain)
  EXTRACTED_FROM    Context  → Artifact
  PART_OF           Artifact → Artifact  (thread hierarchy)
  SAME_AS           Artifact → Artifact  (deduplication)
```

---

## Connector Status

> **Note:** MemoryOS is a working architectural prototype. The connectors marked *Implemented* below are functional against their respective APIs; "Beta" and "Roadmap" items are stubbed or planned. This is a design-and-build proof of concept, not a hardened production deployment.


| Connector | Tier | Status |
|-----------|------|--------|
| Slack | 1 — High-signal conversational | ✅ Implemented |
| Email (IMAP/Gmail) | 1 — High-signal conversational | ✅ Implemented |
| GitHub (PRs, Issues, Commits) | 2 — Decision tracking | ✅ Implemented |
| Jira | 2 — Decision tracking | ✅ Implemented |
| Confluence | 3 — Documentation | 🔧 Beta |
| Notion | 3 — Documentation | 🔧 Beta |
| Linear | 2 — Decision tracking | 📅 Roadmap |
| Figma | 3 — Documentation | 📅 Roadmap |
| Google Drive | 3 — Documentation | 📅 Roadmap |

---

## Privacy & Security

- **Self-hosted**: All data stays in your infrastructure. Nothing leaves your machine.
- **Local Neo4j**: Graph database runs in Docker on your own hardware.
- **Credential isolation**: API tokens stored in `~/.memoryos/config/.env`, never logged.
- **Role-aware**: Respects source system permissions — if Slack marks a channel private, MemoryOS only indexes it if the bot is invited.

---

## Reflection Engine

MemoryOS includes a self-monitoring reflection pass that runs every hour and detects gaps:

- **Orphaned decisions** — rationale captured but no supporting evidence
- **Unlinked cross-references** — "PROJ-123" mentioned in Slack but not in the graph
- **Missing rationale** — high-activity tickets with no decision nodes
- **Isolated artifacts** — documents with zero graph relationships

```bash
memoryos gaps    # view current gaps + prioritized action plan
```

---

## License

Apache 2.0 — use freely in commercial environments.

---

*MemoryOS is built on:  Neo4j · Anthropic Claude · Model Context Protocol · TypeScript*
