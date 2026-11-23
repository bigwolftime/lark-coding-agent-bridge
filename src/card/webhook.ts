import { createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CardActionEvent, LarkChannel, SendOptions } from '@larksuite/channel';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { CallbackAuth, CallbackVerifyExpected } from './callback-auth';

const MARKER = '__bridge_webhook';
const BUTTON_ENDPOINT_FIELD = 'bridge_webhook';
const WEBHOOK_CONFIG_FILE = 'card-webhooks.json';
const CARD_TTL_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const CLICK_ID = /^([a-f0-9-]{36}):(0|[1-9][0-9]*)$/;
const CARD_FILE = /^[a-f0-9-]{36}\.json$/;

type JsonObject = Record<string, unknown>;
type CardSender = Pick<LarkChannel, 'createCard' | 'send' | 'recallMessage'>;
type UpdateCard = LarkChannel['rawClient']['cardkit']['v1']['card']['update'];
type CardReceiver = {
  rawClient: { cardkit: { v1: { card: { update: UpdateCard } } } };
};

interface Endpoint {
  url: string;
  secretFile: string;
}

interface ButtonRecord {
  endpoint: string;
  url: string;
  data: unknown;
  delivered?: boolean;
}

interface CardRecord {
  chatId: string;
  operatorOpenId: string;
  cardId: string;
  messageId: string;
  card: JsonObject;
  buttons: ButtonRecord[];
  sequence: number;
  publishedSequence: number;
}

export function isCardWebhookClick(value: unknown): boolean {
  return isObject(value) && Object.hasOwn(value, MARKER);
}

export class CardWebhooks {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly pendingClicks = new Set<string>();
  private closed = false;

  constructor(
    private readonly profileDir: string,
    private readonly appId: string,
    private readonly auth: CallbackAuth,
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(
    channel: CardSender,
    chatId: string,
    operatorOpenId: string,
    input: unknown,
    opts?: SendOptions,
  ): Promise<{ messageId: string }> {
    if (!/^oc_\w+$/.test(chatId) || !/^ou_\w+$/.test(operatorOpenId)) {
      throw new Error('card send requires an oc_ chat ID and an ou_ operator open ID');
    }
    if (!isObject(input) || input.schema !== '2.0' || !isObject(input.body)) {
      throw new Error('card send requires a CardKit 2.0 card');
    }
    const endpoints = await this.loadEndpoints();
    const card = structuredClone(input);
    card.config = { ...(isObject(card.config) ? card.config : {}), update_multi: true };
    const id = randomUUID();
    const buttons: ButtonRecord[] = [];
    const verifiedEndpoints = new Set<string>();
    for (const button of walkButtons(card.body)) {
      const behavior = callbackBehavior(button, BUTTON_ENDPOINT_FIELD);
      if (!behavior) continue;
      const { [BUTTON_ENDPOINT_FIELD]: name, data = null } = behavior.value;
      const endpoint = typeof name === 'string' ? endpoints.get(name) : undefined;
      if (typeof name !== 'string' || !endpoint) {
        throw new Error('bridge_webhook must name an endpoint in card-webhooks.json');
      }
      if (button.disabled === true || button.form_action_type || (button.behaviors as unknown[]).length !== 1) {
        throw new Error('A webhook button must be enabled and have a single callback behavior');
      }
      if (!verifiedEndpoints.has(name)) {
        await this.loadSecret(endpoint);
        verifiedEndpoints.add(name);
      }
      const index = buttons.length;
      buttons.push({ endpoint: name, url: endpoint.url, data });
      const token = this.auth.sign({
        ...this.context(id, chatId, operatorOpenId, index),
        ttlMs: CARD_TTL_MS,
      });
      // Keep the button index near the start of the SDK's deduplication key.
      behavior.value = { [MARKER]: `${id}:${index}`, bridge_token: token };
    }
    if (buttons.length === 0) throw new Error('Card has no bridge_webhook buttons');
    const { cardId } = await channel.createCard(card);
    const { messageId } = await channel.send(chatId, { cardId }, opts);
    try {
      await this.save(id, { chatId, operatorOpenId, cardId, messageId, card, buttons, sequence: 0, publishedSequence: 0 });
    } catch (err) {
      await channel.recallMessage(messageId).catch((recallError) => {
        log.fail('card-webhook', recallError, { step: 'recall', messageId });
      });
      throw err;
    }
    return { messageId };
  }

  enqueue(channel: CardReceiver, event: CardActionEvent, canAct: () => Promise<boolean>): void {
    const value = event.action.value;
    if (this.closed || event.action.tag !== 'button' || !isObject(value)) return;
    const click = value[MARKER];
    const token = value.bridge_token;
    const match = typeof click === 'string' ? CLICK_ID.exec(click) : null;
    if (!match || typeof token !== 'string') return;
    const id = match[1]!;
    const index = Number(match[2]);
    const check = this.auth.check(token, this.context(id, event.chatId, event.operator.openId, index));
    if (!check.ok) {
      log.info('card-webhook', 'denied', { messageId: event.messageId, reason: check.reason });
      return;
    }
    const pendingKey = `${id}:${index}:${event.messageId}`;
    if (this.pendingClicks.has(pendingKey)) return;
    this.pendingClicks.add(pendingKey);

    // A single card has one sequence counter. Serialize deliveries and updates for it.
    const job = (this.jobs.get(id) ?? Promise.resolve())
      .then(async () => {
        if (check.payload.exp <= Date.now()) return;
        await this.deliver(channel, event, id, index, canAct);
      })
      .catch((err: unknown) => log.fail('card-webhook', err, { messageId: event.messageId }))
      .finally(() => {
        this.pendingClicks.delete(pendingKey);
        if (this.jobs.get(id) === job) this.jobs.delete(id);
      });
    this.jobs.set(id, job);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.jobs.values());
  }

