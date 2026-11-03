import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Decision, Project, ServerEvent, Session, SessionMessage } from '@orch/shared';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { FakeSessionManager } from './sessions/fake.js';

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'orch-test-'));
  mkdirSync(path.join(root, 'alpha'));
  mkdirSync(path.join(root, 'beta'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const config = (): Config => ({
  server: { port: 0, dashboardOrigin: 'http://localhost:5173' },
  claude: { defaultModel: 'test-model', permissionMode: 'default', maxConcurrentSessions: 3 },
  projects: { rootDir: root },
  telegram: { botTokenEnv: 'TELEGRAM_BOT_TOKEN', chatId: 0, notify: [] },
  mcp: { codex: { enabled: false, command: 'codex', args: [] } },
});

async function setup(dbFile = `db-${Math.random()}.sqlite`) {
  const { app, orch } = await buildApp({
    config: config(),
    dbPath: path.join(root, dbFile),
    sessionManager: (host) => new FakeSessionManager(host),
  });
  const events: ServerEvent[] = [];
  orch.bus.subscribe((e) => events.push(e));

  /** Waits until an event matching the predicate has been emitted. */
  const waitFor = async (pred: (e: ServerEvent) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('Timed out waiting for event');
  };
  const req = async <T = unknown>(method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as 'GET', url, payload });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };
  const createProject = async (workdir: string) =>
    (await req<Project>('POST', '/api/projects', { name: workdir, workdir })).body;
  const startSession = async (projectId: string, prompt: string) =>
    (await req<Session>('POST', `/api/projects/${projectId}/sessions`, { prompt })).body;

  return { app, events, waitFor, req, createProject, startSession };
}

