import { WebClient } from '@slack/web-api';
import { Connector, RawIngestionEvent, SyncCursor } from './base.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/loader.js';

type SlackConfig = {
  bot_token: string;
  app_token?: string;
  channels: string[];
  lookback_days: number;
};

export class SlackConnector implements Connector {
  readonly name = 'slack';
  private client: WebClient;
  private cfg: SlackConfig;

  constructor() {
    const raw = getConfig().connectors.slack as SlackConfig;
    this.cfg = raw;
    this.client = new WebClient(raw.bot_token);
  }

  async validate(): Promise<boolean> {
    try {
      const res = await this.client.auth.test();
      logger.info({ team: res.team, bot_user: res.user }, '[slack] Connected');
      return true;
    } catch (err) {
      logger.error({ err }, '[slack] Validation failed — check SLACK_BOT_TOKEN');
      return false;
    }
  }

  // ─── List all channels the bot has access to ─────────────────────────────
  private async listChannels(): Promise<string[]> {
    if (this.cfg.channels?.length > 0) return this.cfg.channels;

    const channelIds: string[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
        cursor,
      });

      (res.channels ?? []).forEach((ch: { id?: string; is_member?: boolean }) => {
        if (ch.id && ch.is_member) channelIds.push(ch.id);
      });

      cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor ?? undefined;
    } while (cursor);

    logger.info(`[slack] Discovered ${channelIds.length} channels`);
    return channelIds;
  }

  // ─── Fetch messages for a channel within a time window ───────────────────
  private async fetchMessages(
    channelId: string,
    oldest: number,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const res = await this.client.conversations.history({
        channel: channelId,
        oldest: String(oldest),
        limit: 200,
        cursor,
      });

      const messages = res.messages ?? [];

      for (const msg of messages) {
        if (msg.subtype || !msg.text || !msg.ts) continue;

        const event: RawIngestionEvent = {
          source: 'slack',
          external_id: `${channelId}::${msg.ts}`,
          type: 'message',
          body: msg.text,
          author_external_id: msg.user,
          created_at: new Date(parseFloat(msg.ts) * 1000).toISOString(),
          thread_id: msg.thread_ts ? `${channelId}::${msg.thread_ts}` : undefined,
          metadata: { channel: channelId, reactions: msg.reactions ?? [] },
        };

        // If this is a thread root, also fetch thread replies for full context
        if (msg.thread_ts === msg.ts && (msg.reply_count ?? 0) > 0) {
          await this.fetchThreadReplies(channelId, msg.thread_ts!, emit);
        }

        await emit(event);
      }

      cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor ?? undefined;
    } while (cursor);
  }

  // ─── Thread replies carry critical decision rationale context ─────────────
  private async fetchThreadReplies(
    channelId: string,
    threadTs: string,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        cursor,
      });

      for (const reply of res.messages ?? []) {
        if (reply.ts === threadTs || !reply.text || !reply.ts) continue;
        await emit({
          source: 'slack',
          external_id: `${channelId}::${reply.ts}`,
          type: 'comment',
          body: reply.text,
          author_external_id: reply.user,
          created_at: new Date(parseFloat(reply.ts) * 1000).toISOString(),
          thread_id: `${channelId}::${threadTs}`,
          parent_id: `${channelId}::${threadTs}`,
          metadata: { channel: channelId },
        });
      }

      cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor ?? undefined;
    } while (cursor);
  }

  // ─── Resolve Slack user IDs to profile info ───────────────────────────────
  async resolveUser(userId: string): Promise<{ name: string; email?: string; title?: string } | null> {
    try {
      const res = await this.client.users.info({ user: userId });
      const profile = res.user?.profile;
      return {
        name: profile?.real_name ?? profile?.display_name ?? userId,
        email: profile?.email,
        title: profile?.title,
      };
    } catch {
      return null;
    }
  }

  // ─── Full historical backfill ─────────────────────────────────────────────
  async fullSync(emit: (event: RawIngestionEvent) => Promise<void>): Promise<void> {
    const channels = await this.listChannels();
    const oldest = Date.now() / 1000 - this.cfg.lookback_days * 86_400;

    for (const channelId of channels) {
      logger.info(`[slack] Full sync: channel ${channelId}`);
      try {
        await this.fetchMessages(channelId, oldest, emit);
      } catch (err) {
        logger.warn({ err, channelId }, '[slack] Channel sync failed — skipping');
      }
    }
  }

  // ─── Incremental sync since last cursor ───────────────────────────────────
  async incrementalSync(
    cursor: SyncCursor,
    emit: (event: RawIngestionEvent) => Promise<void>
  ): Promise<SyncCursor> {
    const channels = await this.listChannels();
    const oldest = new Date(cursor.last_synced_at).getTime() / 1000;

    for (const channelId of channels) {
      try {
        await this.fetchMessages(channelId, oldest, emit);
      } catch (err) {
        logger.warn({ err, channelId }, '[slack] Incremental channel sync failed');
      }
    }

    return { connector: this.name, last_synced_at: new Date().toISOString() };
  }
}
