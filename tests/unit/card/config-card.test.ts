import { describe, expect, it } from 'vitest';
import {
  configFormCard,
  configSavedCard,
  type ConfigFormOpts,
} from '../../../src/card/config-card.js';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  admins: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

describe('config cards', () => {
  it('renders team access semantics without a personal DM allowlist', () => {
    const card = JSON.stringify(
      configFormCard({
        agentKind: 'claude',
        mode: 'team',
        model: 'default',
        messageReply: 'markdown',
        showToolCalls: true,
        cotMessages: 'off',
        maxConcurrentRuns: 10,
        runIdleTimeoutMinutes: 0,
        requireMentionInGroup: true,
        larkCliIdentity: 'bot-only',
        allowedUsers: ['ou_personal_only'],
        admins: ['ou_admin'],
      }),
    );

    expect(card).toContain('团队版私聊对所有人开放');
    expect(card).toContain('groupAllowedUsers/groupDenyUsers');
    expect(card).not.toContain('控制谁能通过私聊使用 bot');
    expect(card).not.toContain('留空 = 不响应聊天消息');
    expect(card).not.toContain('允许私聊的用户');
  });

  it('renders saved access summaries according to deployment mode', () => {
    const common = {
      agentKind: 'claude' as const,
      model: 'default',
      messageReply: 'markdown' as const,
      showToolCalls: true,
      cotMessages: 'off' as const,
      maxConcurrentRuns: 10,
      runIdleTimeoutMinutes: 0,
      requireMentionInGroup: true,
      larkCliIdentity: 'bot-only' as const,
      allowedUsers: ['ou_personal_only'],
      admins: ['ou_admin'],
    };
    const teamCard = JSON.stringify(configSavedCard({ ...common, mode: 'team' }));
    const personalCard = JSON.stringify(configSavedCard({ ...common, mode: 'personal' }));

    expect(teamCard).toContain('团队版私聊对所有人开放');
    expect(teamCard).toContain('groupAllowedUsers/groupDenyUsers');
    expect(teamCard).not.toContain('允许私聊的用户');
    expect(teamCard).toContain('**管理员**:1 项');
    expect(personalCard).toContain('**允许私聊的用户**:1 项');
    expect(personalCard).toContain('**管理员**:1 项');
  });
});