describe('backend core', () => {
  test('create project, start, follow up, terminate', async () => {
    const t = await setup();
    const project = await t.createProject('alpha');
    assert.equal(project.workdir, path.join(root, 'alpha'));

    const session = await t.startSession(project.id, 'hello');
    assert.equal(session.model, 'test-model');
    await t.waitFor((e) => e.type === 'task_done' && e.sessionId === session.id);

    assert.equal((await t.req('POST', `/api/sessions/${session.id}/messages`, { text: 'again' })).status, 202);
    await t.waitFor((e) => e.type === 'task_done' && e.result === 'Echo: again');

    const history = (await t.req<SessionMessage[]>('GET', `/api/sessions/${session.id}/messages`)).body;
    assert.deepEqual(
      history.map((m) => [m.role, (m.body as { text: string }).text]),
      [
        ['user', 'hello'],
        ['assistant', 'Echo: hello'],
        ['user', 'again'],
        ['assistant', 'Echo: again'],
      ],
    );

    assert.equal((await t.req('DELETE', `/api/sessions/${session.id}`)).status, 204);
    assert.equal((await t.req('DELETE', `/api/sessions/${session.id}`)).status, 409);
    assert.equal((await t.req('POST', `/api/sessions/${session.id}/messages`, { text: 'x' })).status, 409);
    const [listed] = (await t.req<Session[]>('GET', `/api/projects/${project.id}/sessions`)).body;
    assert.equal(listed?.status, 'terminated');
    assert.ok(listed?.endedAt);
    await t.app.close();
  });

  test('rejects workdirs outside rootDir or missing', async () => {
    const t = await setup();
    assert.equal((await t.req('POST', '/api/projects', { name: 'x', workdir: '/etc' })).status, 400);
    assert.equal((await t.req('POST', '/api/projects', { name: 'x', workdir: '../' })).status, 400);
    assert.equal((await t.req('POST', '/api/projects', { name: 'x', workdir: 'nope' })).status, 400);
    assert.equal((await t.req('POST', '/api/projects', { name: '' })).status, 400);
    await t.app.close();
  });

  test('permission decision pauses the session until answered', async () => {
    const t = await setup();
    const project = await t.createProject('alpha');
    const session = await t.startSession(project.id, 'run it [decision]');
    const needed = await t.waitFor((e) => e.type === 'decision_needed');
    assert.ok(needed.type === 'decision_needed');
    const id = needed.decision.id;

    const pending = (await t.req<Decision[]>('GET', '/api/decisions?status=pending')).body;
    assert.deepEqual(pending.map((d) => d.id), [id]);
    assert.equal((await t.req('POST', `/api/sessions/${session.id}/messages`, { text: 'x' })).status, 409);

    assert.equal((await t.req('POST', `/api/decisions/${id}`, { answer: { choice: 'a' } })).status, 400);
    assert.equal((await t.req('POST', `/api/decisions/${id}`, { answer: { behavior: 'allow' } })).status, 200);
    assert.equal((await t.req('POST', `/api/decisions/${id}`, { answer: { behavior: 'deny' } })).status, 409);

    const done = await t.waitFor((e) => e.type === 'task_done');
    assert.ok(done.type === 'task_done' && done.result.endsWith('(permission: allow)'));
    assert.ok(t.events.some((e) => e.type === 'decision_resolved' && e.answeredVia === 'web'));
    await t.app.close();
  });

  test('interrupt expires the pending decision and leaves the session idle', async () => {
    const t = await setup();
    const project = await t.createProject('alpha');
    const session = await t.startSession(project.id, '[decision]');
    const needed = await t.waitFor((e) => e.type === 'decision_needed');
    assert.ok(needed.type === 'decision_needed');

    assert.equal((await t.req('POST', `/api/sessions/${session.id}/interrupt`)).status, 204);
    assert.ok(t.events.some((e) => e.type === 'decision_resolved' && e.answeredVia === null));
    const [decision] = (await t.req<Decision[]>('GET', '/api/decisions')).body;
    assert.equal(decision?.status, 'expired');
    const [listed] = (await t.req<Session[]>('GET', `/api/projects/${project.id}/sessions`)).body;
    assert.equal(listed?.status, 'idle');
    assert.equal((await t.req('POST', `/api/sessions/${session.id}/interrupt`)).status, 409);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!t.events.some((e) => e.type === 'task_done'), 'interrupted turn must not complete');
    await t.app.close();
  });

  test('two sessions in different projects do not mix output', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.createProject('alpha'), t.createProject('beta')]);
    const [sa, sb] = await Promise.all([t.startSession(a!.id, 'from A'), t.startSession(b!.id, 'from B')]);
    await t.waitFor((e) => e.type === 'task_done' && e.sessionId === sa!.id);
    await t.waitFor((e) => e.type === 'task_done' && e.sessionId === sb!.id);

    for (const [s, word] of [[sa!, 'A'], [sb!, 'B']] as const) {
      const texts = (await t.req<SessionMessage[]>('GET', `/api/sessions/${s.id}/messages`)).body.map(
        (m) => (m.body as { text: string }).text,
      );
      assert.deepEqual(texts, [`from ${word}`, `Echo: from ${word}`]);
    }
    await t.app.close();
  });

  test('restart keeps history and marks in-flight sessions interrupted', async () => {
    const first = await setup('restart.sqlite');
    const project = await first.createProject('alpha');
    const session = await first.startSession(project.id, '[decision]');
    await first.waitFor((e) => e.type === 'decision_needed');
    await first.app.close();

    const second = await setup('restart.sqlite');
    assert.deepEqual((await second.req<Project[]>('GET', '/api/projects')).body.map((p) => p.id), [project.id]);
    const [listed] = (await second.req<Session[]>('GET', `/api/projects/${project.id}/sessions`)).body;
    assert.equal(listed?.id, session.id);
    assert.equal(listed?.status, 'interrupted');
    assert.equal((await second.req<Decision[]>('GET', '/api/decisions?status=pending')).body.length, 0);
    assert.equal((await second.req<SessionMessage[]>('GET', `/api/sessions/${session.id}/messages`)).body.length, 1);
    await second.app.close();
  });

  test('/ws streams events to clients', async () => {
    const t = await setup();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const received: ServerEvent[] = [];
    ws.onmessage = (m) => received.push(JSON.parse(String(m.data)));

    const project = await t.createProject('alpha');
    const session = await t.startSession(project.id, 'over ws');
    await t.waitFor((e) => e.type === 'task_done');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(received.some((e) => e.type === 'task_done' && e.sessionId === session.id));
    ws.close();
    await t.app.close();
  });
});
