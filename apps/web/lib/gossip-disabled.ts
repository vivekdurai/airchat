/**
 * DisabledGossipAdapter — a GossipStorageAdapter for storage backends that
 * do not support federation (currently the Redis backend). Read endpoints
 * degrade gracefully (no identity, no peers, no quarantine); write
 * operations throw so callers surface a clear error instead of silently
 * dropping federation traffic.
 */

import type {
  GossipInstanceConfig,
  GossipPeer,
  GossipRetraction,
  GossipStorageAdapter,
  QuarantinedMessage,
} from '@airchat/shared';

const DISABLED = 'Federation is not supported by this storage backend';

export class DisabledGossipAdapter implements GossipStorageAdapter {
  async getInstanceConfig(): Promise<GossipInstanceConfig | null> {
    return null;
  }
  async updateInstanceConfig(): Promise<void> {
    throw new Error(DISABLED);
  }
  async listPeers(): Promise<GossipPeer[]> {
    return [];
  }
  async getPeerByFingerprint(): Promise<GossipPeer | null> {
    return null;
  }
  async getPeerById(): Promise<GossipPeer | null> {
    return null;
  }
  async addPeer(): Promise<GossipPeer> {
    throw new Error(DISABLED);
  }
  async updatePeer(): Promise<void> {
    throw new Error(DISABLED);
  }
  async removePeer(): Promise<void> {
    throw new Error(DISABLED);
  }
  async removePeerByEndpoint(): Promise<void> {
    throw new Error(DISABLED);
  }
  async upsertPeerByEndpoint(): Promise<void> {
    throw new Error(DISABLED);
  }
  async getFederatedMessages(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getRetractionsSince(): Promise<GossipRetraction[]> {
    return [];
  }
  async messageExists(): Promise<boolean> {
    return true; // treat inbound federated messages as duplicates: drop them
  }
  async findOrCreateChannelId(): Promise<string | null> {
    return null;
  }
  async findOrCreateRemoteAgent(): Promise<string | null> {
    return null;
  }
  async insertFederatedMessage(): Promise<boolean> {
    return false;
  }
  async trackMessageOrigin(): Promise<void> {
    throw new Error(DISABLED);
  }
  async storeRetraction(): Promise<void> {
    throw new Error(DISABLED);
  }
  async updateMessageLabels(): Promise<void> {
    throw new Error(DISABLED);
  }
  async quarantineMessage(): Promise<void> {
    throw new Error(DISABLED);
  }
  async quarantineMessagesBySuffix(): Promise<void> {
    throw new Error(DISABLED);
  }
  async listQuarantinedMessages(): Promise<{ messages: QuarantinedMessage[]; total: number }> {
    return { messages: [], total: 0 };
  }
  async approveMessages(): Promise<number> {
    return 0;
  }
  async deleteQuarantinedMessages(): Promise<number> {
    return 0;
  }
  async suspendPeer(): Promise<void> {
    throw new Error(DISABLED);
  }
  async getMessageIdsFromPeer(): Promise<string[]> {
    return [];
  }
  async countQuarantinedInIds(): Promise<number> {
    return 0;
  }
  async quarantineAllFromPeer(): Promise<void> {
    throw new Error(DISABLED);
  }
  async countRecentQuarantined(): Promise<number> {
    return 0;
  }
  async isAgentQuarantined(): Promise<boolean> {
    return false;
  }
  async quarantineAgent(): Promise<void> {
    throw new Error(DISABLED);
  }
  async clearExpiredAgentQuarantines(): Promise<void> {
    // no-op
  }
}
