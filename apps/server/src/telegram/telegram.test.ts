import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Update, UserFromGetMe } from 'grammy/types';
import { buildApp } from '../app.js';
import type { Config } from '../config.js';
import { FakeSessionManager } from '../sessions/fake.js';
import { createTelegram } from './index.js';

const OWNER = 111;
const STRANGER = 999;
let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'orch-tg-'));
  mkdirSync(path.join(root, 'alpha'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const botInfo = { id: 1, is_bot: true, first_name: 'orch', username: 'orch_bot' } as UserFromGetMe;

async function setup(notify: Config['telegram']['notify'] = ['task_done', 'decision_needed', 'limit_reached', 'session_error']) {
  const config: Config = {
    server: { port: 0, dashboardOrigin: 'http://localhost:5173' },
    claude: { defaultModel: 'm', permissionMode: 'default', maxConcurrentSessions: 3 },
    projects: { rootDir: root },
    telegram: { botTokenEnv: 'X', chatId: OWNER, notify },
    mcp: { codex: { enabled: false, command: 'codex', args: [] } },
  };
  const { app, orch } = await buildApp({
    config,
    dbPath: ':memory:',
    sessionManager: (host) => new FakeSessionManager(host),
  });
  const warnings: string[] = [];
  const tg = createTelegram(orch, { token: 'test', chatId: OWNER, notify }, { info() {}, warn: (m) => warnings.push(m) }, { botInfo });

  // Capture outgoing Bot API calls instead of hitting Telegram.
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: (method === 'sendMessage' ? { message_id: calls.length } : true) as never };
  });

  const project = orch.createProject({ name: 'alpha', workdir: 'alpha' });
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const tap = (data: string, chatId = OWNER) =>
    tg.bot.handleUpdate({
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: 'cb',
        chat_instance: 'ci',
        data,
        from: { id: chatId, is_bot: false, first_name: 'u' },
        message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private', first_name: 'u' }, text: 'x' },
      },
    } as Update);

  return { app, orch, tg, calls, project, settle, tap, warnings };
}

test('permission prompt is sent with buttons, approved from Telegram, then edited', async () => {
  const t = await setup();
  const session = t.orch.startSession(t.project.id, { prompt: 'go [decision]' });
  await t.settle();

  const prompt = t.calls.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('Permission needed'));
  assert.ok(prompt, 'permission prompt sent');
  assert.equal(prompt.payload.chat_id, OWNER);
  const buttons = (prompt.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
  const approve = buttons[0]!.callback_data;
  assert.ok(Buffer.byteLength(approve) <= 64);

  await t.tap(approve);
  await t.settle();

  assert.equal(t.orch.listDecisions('answered')[0]?.answeredVia, 'telegram');
  const edit = t.calls.find((c) => c.method === 'editMessageText');
  assert.match(String(edit?.payload.text), /Answered via telegram$/);
  const done = t.calls.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('Task done'));
  assert.match(String(done?.payload.text), /Echo: go \[decision\] \(permission: allow\)/);
  assert.equal(t.orch.getSession(session.id).status, 'idle');
  await t.tg.stop();
  await t.app.close();
});

test('decision answered on the web edits the Telegram prompt; a late tap is refused', async () => {
  const t = await setup();
  t.orch.startSession(t.project.id, { prompt: '[decision]' });
  await t.settle();
  const [decision] = t.orch.listDecisions('pending');
  t.orch.answerDecision(decision!.id, { answer: { behavior: 'deny' } }, 'web');
  await t.settle();

  assert.match(String(t.calls.find((c) => c.method === 'editMessageText')?.payload.text), /Answered via web$/);
  await t.tap(`p:${decision!.id}:a`);
  const reply = t.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1);
  assert.equal(reply?.payload.text, 'Decision already answered');
  await t.tg.stop();
  await t.app.close();
});

test('taps from other chats are ignored and logged', async () => {
  const t = await setup();
  t.orch.startSession(t.project.id, { prompt: '[decision]' });
  await t.settle();
  const [decision] = t.orch.listDecisions('pending');

  await t.tap(`p:${decision!.id}:a`, STRANGER);
  assert.equal(t.orch.listDecisions('pending').length, 1);
  assert.match(t.warnings[0] ?? '', /ignored update from chat 999/);
  await t.tg.stop();
  await t.app.close();
});

test('session_error offers Resume, which resumes the session', async () => {
  const t = await setup();
  const session = t.orch.startSession(t.project.id, { prompt: 'hello' });
  await t.settle();
  t.orch.fail(session.id, 'boom');
  await t.settle();

  const err = t.calls.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('Session error'));
  assert.match(String(err?.payload.text), /boom/);
  await t.tap(`r:${session.id}`);
  await t.settle();
  assert.equal(t.orch.getSession(session.id).status, 'idle');
  assert.ok(t.calls.some((c) => String(c.payload.text).includes('Echo: Continue where you left off.')));
  await t.tg.stop();
  await t.app.close();
});

test('events outside telegram.notify are not sent', async () => {
  const t = await setup(['decision_needed']);
  t.orch.startSession(t.project.id, { prompt: 'hello' });
  await t.settle();
  assert.equal(t.calls.filter((c) => c.method === 'sendMessage').length, 0);
  await t.tg.stop();
  await t.app.close();
});
