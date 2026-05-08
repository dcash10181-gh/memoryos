import { ArtifactNode, PersonNode, DecisionNode, ContextNode } from '../graph/schema.js';

// ─── Raw ingestion event emitted by every connector ──────────────────────────
export interface RawIngestionEvent {
  source: string;
  external_id: string;
  type: 'message' | 'pr' | 'ticket' | 'document' | 'email' | 'commit' | 'comment';
  title?: string;
  body: string;
  author_external_id?: string;
  author_name?: string;
  author_email?: string;
  url?: string;
  created_at: string;
  updated_at?: string;
  thread_id?: string;       // Slack thread, email reply chain, PR review thread
  parent_id?: string;       // For nested items (comment → ticket, reply → message)
  references?: string[];    // External IDs this item explicitly mentions/links
  metadata?: Record<string, unknown>;
}

// ─── Sync cursor for incremental indexing ────────────────────────────────────
export interface SyncCursor {
  connector: string;
  last_synced_at: string;   // ISO8601
  checkpoint?: string;      // Connector-specific (page token, message ts, etc.)
}

// ─── What every connector must implement ─────────────────────────────────────
export interface Connector {
  /** Human-readable name shown in logs and CLI */
  readonly name: string;

  /** Called once on daemon start to verify credentials and connectivity */
  validate(): Promise<boolean>;

  /**
   * Full historical backfill (first-run or forced --full sync).
   * Should emit events via the provided callback rather than returning all at once
   * to avoid OOM on large workspaces.
   */
  fullSync(emit: (event: RawIngestionEvent) => Promise<void>): Promise<void>;

  /**
   * Incremental sync since cursor.last_synced_at.
   * Called every daemon.sync_interval seconds.
   */
  incrementalSync(
    cursor: SyncCursor,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<SyncCursor>;
}

// ─── Processed output after pipeline transforms raw events ───────────────────
export interface ProcessedEvent {
  artifact: ArtifactNode;
  persons: PersonNode[];
  extractedDecisions: DecisionNode[];
  extractedContexts: ContextNode[];
  relationships: Array<{
    from: string; fromLabel: string;
    to: string;   toLabel: string;
    type: string;
    props?: Record<string, unknown>;
  }>;
}
