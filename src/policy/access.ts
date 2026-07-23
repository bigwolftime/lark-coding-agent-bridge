import type { ProfileConfig } from '../config/profile-schema';
import { getRequireMentionInGroup, type AppConfig } from '../config/schema';
export { accessPolicyDigest } from './fingerprint';

export type OwnerRefreshState = 'ok' | 'failed' | 'unknown';

export interface RuntimeControls {
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
}

export interface AccessDecision {
  ok: boolean;
  reason:
    | 'owner'
    | 'allowed-team'
    | 'allowed-user'
    | 'allowed-admin'
    | 'allowed-group-user'
    | 'comment-mention'
    | 'denied-user'
    | 'denied-group-user'
    | 'denied-admin';
}

export function isCreator(controls: RuntimeControls, senderId: string): boolean {
  if (controls.ownerRefreshState === 'unknown') return false;
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId;
}

export function canUseDm(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  // Team mode opens direct-message access to everyone. Group messages still
  // go through groupAllowedUsers/groupDenyUsers in canUseGroup; admin commands
  // stay owner/admin-gated via canRunAdminCommand.
  if (profile.mode === 'team') return allow('allowed-team');
  if (profile.access.allowedUsers.includes(senderId)) return allow('allowed-user');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-user');
}

export function canUseGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
): AccessDecision {
  if (!chatId.trim() || !senderId.trim()) return deny('denied-group-user');
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (profile.access.groupDenyUsers[chatId]?.includes(senderId)) return deny('denied-group-user');
  if (profile.access.groupAllowedUsers[chatId]?.includes(senderId)) return allow('allowed-group-user');
  return deny('denied-group-user');
}

/**
 * Whether a group message must @-mention the bot to be handled. A per-chat
 * override (profile.access.chatRequireMention[chatId]) takes priority over the
 * global requireMentionInGroup (from cfg). p2p chats never call this.
 */
export function requireMentionForChat(
  profile: ProfileConfig,
  cfg: AppConfig,
  chatId: string,
): boolean {
  const override = profile.access.chatRequireMention?.[chatId];
  return typeof override === 'boolean' ? override : getRequireMentionInGroup(cfg);
}

export function canRunAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

function allow(reason: AccessDecision['reason']): AccessDecision {
  return { ok: true, reason };
}

function deny(reason: AccessDecision['reason']): AccessDecision {
  return { ok: false, reason };
}
