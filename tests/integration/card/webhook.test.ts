import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallbackAuth } from '../../../src/card/callback-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { CardWebhooks, isCardWebhookClick } from '../../../src/card/webhook';

const dirs: string[] = [];
const clickAllowed = async () => true;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('signed card webhooks', () => {
  it('signs the POST and disables only the clicked button across bridge restarts', async () => {
    const h = await setup();
    const event = h.click(0);
    expect(isCardWebhookClick(event.action.value)).toBe(true);
    expect(h.card.body.elements[0]?.behaviors[0]?.value).not.toHaveProperty('data');

    const receiver = h.service();
    receiver.enqueue(h.channel, event, clickAllowed);
    receiver.enqueue(h.channel, event, clickAllowed);
    await receiver.close();

    expect(h.request).toHaveBeenCalledTimes(1);
    const [url, request] = h.request.mock.calls[0]!;
    const headers = new Headers(request?.headers);
    const body = request?.body as string;
    const timestamp = headers.get('x-bridge-timestamp');
    const signature = createHmac('sha256', 'business-key').update(`${timestamp}.${body}`).digest('hex');
    expect(url).toBe('https://business.example/approve');
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('error');
    expect(headers.get('x-bridge-signature')).toBe(`sha256=${signature}`);
    expect(JSON.parse(body)).toEqual({
      id: headers.get('idempotency-key'),
      action: 'approve',
      chat_id: 'oc_chat',
      message_id: 'om_card',
      operator_open_id: 'ou_owner',
      data: { orderId: '1001' },
    });
    const first = h.updateCard.mock.calls[0]![0]!;
    expect(first.data.sequence).toBe(1);
    expect(disabledButtons(first.data.card.data)).toEqual([true, undefined]);

    const restarted = h.service();
    restarted.enqueue(h.channel, event, clickAllowed);
    restarted.enqueue(h.channel, h.click(1), clickAllowed);
    await restarted.close();
    expect(h.request).toHaveBeenCalledTimes(2);
    const second = h.updateCard.mock.calls[1]![0]!;
    expect(second.data.sequence).toBe(2);
    expect(disabledButtons(second.data.card.data)).toEqual([true, true]);
  });

  it('rejects tampering, copied cards, unauthorized users, changed access and expiry', async () => {
    const h = await setup();
    const event = h.click(0);
    const value = event.action.value as { bridge_token: string };
    const badSignature = { ...value, bridge_token: `${value.bridge_token}x` };
    const receiver = h.service();
    receiver.enqueue(h.channel, { ...event, operator: { openId: 'ou_other' } }, clickAllowed);
    receiver.enqueue(h.channel, { ...event, chatId: 'oc_other' }, clickAllowed);
    receiver.enqueue(h.channel, { ...event, messageId: 'om_copy' }, clickAllowed);
    receiver.enqueue(h.channel, { ...event, action: { ...event.action, value: badSignature } }, clickAllowed);
    receiver.enqueue(h.channel, event, async () => false);
    await receiver.close();
    const expired = h.service(() => Date.now() + 25 * 60 * 60 * 1000);
    expired.enqueue(h.channel, event, clickAllowed);
    await expired.close();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.updateCard).not.toHaveBeenCalled();
  });

  it('keeps failures clickable and retries a card update without another business request', async () => {
    const h = await setup();
    h.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    h.updateCard.mockResolvedValueOnce({ code: 300001 });
    const event = h.click(0);
    const first = h.service();
    first.enqueue(h.channel, event, clickAllowed);
    await first.close();
    expect(h.updateCard).not.toHaveBeenCalled();

    const second = h.service();
    second.enqueue(h.channel, event, clickAllowed);
    await second.close();
    expect(h.request).toHaveBeenCalledTimes(2);
    const keys = h.request.mock.calls.map(([, opts]) => new Headers(opts?.headers).get('idempotency-key'));
    expect(keys[0]).toBe(keys[1]);

    const third = h.service();
    third.enqueue(h.channel, event, clickAllowed);
    await third.close();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.updateCard).toHaveBeenLastCalledWith(expect.objectContaining({
      path: { card_id: 'card_test' },
      data: expect.objectContaining({ sequence: 2 }),
    }));
  });
});

interface TestCard {
  body: {
    elements: Array<{ disabled?: boolean; behaviors: Array<{ value: unknown }> }>;
  };
}

function disabledButtons(cardJson: string): Array<boolean | undefined> {
  return (JSON.parse(cardJson) as TestCard).body.elements.map((element) => element.disabled);
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-webhook-test-'));
  dirs.push(dir);
  await writeFile(join(dir, 'card-webhooks.json'), JSON.stringify({
    approve: { url: 'https://business.example/approve', secretFile: 'signing.key' },
  }));
  await writeFile(join(dir, 'signing.key'), 'business-key\n');
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
  const updateCard = vi.fn<LarkChannel['rawClient']['cardkit']['v1']['card']['update']>()
    .mockResolvedValue({ code: 0 });
  const channel = {
    createCard: vi.fn(async (_card: object) => ({ cardId: 'card_test' })),
    send: vi.fn(async () => ({ messageId: 'om_card' })),
    recallMessage: vi.fn(async () => {}),
    rawClient: { cardkit: { v1: { card: { update: updateCard } } } },
  };
  const service = (now?: () => number) => new CardWebhooks(dir, 'cli_app', new CallbackAuth({
    keys: [{ version: 1, secret: 'app-secret' }],
    nonceStore: new CallbackNonceStore(join(dir, 'nonces.json')),
    now,
  }), request);
  await service().send(channel, 'oc_chat', 'ou_owner', {
    schema: '2.0',
    body: {
      elements: ['1001', '1002'].map((orderId) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: orderId },
        behaviors: [{ type: 'callback', value: { bridge_webhook: 'approve', data: { orderId } } }],
      })),
    },
  });
  const card = channel.createCard.mock.calls[0]?.[0] as TestCard;
  return {
    card,
    channel,
    request,
    service,
    updateCard,
    click: (index: number): CardActionEvent => ({
      chatId: 'oc_chat',
      messageId: 'om_card',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: card.body.elements[index]?.behaviors[0]?.value },
    }),
  };
}