  async pruneExpired(): Promise<void> {
    const dir = this.stateDir();
    const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const cutoff = Date.now() - CARD_TTL_MS;
    for (const entry of entries) {
      if (!CARD_FILE.test(entry)) continue;
      const path = join(dir, entry);
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
    }
  }

  private async deliver(
    channel: CardReceiver,
    event: CardActionEvent,
    id: string,
    index: number,
    canAct: () => Promise<boolean>,
  ): Promise<void> {
    const record = JSON.parse(await readFile(join(this.stateDir(), `${id}.json`), 'utf8')) as CardRecord;
    const button = record.buttons[index];
    if (!button || record.messageId !== event.messageId || record.chatId !== event.chatId ||
        record.operatorOpenId !== event.operator.openId || !await canAct()) return;
    if (button.delivered && record.publishedSequence === record.sequence) return;

    if (!button.delivered) {
      const component = [...walkButtons(record.card.body)].find((candidate) => {
        return callbackBehavior(candidate, MARKER)?.value[MARKER] === `${id}:${index}`;
      });
      if (!component) throw new Error('Webhook button is missing from the saved card');

      const endpoint = (await this.loadEndpoints()).get(button.endpoint);
      if (!endpoint || endpoint.url !== button.url) throw new Error('Card webhook endpoint changed');
      const secret = await this.loadSecret(endpoint);
      const idempotencyKey = `${id}:${index}`;
      const body = JSON.stringify({
        id: idempotencyKey,
        action: button.endpoint,
        chat_id: record.chatId,
        message_id: record.messageId,
        operator_open_id: record.operatorOpenId,
        data: button.data,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
      const response = await this.request(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Bridge-Timestamp': timestamp,
          'X-Bridge-Signature': `sha256=${signature}`,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`Card webhook responded with HTTP ${response.status}`);
      button.delivered = true;
      component.disabled = true;
    }

    // Record delivery and reserve the update sequence before calling Feishu.
    // A later click can retry the update without sending the business request again.
    record.sequence += 1;
    await this.save(id, record);
    // The SDK's updateCardById discards the response code. Check it before marking the card updated.
    const updated = await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: record.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(record.card) },
        sequence: record.sequence,
        uuid: `u_${record.cardId}_${record.sequence}`,
      },
    });
    if (updated.code !== 0) throw new Error(`CardKit update returned code ${updated.code}`);
    record.publishedSequence = record.sequence;
    await this.save(id, record);
  }

  private context(id: string, chatId: string, operatorOpenId: string, index: number): CallbackVerifyExpected {
    return {
      runId: id,
      scope: chatId,
      chatId,
      operatorOpenId,
      action: `card-webhook:${index}`,
      policyFingerprint: this.appId,
    };
  }

  private stateDir(): string {
    return join(this.profileDir, 'signed-cards');
  }

  private save(id: string, record: CardRecord): Promise<void> {
    return writeFileAtomic(join(this.stateDir(), `${id}.json`), JSON.stringify(record), { mode: 0o600 });
  }

  private async loadEndpoints(): Promise<Map<string, Endpoint>> {
    const input: unknown = JSON.parse(await readFile(join(this.profileDir, WEBHOOK_CONFIG_FILE), 'utf8'));
    if (!isObject(input)) throw new Error('card-webhooks.json must map endpoint names to configurations');
    const endpoints = new Map<string, Endpoint>();
    for (const [name, endpoint] of Object.entries(input)) {
      if (!isObject(endpoint) || typeof endpoint.url !== 'string' ||
          typeof endpoint.secretFile !== 'string' || !endpoint.secretFile.trim()) {
        throw new Error(`Webhook endpoint "${name}" requires url and secretFile`);
      }
      const error = `Webhook endpoint "${name}" requires an HTTP(S) URL without credentials or a fragment`;
      let url: URL;
      try {
        url = new URL(endpoint.url);
      } catch {
        throw new Error(error);
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error(error);
      }
      endpoints.set(name, { url: url.href, secretFile: endpoint.secretFile });
    }
    return endpoints;
  }

  private async loadSecret(endpoint: Endpoint): Promise<string> {
    const secret = (await readFile(resolve(this.profileDir, endpoint.secretFile), 'utf8')).trim();
    if (!secret) throw new Error('Card webhook signing secret is empty');
    return secret;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function* walkButtons(node: unknown): Generator<JsonObject> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walkButtons(child);
  } else if (isObject(node)) {
    if (node.tag === 'button') yield node;
    else for (const child of Object.values(node)) yield* walkButtons(child);
  }
}

function callbackBehavior(button: JsonObject, field: string): { value: JsonObject } | undefined {
  if (!Array.isArray(button.behaviors)) return;
  return button.behaviors.find((behavior) => isObject(behavior) && behavior.type === 'callback' &&
    isObject(behavior.value) && Object.hasOwn(behavior.value, field));
}
