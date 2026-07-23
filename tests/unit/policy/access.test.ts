import { describe, expect, it } from 'vitest';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  isCreator,
  requireMentionForChat,
  type RuntimeControls,
} from '../../../src/policy/access';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import type { AppConfig } from '../../../src/config/schema';

const ownerControls: RuntimeControls = {
  botOwnerId: 'ou_owner',
  ownerRefreshState: 'ok',
};

describe('access policy', () => {
  it('lets the runtime owner use DMs, groups, and admin commands regardless of lists', () => {
    const profile = profileWithAccess();

    expect(isCreator(ownerControls, 'ou_owner')).toBe(true);
    expect(canUseDm(profile, ownerControls, 'ou_owner').ok).toBe(true);
    expect(canUseGroup(profile, ownerControls, 'chat_any', 'ou_owner').ok).toBe(true);
    expect(canRunAdminCommand(profile, ownerControls, 'ou_owner').ok).toBe(true);
  });

  it('uses a cached owner even when the last owner refresh failed', () => {
    const profile = profileWithAccess();
    const controls: RuntimeControls = {
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'failed',
      ownerRefreshError: 'permission denied',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(true);
    expect(canUseDm(profile, controls, 'ou_owner')).toEqual({ ok: true, reason: 'owner' });
    expect(canRunAdminCommand(profile, controls, 'ou_owner')).toEqual({ ok: true, reason: 'owner' });
  });

  it('does not grant creator access without a cached owner', () => {
    const profile = profileWithAccess();
    const controls: RuntimeControls = {
      ownerRefreshState: 'failed',
      ownerRefreshError: 'permission denied',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(false);
    expect(canUseDm(profile, controls, 'ou_owner').ok).toBe(false);
    expect(canRunAdminCommand(profile, controls, 'ou_owner').ok).toBe(false);
  });

  it('does not grant creator access before owner refresh has resolved', () => {
    const profile = profileWithAccess();
    const controls: RuntimeControls = {
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'unknown',
    };

    expect(isCreator(controls, 'ou_owner')).toBe(false);
    expect(canUseDm(profile, controls, 'ou_owner').ok).toBe(false);
    expect(canRunAdminCommand(profile, controls, 'ou_owner').ok).toBe(false);
  });

  it('fails closed for non-owner DMs unless allowedUsers or admins include sender', () => {
    const closed = profileWithAccess();
    expect(canUseDm(closed, ownerControls, 'ou_other').ok).toBe(false);

    const byUser = profileWithAccess({ allowedUsers: ['ou_other'] });
    expect(canUseDm(byUser, ownerControls, 'ou_other').ok).toBe(true);

    const byAdmin = profileWithAccess({ admins: ['ou_other'] });
    expect(canUseDm(byAdmin, ownerControls, 'ou_other').ok).toBe(true);
  });

  it('allows a group sender listed for that group, including a bot open_id', () => {
    const profile = profileWithAccess({
      groupAllowedUsers: { chat_allowed: ['ou_bot_sender'] },
    });

    expect(canUseGroup(profile, ownerControls, 'chat_allowed', 'ou_bot_sender')).toEqual({
      ok: true,
      reason: 'allowed-group-user',
    });
  });

  it('denies a group sender when the group or sender is not allowlisted', () => {
    const profile = profileWithAccess({
      groupAllowedUsers: { chat_allowed: ['ou_allowed'] },
    });

    expect(canUseGroup(profile, ownerControls, 'chat_missing', 'ou_allowed')).toEqual({
      ok: false,
      reason: 'denied-group-user',
    });
    expect(canUseGroup(profile, ownerControls, 'chat_allowed', 'ou_missing')).toEqual({
      ok: false,
      reason: 'denied-group-user',
    });
  });

  it('isolates group allowlists by chat ID', () => {
    const profile = profileWithAccess({
      groupAllowedUsers: {
        chat_one: ['ou_user_one'],
        chat_two: ['ou_user_two'],
      },
    });

    expect(canUseGroup(profile, ownerControls, 'chat_one', 'ou_user_one').ok).toBe(true);
    expect(canUseGroup(profile, ownerControls, 'chat_two', 'ou_user_one')).toEqual({
      ok: false,
      reason: 'denied-group-user',
    });
  });

  it('denies a group sender when they are in both the allowlist and denylist', () => {
    const profile = profileWithAccess({
      groupAllowedUsers: { chat_allowed: ['ou_denied'] },
      groupDenyUsers: { chat_allowed: ['ou_denied'] },
    });

    expect(canUseGroup(profile, ownerControls, 'chat_allowed', 'ou_denied')).toEqual({
      ok: false,
      reason: 'denied-group-user',
    });
  });

  it('lets owner and admins use groups even when denylisted', () => {
    const profile = profileWithAccess({
      admins: ['ou_admin'],
      groupDenyUsers: { chat_denied: ['ou_owner', 'ou_admin'] },
    });

    expect(canUseGroup(profile, ownerControls, 'chat_denied', 'ou_owner')).toEqual({
      ok: true,
      reason: 'owner',
    });
    expect(canUseGroup(profile, ownerControls, 'chat_denied', 'ou_admin')).toEqual({
      ok: true,
      reason: 'allowed-admin',
    });
  });

  it('denies incomplete group identities before owner or admin bypasses', () => {
    const personal = profileWithAccess({ admins: ['', '   '] });
    const team = profileWithAccess({ admins: ['', '   '] }, 'team');
    const denied = { ok: false, reason: 'denied-group-user' };

    expect(canUseGroup(personal, ownerControls, '', 'ou_owner')).toEqual(denied);
    expect(canUseGroup(team, ownerControls, '   ', 'ou_owner')).toEqual(denied);
    expect(canUseGroup(personal, ownerControls, 'chat_valid', '')).toEqual(denied);
    expect(canUseGroup(team, ownerControls, 'chat_valid', '   ')).toEqual(denied);
  });

  it('treats empty admins as zero admins while preserving owner admin access', () => {
    const profile = profileWithAccess();

    expect(canRunAdminCommand(profile, ownerControls, 'ou_other').ok).toBe(false);
    expect(canRunAdminCommand(profile, ownerControls, 'ou_owner').ok).toBe(true);

    const withAdmin = profileWithAccess({ admins: ['ou_admin'] });
    expect(canRunAdminCommand(withAdmin, ownerControls, 'ou_admin').ok).toBe(true);
  });

  it('opens DMs to everyone in team mode while denying unlisted group senders', () => {
    const team = profileWithAccess({}, 'team');

    // Team mode preserves its existing DM behavior.
    expect(canUseDm(team, ownerControls, 'ou_stranger')).toEqual({
      ok: true,
      reason: 'allowed-team',
    });
    // Group senders remain scoped to the group allowlist in both modes.
    expect(canUseGroup(team, ownerControls, 'chat_random', 'ou_stranger')).toEqual({
      ok: false,
      reason: 'denied-group-user',
    });

    // Admin/sensitive commands are still owner/admin-gated.
    expect(canRunAdminCommand(team, ownerControls, 'ou_stranger').ok).toBe(false);
    expect(canRunAdminCommand(team, ownerControls, 'ou_owner').ok).toBe(true);

    const teamWithAdmin = profileWithAccess({ admins: ['ou_admin'] }, 'team');
    expect(canRunAdminCommand(teamWithAdmin, ownerControls, 'ou_admin').ok).toBe(true);
  });

});

describe('requireMentionForChat', () => {
  const globalOn = { preferences: { requireMentionInGroup: true } } as AppConfig;
  const globalOff = { preferences: { requireMentionInGroup: false } } as AppConfig;

  it('follows the global setting when a chat has no override', () => {
    const profile = profileWithAccess();
    expect(requireMentionForChat(profile, globalOn, 'oc_x')).toBe(true);
    expect(requireMentionForChat(profile, globalOff, 'oc_x')).toBe(false);
  });

  it('lets a per-chat override win over the global setting, both directions', () => {
    const profile = profileWithAccess({ chatRequireMention: { oc_open: false, oc_strict: true } });
    // Global requires @, but oc_open overrides to respond-to-all.
    expect(requireMentionForChat(profile, globalOn, 'oc_open')).toBe(false);
    // Global responds to all, but oc_strict overrides to require @.
    expect(requireMentionForChat(profile, globalOff, 'oc_strict')).toBe(true);
    // An unlisted chat still follows the global setting.
    expect(requireMentionForChat(profile, globalOn, 'oc_other')).toBe(true);
  });
});

function profileWithAccess(
  access: Partial<ProfileConfig['access']> = {},
  mode: ProfileConfig['mode'] = 'personal',
): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    mode,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    access,
  });
}
