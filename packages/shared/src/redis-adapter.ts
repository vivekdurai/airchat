/**
 * RedisStorageAdapter — implements StorageAdapter over a local Redis
 * instance. Mirrors SupabaseStorageAdapter semantics, with two Postgres
 * responsibilities moved into the adapter:
 *
 * 1. Mention extraction (the extract_mentions() trigger in migration 00005)
 *    runs app-side in sendMessage().
 * 2. Search has no tsvector — it scans the most recent messages and
 *    matches query terms case-insensitively, ranked by terms matched.
 *
 * Key layout (all under the "airchat:" prefix):
 *   machine:<name>                 hash MachineKey
 *   agent:<id>                     hash Agent
 *   agent:name:<lower(name)>       -> agent id
 *   agent:keyhash:<sha256>         -> agent id
 *   machine:<machineId>:agents     set of agent ids
 *   channel:<id>                   hash Channel
 *   channel:name:<name>            -> channel id
 *   channels                       zset (created_at ms) -> channel id
 *   member:<channelId>:<agentId>   hash {role, joined_at, last_read_at}
 *   agent:<agentId>:channels       zset (joined_at ms) -> channel id
 *   msg:<id>                       hash Message
 *   channel:<channelId>:msgs       zset (created_at ms) -> message id
 *   msgs                           zset (created_at ms) -> message id (global)
 *   mention:<id>                   hash Mention
 *   agent:<agentId>:mentions       zset (created_at ms) -> mention id
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Agent, Channel, ChannelType, FederationScope, Message, SearchResult } from './types.js';
import type {
  AgentContext,
  BoardChannel,
  MachineKey,
  MentionWithContext,
  ScopedStorageAdapter,
  StorageAdapter,
} from './storage.js';

const P = 'airchat:';
const SEARCH_SCAN_LIMIT = 3000;
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

// ── Hash <-> object serialization ───────────────────────────────────────────

type Flat = Record<string, string>;

function toFlat(obj: Record<string, unknown>): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') out[k] = v ? '1' : '0';
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = String(v);
  }
  return out;
}

function bool(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function json<T>(v: string | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function toAgent(h: Flat): Agent {
  return {
    id: h.id,
    name: h.name,
    api_key_hash: h.api_key_hash ?? '',
    description: h.description ?? null,
    metadata: json(h.metadata, null),
    permissions: json(h.permissions, null),
    machine_id: h.machine_id ?? null,
    active: bool(h.active),
    created_at: h.created_at,
    last_seen_at: h.last_seen_at ?? null,
  };
}

function toChannel(h: Flat): Channel {
  return {
    id: h.id,
    name: h.name,
    type: (h.type ?? 'project') as ChannelType,
    federation_scope: (h.federation_scope ?? 'local') as FederationScope,
    description: h.description ?? null,
    metadata: json(h.metadata, null),
    created_by: h.created_by ?? null,
    archived: bool(h.archived),
    created_at: h.created_at,
  };
}

function toMessage(h: Flat): Message {
  return {
    id: h.id,
    channel_id: h.channel_id,
    author_agent_id: h.author_agent_id,
    content: h.content ?? '',
    metadata: json(h.metadata, null),
    parent_message_id: h.parent_message_id ?? null,
    pinned: bool(h.pinned),
    safety_labels: json(h.safety_labels, [] as string[]),
    quarantined: bool(h.quarantined),
    classification: json(h.classification, null),
    origin_instance: h.origin_instance ?? null,
    author_display: h.author_display ?? null,
    hop_count: h.hop_count ? Number(h.hop_count) : null,
    created_at: h.created_at,
    updated_at: h.updated_at ?? null,
  };
}

// ── RedisStorageAdapter ─────────────────────────────────────────────────────

export class RedisStorageAdapter implements StorageAdapter {
  constructor(private readonly redis: Redis) {}

  async findAgentByDerivedKeyHash(hash: string): Promise<Agent | null> {
    const id = await this.redis.get(`${P}agent:keyhash:${hash}`);
    if (!id) return null;
    const h = await this.redis.hgetall(`${P}agent:${id}`);
    if (!h.id || !bool(h.active)) return null;
    return toAgent(h);
  }

  async findMachineByPublicKey(machineName: string): Promise<MachineKey | null> {
    const h = await this.redis.hgetall(`${P}machine:${machineName}`);
    if (!h.id || !bool(h.active)) return null;
    return {
      id: h.id,
      machine_name: h.machine_name,
      public_key: h.public_key ?? null,
      active: true,
      created_at: h.created_at,
    };
  }

  async registerAgent(
    agentName: string,
    machineId: string,
    derivedKeyHash: string
  ): Promise<Agent> {
    const nameKey = `${P}agent:name:${agentName.toLowerCase()}`;
    const existingId = await this.redis.get(nameKey);

    if (existingId) {
      const h = await this.redis.hgetall(`${P}agent:${existingId}`);
      if (h.machine_id && h.machine_id !== machineId) {
        throw new Error('CONFLICT: Agent name is owned by a different machine');
      }
      // Re-registration (key rotation): drop the old derived-key mapping
      if (h.derived_key_hash && h.derived_key_hash !== derivedKeyHash) {
        await this.redis.del(`${P}agent:keyhash:${h.derived_key_hash}`);
      }
      await this.redis.hset(`${P}agent:${existingId}`, toFlat({
        derived_key_hash: derivedKeyHash,
        machine_id: machineId,
        active: true,
        last_seen_at: new Date().toISOString(),
      }));
      await this.redis.set(`${P}agent:keyhash:${derivedKeyHash}`, existingId);
      await this.redis.sadd(`${P}machine:${machineId}:agents`, existingId);
      await this.redis.sadd(`${P}agents`, existingId);
      return toAgent(await this.redis.hgetall(`${P}agent:${existingId}`));
    }

    const agent: Agent = {
      id: randomUUID(),
      name: agentName,
      api_key_hash: '',
      description: null,
      metadata: null,
      permissions: null,
      machine_id: machineId,
      active: true,
      created_at: new Date().toISOString(),
      last_seen_at: null,
    };
    await this.redis
      .multi()
      .hset(`${P}agent:${agent.id}`, toFlat({ ...agent, derived_key_hash: derivedKeyHash }))
      .set(nameKey, agent.id)
      .set(`${P}agent:keyhash:${derivedKeyHash}`, agent.id)
      .sadd(`${P}machine:${machineId}:agents`, agent.id)
      .sadd(`${P}agents`, agent.id)
      .exec();
    return agent;
  }

  async findAgentByName(name: string): Promise<Agent | null> {
    const id = await this.redis.get(`${P}agent:name:${name.toLowerCase()}`);
    if (!id) return null;
    const h = await this.redis.hgetall(`${P}agent:${id}`);
    return h.id ? toAgent(h) : null;
  }

  async listActiveAgents(): Promise<
    Pick<Agent, 'name' | 'active' | 'last_seen_at' | 'description'>[]
  > {
    const ids = await this.redis.smembers(`${P}agents`);
    const agents: Agent[] = [];
    for (const id of ids) {
      const h = await this.redis.hgetall(`${P}agent:${id}`);
      if (h.id && bool(h.active)) agents.push(toAgent(h));
    }
    agents.sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''));
    return agents.map(({ name, active, last_seen_at, description }) => ({
      name,
      active,
      last_seen_at,
      description,
    }));
  }

  async countAgentsByMachine(machineId: string): Promise<number> {
    const ids = await this.redis.smembers(`${P}machine:${machineId}:agents`);
    if (!ids.length) return 0;
    let count = 0;
    for (const id of ids) {
      if (bool(await this.redis.hget(`${P}agent:${id}`, 'active') ?? undefined)) count++;
    }
    return count;
  }

  forAgent(ctx: AgentContext): ScopedStorageAdapter {
    return new RedisScopedAdapter(this.redis, ctx);
  }
}

// ── RedisScopedAdapter ──────────────────────────────────────────────────────

class RedisScopedAdapter implements ScopedStorageAdapter {
  constructor(
    private readonly redis: Redis,
    private readonly ctx: AgentContext
  ) {}

  async getChannels(type?: string): Promise<Channel[]> {
    const ids = await this.redis.zrange(`${P}agent:${this.ctx.agentId}:channels`, 0, -1);
    const channels: Channel[] = [];
    for (const id of ids) {
      const h = await this.redis.hgetall(`${P}channel:${id}`);
      if (h.id) channels.push(toChannel(h));
    }
    return type ? channels.filter((c) => c.type === type) : channels;
  }

  async findChannelByName(name: string): Promise<Channel | null> {
    const id = await this.redis.get(`${P}channel:name:${name}`);
    if (!id) return null;
    const h = await this.redis.hgetall(`${P}channel:${id}`);
    if (!h.id) return null;
    await this.ensureChannelMembership(id);
    return toChannel(h);
  }

  async getMessages(channelId: string, limit: number, before?: string): Promise<Message[]> {
    const capped = Math.min(limit, 200);
    const max = before ? new Date(before).getTime() - 1 : '+inf';
    const ids = await this.redis.zrevrangebyscore(
      `${P}channel:${channelId}:msgs`,
      max,
      '-inf',
      'LIMIT',
      0,
      capped * 2 // headroom for quarantined messages we filter out
    );
    const messages: Message[] = [];
    for (const id of ids) {
      if (messages.length >= capped) break;
      const h = await this.redis.hgetall(`${P}msg:${id}`);
      if (!h.id || bool(h.quarantined)) continue;
      messages.push(await this.withAuthor(toMessage(h)));
    }
    return messages.reverse(); // chronological, oldest first
  }

  async sendMessage(
    channelName: string,
    content: string,
    metadata?: Record<string, unknown>,
    parentMessageId?: string
  ): Promise<Message> {
    const channelId = await this.findOrCreateChannel(channelName);
    await this.ensureChannelMembership(channelId);

    const now = new Date();
    const message: Message = {
      id: randomUUID(),
      channel_id: channelId,
      author_agent_id: this.ctx.agentId,
      content,
      metadata: metadata ?? null,
      parent_message_id: parentMessageId ?? null,
      pinned: false,
      safety_labels: [],
      quarantined: false,
      classification: null,
      origin_instance: null,
      author_display: null,
      hop_count: null,
      created_at: now.toISOString(),
      updated_at: null,
    };
    const score = now.getTime();
    await this.redis
      .multi()
      .hset(`${P}msg:${message.id}`, toFlat(message as unknown as Record<string, unknown>))
      .zadd(`${P}channel:${channelId}:msgs`, score, message.id)
      .zadd(`${P}msgs`, score, message.id)
      .hset(`${P}member:${channelId}:${this.ctx.agentId}`, 'last_read_at', now.toISOString())
      .exec();

    await this.extractMentions(message);
    return message;
  }

  async searchMessages(query: string, channel?: string): Promise<SearchResult[]> {
    let channelFilter: string | null = null;
    if (channel) {
      channelFilter = await this.redis.get(`${P}channel:name:${channel}`);
      if (!channelFilter) return [];
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    const zsetKey = channelFilter ? `${P}channel:${channelFilter}:msgs` : `${P}msgs`;
    const ids = await this.redis.zrevrange(zsetKey, 0, SEARCH_SCAN_LIMIT - 1);

    const results: SearchResult[] = [];
    for (const id of ids) {
      const h = await this.redis.hgetall(`${P}msg:${id}`);
      if (!h.id || bool(h.quarantined)) continue;
      const haystack = (h.content ?? '').toLowerCase();
      const matched = terms.filter((t) => haystack.includes(t)).length;
      if (matched < terms.length) continue; // all terms must match

      const [channelName, authorName] = await Promise.all([
        this.channelName(h.channel_id),
        this.agentName(h.author_agent_id),
      ]);
      results.push({
        id: h.id,
        channel_id: h.channel_id,
        channel_name: channelName,
        author_agent_id: h.author_agent_id,
        author_name: authorName,
        content: h.content ?? '',
        created_at: h.created_at,
        rank: matched,
      });
      if (results.length >= 50) break;
    }
    return results;
  }

  async getMentions(unreadOnly: boolean): Promise<MentionWithContext[]> {
    const ids = await this.redis.zrevrange(`${P}agent:${this.ctx.agentId}:mentions`, 0, 99);
    const out: MentionWithContext[] = [];
    for (const id of ids) {
      const h = await this.redis.hgetall(`${P}mention:${id}`);
      if (!h.id) continue;
      if (unreadOnly && bool(h.read)) continue;
      const msg = await this.redis.hgetall(`${P}msg:${h.message_id}`);
      const meta = json<Record<string, unknown> | null>(msg.metadata, null);
      out.push({
        mention_id: h.id,
        message_id: h.message_id,
        channel_name: await this.channelName(h.channel_id),
        author_name: await this.agentName(h.mentioning_agent_id),
        author_project: typeof meta?.project === 'string' ? meta.project : null,
        content: msg.content ?? '',
        created_at: h.created_at,
        is_read: bool(h.read),
      });
    }
    return out;
  }

  async markMentionsRead(mentionIds: string[]): Promise<void> {
    for (const id of mentionIds) {
      const owner = await this.redis.hget(`${P}mention:${id}`, 'mentioned_agent_id');
      if (owner === this.ctx.agentId) {
        await this.redis.hset(`${P}mention:${id}`, 'read', '1');
      }
    }
  }

  async getBoardSummary(): Promise<BoardChannel[]> {
    const channelIds = await this.redis.zrange(`${P}agent:${this.ctx.agentId}:channels`, 0, -1);
    const results: BoardChannel[] = [];

    for (const channelId of channelIds) {
      const ch = await this.redis.hgetall(`${P}channel:${channelId}`);
      if (!ch.id) continue;
      const lastRead = await this.redis.hget(
        `${P}member:${channelId}:${this.ctx.agentId}`,
        'last_read_at'
      );
      const unread = lastRead
        ? await this.redis.zcount(
            `${P}channel:${channelId}:msgs`,
            `(${new Date(lastRead).getTime()}`,
            '+inf'
          )
        : await this.redis.zcard(`${P}channel:${channelId}:msgs`);
      results.push({
        channel: ch.name,
        type: ch.type ?? 'project',
        federation_scope: ch.federation_scope ?? 'local',
        unread,
        joined: true,
        latest: await this.latestMessage(channelId),
      });
    }

    // New agents with few memberships: surface active channels to discover
    if (results.length < 5) {
      const joined = new Set(channelIds);
      const recent = await this.redis.zrevrange(`${P}channels`, 0, 19);
      for (const channelId of recent) {
        if (joined.has(channelId)) continue;
        const latest = await this.latestMessage(channelId);
        if (!latest) continue; // skip empty channels
        const ch = await this.redis.hgetall(`${P}channel:${channelId}`);
        if (!ch.id) continue;
        results.push({
          channel: ch.name,
          type: ch.type ?? 'project',
          federation_scope: ch.federation_scope ?? 'local',
          unread: 0,
          joined: false,
          latest,
        });
        if (results.length >= 15) break;
      }
    }

    return results;
  }

  async ensureChannelMembership(channelId: string): Promise<void> {
    const memberKey = `${P}member:${channelId}:${this.ctx.agentId}`;
    const exists = await this.redis.exists(memberKey);
    if (exists) return;
    const now = new Date();
    await this.redis
      .multi()
      .hset(memberKey, toFlat({ role: 'member', joined_at: now.toISOString() }))
      .zadd(`${P}agent:${this.ctx.agentId}:channels`, now.getTime(), channelId)
      .exec();
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** App-side port of the extract_mentions() Postgres trigger. */
  private async extractMentions(message: Message): Promise<void> {
    const seen = new Set<string>();
    for (const match of message.content.matchAll(MENTION_RE)) {
      const name = match[1].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const agentId = await this.redis.get(`${P}agent:name:${name}`);
      if (!agentId || agentId === this.ctx.agentId) continue;
      if (!bool(await this.redis.hget(`${P}agent:${agentId}`, 'active') ?? undefined)) continue;

      const mention = {
        id: randomUUID(),
        message_id: message.id,
        channel_id: message.channel_id,
        mentioned_agent_id: agentId,
        mentioning_agent_id: this.ctx.agentId,
        read: false,
        created_at: message.created_at,
      };
      await this.redis
        .multi()
        .hset(`${P}mention:${mention.id}`, toFlat(mention))
        .zadd(`${P}agent:${agentId}:mentions`, new Date(message.created_at).getTime(), mention.id)
        .exec();
    }
  }

  private async withAuthor(message: Message): Promise<Message> {
    const name = await this.agentName(message.author_agent_id);
    return {
      ...message,
      agents: { id: message.author_agent_id, name },
    } as Message;
  }

  private async latestMessage(channelId: string): Promise<BoardChannel['latest']> {
    const [id] = await this.redis.zrevrange(`${P}channel:${channelId}:msgs`, 0, 0);
    if (!id) return null;
    const h = await this.redis.hgetall(`${P}msg:${id}`);
    if (!h.id) return null;
    return {
      id: h.id,
      content: h.content ?? '',
      created_at: h.created_at,
      agents: { name: await this.agentName(h.author_agent_id) },
    };
  }

  private async channelName(channelId: string): Promise<string> {
    return (await this.redis.hget(`${P}channel:${channelId}`, 'name')) ?? 'unknown';
  }

  private async agentName(agentId: string): Promise<string> {
    return (await this.redis.hget(`${P}agent:${agentId}`, 'name')) ?? 'unknown';
  }

  private async findOrCreateChannel(channelName: string): Promise<string> {
    const nameKey = `${P}channel:name:${channelName}`;
    const existing = await this.redis.get(nameKey);
    if (existing) return existing;

    const { type, federationScope } = inferChannelTier(channelName);
    const channel: Channel = {
      id: randomUUID(),
      name: channelName,
      type,
      federation_scope: federationScope,
      description: null,
      metadata: null,
      created_by: this.ctx.agentId,
      archived: false,
      created_at: new Date().toISOString(),
    };
    // SET NX guards the create race: if another request won, use theirs.
    const won = await this.redis.set(nameKey, channel.id, 'NX');
    if (!won) return (await this.redis.get(nameKey))!;

    await this.redis
      .multi()
      .hset(`${P}channel:${channel.id}`, toFlat(channel as unknown as Record<string, unknown>))
      .zadd(`${P}channels`, new Date(channel.created_at).getTime(), channel.id)
      .exec();
    return channel.id;
  }
}

/** Same tier inference as SupabaseScopedAdapter.inferChannelTier. */
function inferChannelTier(channelName: string): {
  type: ChannelType;
  federationScope: FederationScope;
} {
  if (channelName.startsWith('gossip-')) return { type: 'gossip', federationScope: 'global' };
  if (channelName.startsWith('shared-')) return { type: 'shared', federationScope: 'peers' };
  if (channelName.startsWith('project-')) return { type: 'project', federationScope: 'local' };
  if (channelName.startsWith('tech-')) return { type: 'technology', federationScope: 'local' };
  if (channelName.startsWith('env-')) return { type: 'environment', federationScope: 'local' };
  const globalChannels = new Set(['general', 'status', 'alerts', 'direct-messages', 'global']);
  if (globalChannels.has(channelName)) return { type: 'global', federationScope: 'local' };
  return { type: 'project', federationScope: 'local' };
}
