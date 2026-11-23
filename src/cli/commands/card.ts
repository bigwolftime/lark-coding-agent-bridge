import { createLarkChannel } from '@larksuite/channel';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { CallbackAuth } from '../../card/callback-auth';
import { CallbackNonceStore } from '../../card/callback-store';
import { CardWebhooks } from '../../card/webhook';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile, runtimeProfileConfig } from '../../config/profile-store';
import { resolveAppSecret } from '../../config/secret-resolver';

interface CardSendOptions {
  config?: string;
  profile?: string;
  chatId: string;
  operator: string;
  file: string;
  replyTo?: string;
  replyInThread?: boolean;
}

export async function runCardSend(opts: CardSendOptions): Promise<void> {
  if (opts.replyInThread && !opts.replyTo) {
    throw new Error('--reply-in-thread requires --reply-to');
  }
  const rootDir = opts.config ? dirname(resolve(opts.config)) : undefined;
  const configPath = opts.config ?? resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configPath);
  if (!root) throw new Error('Bridge profile configuration is missing');
  const profile = opts.profile ?? process.env.LARK_CHANNEL_PROFILE ??
    await readActiveProfile(rootDir) ?? root.activeProfile;
  const paths = resolveAppPaths({ rootDir, profile });
  const cfg = runtimeProfileConfig(root, paths.profile);
  const appSecret = await resolveAppSecret(cfg, paths);
  const rawCard = opts.file === '-' ? await text(process.stdin) : await readFile(opts.file, 'utf8');
  const card: unknown = JSON.parse(rawCard);
  const channel = createLarkChannel({
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    loggerLevel: 0, // Keep stdout reserved for the JSON result.
    httpTimeoutMs: 30_000,
    respectProxyEnv: true,
  });
  // This CLI process signs and sends through REST. The running profile receives the clicks.
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: appSecret }],
    nonceStore: new CallbackNonceStore(join(paths.profileDir, 'callback-nonces.json')),
  });
  const webhooks = new CardWebhooks(paths.profileDir, cfg.accounts.app.id, auth);
  if (opts.replyTo) {
    const result = await channel.rawClient.im.v1.message.get({ path: { message_id: opts.replyTo } });
    if (result.data?.items?.[0]?.chat_id !== opts.chatId) {
      throw new Error('--reply-to must belong to --chat-id');
    }
  }
  const result = await webhooks.send(channel, opts.chatId, opts.operator, card, {
    replyTo: opts.replyTo,
    replyInThread: opts.replyInThread,
  });
  console.log(JSON.stringify({ message_id: result.messageId }));
}
