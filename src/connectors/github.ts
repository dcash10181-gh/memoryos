import axios, { AxiosInstance } from 'axios';
import { Connector, RawIngestionEvent, SyncCursor } from './base.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/loader.js';

type GitHubConfig = {
  token: string;
  org: string;
  repos: string[];
  lookback_days: number;
};

export class GitHubConnector implements Connector {
  readonly name = 'github';
  private http: AxiosInstance;
  private cfg: GitHubConfig;

  constructor() {
    const raw = getConfig().connectors.github as GitHubConfig;
    this.cfg = raw;
    this.http = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${raw.token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  async validate(): Promise<boolean> {
    try {
      const { data } = await this.http.get('/user');
      logger.info({ login: data.login }, '[github] Connected');
      return true;
    } catch (err) {
      logger.error({ err }, '[github] Validation failed — check GITHUB_TOKEN');
      return false;
    }
  }

  // ─── Paginate GitHub API with Link header ─────────────────────────────────
  private async paginate<T>(url: string, params: Record<string, string | number> = {}): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      const { data, headers } = await this.http.get<T[]>(nextUrl, {
        params: nextUrl === url ? { per_page: 100, ...params } : undefined,
      });
      results.push(...data);

      const link = headers['link'] as string | undefined;
      const match = link?.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
    }

    return results;
  }

  private async listRepos(): Promise<string[]> {
    if (this.cfg.repos?.length > 0) return this.cfg.repos;
    const repos = await this.paginate<{ full_name: string }>(`/orgs/${this.cfg.org}/repos`);
    return repos.map(r => r.full_name);
  }

  // ─── Pull Requests: most critical for architectural decision context ───────
  private async syncPullRequests(
    repo: string,
    since: string,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    const prs = await this.paginate<{
      number: number; title: string; body: string | null; html_url: string;
      user: { login: string; email?: string };
      created_at: string; updated_at: string; merged_at: string | null;
      base: { ref: string }; head: { ref: string };
    }>(`/repos/${repo}/pulls`, { state: 'all', sort: 'updated', direction: 'desc' });

    for (const pr of prs) {
      if (pr.updated_at < since) break;

      const body = [pr.body ?? '', `Base: ${pr.base.ref}`, `Head: ${pr.head.ref}`].filter(Boolean).join('\n\n');

      await emit({
        source: 'github',
        external_id: `${repo}::pr::${pr.number}`,
        type: 'pr',
        title: pr.title,
        body,
        url: pr.html_url,
        author_external_id: pr.user.login,
        author_name: pr.user.login,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        metadata: { repo, pr_number: pr.number, merged: !!pr.merged_at, base_branch: pr.base.ref },
      });

      // PR review comments contain the "why we changed this" rationale
      await this.syncPRReviewComments(repo, pr.number, emit);
    }
  }

  private async syncPRReviewComments(
    repo: string,
    prNumber: number,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    const comments = await this.paginate<{
      id: number; body: string; user: { login: string };
      created_at: string; pull_request_review_id: number | null;
      path?: string; diff_hunk?: string;
    }>(`/repos/${repo}/pulls/${prNumber}/comments`);

    for (const c of comments) {
      if (!c.body?.trim()) continue;
      await emit({
        source: 'github',
        external_id: `${repo}::pr_comment::${c.id}`,
        type: 'comment',
        body: c.body,
        author_external_id: c.user.login,
        created_at: c.created_at,
        parent_id: `${repo}::pr::${prNumber}`,
        thread_id: `${repo}::pr::${prNumber}`,
        metadata: { repo, pr_number: prNumber, file_path: c.path, diff_hunk: c.diff_hunk },
      });
    }
  }

  // ─── Issues: captures feature requests, bug rationale, architectural debates
  private async syncIssues(
    repo: string,
    since: string,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    const issues = await this.paginate<{
      number: number; title: string; body: string | null; html_url: string;
      user: { login: string }; created_at: string; updated_at: string;
      labels: { name: string }[];
      pull_request?: object;   // Issues API returns PRs too — filter them out
    }>(`/repos/${repo}/issues`, { state: 'all', sort: 'updated', direction: 'desc', since });

    for (const issue of issues) {
      if (issue.pull_request) continue;  // skip — already captured via pulls endpoint

      await emit({
        source: 'github',
        external_id: `${repo}::issue::${issue.number}`,
        type: 'ticket',
        title: issue.title,
        body: issue.body ?? '',
        url: issue.html_url,
        author_external_id: issue.user.login,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        metadata: { repo, issue_number: issue.number, labels: issue.labels.map(l => l.name) },
      });
    }
  }

  // ─── Commit messages: compressed decisions, architectural intent ──────────
  private async syncCommits(
    repo: string,
    since: string,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    const commits = await this.paginate<{
      sha: string; commit: {
        message: string; author: { name: string; email: string; date: string };
      }; html_url: string;
    }>(`/repos/${repo}/commits`, { since });

    for (const c of commits) {
      const msg = c.commit.message;
      if (msg.length < 20) continue;  // Skip trivial commits

      await emit({
        source: 'github',
        external_id: `${repo}::commit::${c.sha}`,
        type: 'commit',
        body: msg,
        url: c.html_url,
        author_name: c.commit.author.name,
        author_email: c.commit.author.email,
        created_at: c.commit.author.date,
        metadata: { repo, sha: c.sha.substring(0, 8) },
      });
    }
  }

  async fullSync(emit: (event: RawIngestionEvent) => Promise<void>): Promise<void> {
    const repos = await this.listRepos();
    const since = new Date(Date.now() - (this.cfg.lookback_days ?? 90) * 86_400_000).toISOString();

    for (const repo of repos) {
      logger.info(`[github] Full sync: ${repo}`);
      await Promise.allSettled([
        this.syncPullRequests(repo, since, emit),
        this.syncIssues(repo, since, emit),
        this.syncCommits(repo, since, emit),
      ]);
    }
  }

  async incrementalSync(
    cursor: SyncCursor,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<SyncCursor> {
    const repos = await this.listRepos();
    for (const repo of repos) {
      await Promise.allSettled([
        this.syncPullRequests(repo, cursor.last_synced_at, emit),
        this.syncIssues(repo, cursor.last_synced_at, emit),
        this.syncCommits(repo, cursor.last_synced_at, emit),
      ]);
    }
    return { connector: this.name, last_synced_at: new Date().toISOString() };
  }
}
