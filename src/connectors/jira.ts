import axios, { AxiosInstance } from 'axios';
import { Connector, RawIngestionEvent, SyncCursor } from './base.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/loader.js';

type JiraConfig = {
  host: string;
  email: string;
  token: string;
  projects: string[];
  lookback_days?: number;
};

export class JiraConnector implements Connector {
  readonly name = 'jira';
  private http: AxiosInstance;
  private cfg: JiraConfig;

  constructor() {
    const raw = getConfig().connectors.jira as JiraConfig;
    this.cfg = raw;
    this.http = axios.create({
      baseURL: `${raw.host}/rest/api/3`,
      auth: { username: raw.email, password: raw.token },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
  }

  async validate(): Promise<boolean> {
    try {
      const { data } = await this.http.get('/myself');
      logger.info({ displayName: data.displayName }, '[jira] Connected');
      return true;
    } catch (err) {
      logger.error({ err }, '[jira] Validation failed — check JIRA_EMAIL and JIRA_TOKEN');
      return false;
    }
  }

  // ─── JQL-based paginated search ───────────────────────────────────────────
  private async searchIssues(jql: string): Promise<unknown[]> {
    const results: unknown[] = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const { data } = await this.http.post('/search', {
        jql,
        startAt,
        maxResults,
        fields: ['summary', 'description', 'comment', 'status', 'priority', 'labels',
                 'assignee', 'reporter', 'created', 'updated', 'issuetype',
                 'customfield_10014', // Epic link
                 'customfield_10016', // Story points
        ],
        expand: ['renderedFields'],
      });

      results.push(...data.issues);
      if (results.length >= data.total || data.issues.length === 0) break;
      startAt += maxResults;
    }

    return results;
  }

  private buildJQL(since?: string): string {
    const projectFilter = this.cfg.projects?.length > 0
      ? `project IN (${this.cfg.projects.join(',')})` : 'project IS NOT EMPTY';

    const timeFilter = since
      ? `AND updated >= "${since.substring(0, 10)}"`
      : `AND created >= "-${this.cfg.lookback_days ?? 90}d"`;

    return `${projectFilter} ${timeFilter} ORDER BY updated DESC`;
  }

  async fullSync(emit: (event: RawIngestionEvent) => Promise<void>): Promise<void> {
    logger.info('[jira] Starting full sync');
    const issues = await this.searchIssues(this.buildJQL());

    for (const issue of issues) {
      await this.emitIssue(issue as Record<string, unknown>, emit);
    }
  }

  async incrementalSync(
    cursor: SyncCursor,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<SyncCursor> {
    const issues = await this.searchIssues(this.buildJQL(cursor.last_synced_at));
    for (const issue of issues) {
      await this.emitIssue(issue as Record<string, unknown>, emit);
    }
    return { connector: this.name, last_synced_at: new Date().toISOString() };
  }

  private async emitIssue(
    issue: Record<string, unknown>,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    const fields = issue.fields as Record<string, unknown>;
    const key = issue.key as string;
    const description = this.extractText(fields.description);
    const reporter = (fields.reporter as Record<string, string> | null)?.emailAddress;
    const assignee = (fields.assignee as Record<string, string> | null)?.emailAddress;

    await emit({
      source: 'jira',
      external_id: key,
      type: 'ticket',
      title: fields.summary as string,
      body: description,
      url: `${this.cfg.host}/browse/${key}`,
      author_external_id: reporter,
      author_email: reporter,
      created_at: fields.created as string,
      updated_at: fields.updated as string,
      metadata: {
        key,
        status: (fields.status as Record<string, string>)?.name,
        priority: (fields.priority as Record<string, string>)?.name,
        labels: fields.labels,
        assignee,
        issue_type: (fields.issuetype as Record<string, string>)?.name,
      },
    });

    // Emit comments separately — they often contain the real decision rationale
    const comments = ((fields.comment as Record<string, unknown>)?.comments ?? []) as Array<Record<string, unknown>>;
    for (const comment of comments) {
      const commentBody = this.extractText(comment.body);
      if (!commentBody) continue;

      await emit({
        source: 'jira',
        external_id: `${key}::comment::${comment.id}`,
        type: 'comment',
        body: commentBody,
        author_email: (comment.author as Record<string, string>)?.emailAddress,
        created_at: comment.created as string,
        parent_id: key,
        thread_id: key,
        metadata: { key, comment_id: comment.id },
      });
    }
  }

  // ─── Jira Atlassian Document Format → plain text ──────────────────────────
  private extractText(adf: unknown): string {
    if (!adf || typeof adf !== 'object') return '';
    const node = adf as Record<string, unknown>;
    if (node.type === 'text') return (node.text as string) ?? '';
    if (Array.isArray(node.content)) {
      return (node.content as unknown[]).map(c => this.extractText(c)).join(' ');
    }
    return '';
  }
}
