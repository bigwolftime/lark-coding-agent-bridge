import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const LEGACY_ALLOWED_CHATS = `allowed${'Chats'}`;
const LEGACY_GROUP_COMMANDS = ['/invite ' + 'group', '/invite all ' + 'group', '/remove ' + 'group'];

describe('README runtime contract', () => {
  it('documents maintained runtime surfaces in user-visible docs', async () => {
    const docs = await readDocs();

    for (const phrase of [
      'per-profile service',
      'workspaces.default',
      '/invite user',
      '/remove user',
      'Windows',
      '.cmd',
      'profile export',
      'profile remove',
      '--purge --yes',
      '--include-secrets --yes',
      'lark-cli identity policy',
      'profile-local lark-cli directory',
      'lark-cli 身份策略',
      '当前 profile 的 lark-cli 目录',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it('keeps CLI help aligned with profile-aware service and first-run workspace flags', async () => {
    const [cli, help, configCard] = await Promise.all([
      readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/templates.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
    ]);

    expect(cli).toContain('--workspace <path>');
    expect(cli).toContain('profile name (defaults to active profile)');
    expect(cli).toContain('Archive a profile and its local state');
    expect(help).not.toContain('/doc ws');
    expect(configCard).not.toContain('`/doc`');
  });

  it('keeps obsolete group access management and team bypass claims out of runtime source', async () => {
    const [commands, card, channel, policy, profileSchema] = await Promise.all([
      readFile(new URL('../../../src/commands/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/bot/channel.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/policy/access.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/config/profile-schema.ts', import.meta.url), 'utf8'),
    ]);
    const runtimeSurfaces = `${commands}\n${card}\n${channel}\n${policy}\n${profileSchema}`;
    const forbidden = [
      ...LEGACY_GROUP_COMMANDS,
      LEGACY_ALLOWED_CHATS,
      '访问控制不生效',
      '任何人可用',
      'Team mode opens up *usage* to everyone — no allowlist gating',
      'anyone can @-use the bot (no allowlist gating)',
    ];

    for (const phrase of forbidden) {
      expect(runtimeSurfaces).not.toContain(phrase);
    }
  });

  it('documents per-group sender access without legacy group management', async () => {
    const [en, zh] = await readReadmes();

    for (const doc of [en, zh]) {
      for (const phrase of [LEGACY_ALLOWED_CHATS, ...LEGACY_GROUP_COMMANDS]) {
        expect(doc).not.toContain(phrase);
      }
    }

    expect(en).not.toContain('The one exception: if someone `@`-mentions the bot');
    expect(zh).not.toContain('唯一的例外：有人在一个还没开放的群里 @bot');

    expect(en).toContain('`allowedUsers` controls DMs only');
    expect(zh).toContain('`allowedUsers` 只控制私聊');

    expect(en).toContain('`groupAllowedUsers` maps each group `chat_id`');
    expect(en).toContain('`groupDenyUsers` maps each group `chat_id`');
    expect(zh).toContain('`groupAllowedUsers`：按群 `chat_id`');
    expect(zh).toContain('`groupDenyUsers`：按群 `chat_id`');
    expect(en).toContain('Group access currently has no management entry point inside Feishu / Lark');
    expect(zh).toContain('群聊访问目前没有飞书 / Lark 内的管理入口');
    expect(en).toContain('Do not add the bridge bot itself');
    expect(zh).toContain('不要把 bridge bot 自身加入');

    for (const doc of [en, zh]) {
      expect(doc).toContain('chat_id');
      expect(doc).toContain('senderId');
      expect(doc).toContain('open_id');
    }

    for (const phrase of [
      'Human and bot senders',
      'Owner and admins bypass',
      'deny wins',
      'no allow entry',
      'Team mode opens DMs only',
      'always ignored silently, including messages that `@bot`',
    ]) {
      expect(en).toContain(phrase);
    }

    for (const phrase of [
      '人类和机器人发送者',
      'owner 和 admin 会绕过',
      'deny 优先',
      '没有 allow 条目',
      'team 模式只放开私聊',
      '始终静默忽略，包括 `@bot` 的消息',
    ]) {
      expect(zh).toContain(phrase);
    }
  });

  it('keeps both access configuration examples valid and structurally equivalent', async () => {
    const [en, zh] = await readReadmes();

    for (const access of [readAccessExample(en), readAccessExample(zh)]) {
      expect(access).toMatchObject({
        allowedUsers: ['ou_dm_user'],
        admins: ['ou_admin'],
        groupAllowedUsers: {
          oc_group_a: ['ou_human_1', 'ou_bot_1'],
        },
        groupDenyUsers: {
          oc_group_a: ['ou_blocked'],
        },
        requireMentionInGroup: true,
      });
    }
  });

  it('documents the actual intake log fields used to find group and sender IDs', async () => {
    const [en, zh] = await readReadmes();

    for (const doc of [en, zh]) {
      const command = readIdLookupCommand(doc);
      expect(command).toContain(`grep -F '"phase":"intake"'`);
      expect(command).toContain(`grep -F '"event":"enter"'`);

      const explanation = paragraphAfter(doc, command);
      expect(explanation).toContain('`chatId`');
      expect(explanation).toContain('`sender`');
      expect(explanation).toContain('`open_id`');
      expect(explanation).not.toContain('`senderId`');
    }
  });

  it('names groupAllowedUsers as the loop-prevention allow map', async () => {
    const [en, zh] = await readReadmes();

    for (const [doc, marker] of [
      [en, 'message loop'],
      [zh, '消息循环'],
    ] as const) {
      const rule = paragraphContaining(doc, marker);
      expect(rule).toContain('`groupAllowedUsers`');
      expect(rule).not.toContain('either allow map');
      expect(rule).not.toContain('任一 allow map');
    }
  });

  it('does not document trusted or allowed directory authorization', async () => {
    const docs = await readDocs();

    for (const phrase of [
      '允许访问目录',
      '可信目录',
      '安全目录',
      'trustedRoots',
      '/ws add',
      '/ws remove --root',
      'allowed directory',
      'allowed directories',
      'trusted directory',
      'safe directory',
    ]) {
      expect(docs).not.toContain(phrase);
    }
  });

  it('documents access control commands instead of config-only access management', async () => {
    const docs = await readDocs();

    expect(docs).not.toContain('`/config` only adjusts presentation preferences. Manage access in the profile config.');
    expect(docs).not.toContain('`/config` 只调整展示偏好，不再维护访问名单。请在 profile config 里维护。');
  });

  it('documents cloud-doc comments as document-scoped instead of access-gated', async () => {
    const docs = await readDocs();

    expect(docs).toContain('Cloud-doc comments are document-scoped');
    expect(docs).toContain('云文档评论按文档权限生效');
    expect(docs).not.toContain('comments.enabled');
    expect(docs).not.toContain('comments.rateLimit');
    expect(docs).not.toContain('/doc ws bind');
  });

  it('documents canonical permissions instead of recommending legacy sandbox config', async () => {
    const docs = await readDocs();

    expect(docs).toContain('"permissions"');
    expect(docs).toContain('"defaultAccess": "full"');
    expect(docs).toContain('"maxAccess": "full"');
    expect(docs).toContain('legacy `sandbox`');
    expect(docs).toContain('旧版 `sandbox`');
    expect(docs).not.toContain('"sandbox"');
  });
});

async function readDocs(): Promise<string> {
  const [en, zh] = await readReadmes();
  return `${en}\n${zh}`;
}

function readReadmes(): Promise<[string, string]> {
  return Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
  ]);
}

function readAccessExample(doc: string): Record<string, unknown> {
  const block = fencedBlocks(doc, 'json').find((candidate) =>
    candidate.includes('"groupAllowedUsers"'),
  );
  if (!block) throw new Error('README is missing the profile access JSON example');
  const parsed = JSON.parse(block) as {
    profiles?: { claude?: { access?: Record<string, unknown> } };
  };
  const access = parsed.profiles?.claude?.access;
  if (!access) throw new Error('README access JSON example has no profile access object');
  return access;
}

function readIdLookupCommand(doc: string): string {
  const command = fencedBlocks(doc, 'bash').find((block) => block.includes('/logs/bridge-'));
  if (!command) throw new Error('README is missing the ID lookup command');
  return command;
}

function fencedBlocks(doc: string, language: string): string[] {
  const pattern = new RegExp('```' + language + '\\s*\\n([\\s\\S]*?)\\n```', 'g');
  return Array.from(doc.matchAll(pattern), (match) => match[1] ?? '');
}

function paragraphAfter(doc: string, preceding: string): string {
  const start = doc.indexOf(preceding);
  if (start < 0) throw new Error('preceding content is missing');
  return doc.slice(start + preceding.length).split(/\n\s*\n/, 2)[1] ?? '';
}

function paragraphContaining(doc: string, marker: string): string {
  const paragraph = doc.split(/\n\s*\n/).find((part) => part.includes(marker));
  if (!paragraph) throw new Error(`README is missing paragraph containing ${marker}`);
  return paragraph;
}
