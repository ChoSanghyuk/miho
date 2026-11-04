import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Decision, Project, Role, ServerEvent, Session, SessionMessage } from '@orch/shared';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import type { SessionManagerFactory } from './sessions/types.js';
import { FakeSessionManager } from './sessions/fake.js';

let root: string;
const TOKEN = 'test-owner-token';

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

async function setup(
  dbFile = `db-${Math.random()}.sqlite`,
  sessionManager: SessionManagerFactory = (host) => new FakeSessionManager(host),
) {
  const { app, orch } = await buildApp({
    config: config(),
    dbPath: path.join(root, dbFile),
    sessionManager,
    ownerToken: TOKEN,
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
    const res = await app.inject({ method: method as 'GET', url, payload, headers: { authorization: `Bearer ${TOKEN}` } });
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
    const [listed] = (await t.req<Session[]>('GET', `/api/projects/${project.id}/sessions`)).body;
    assert.equal(listed?.status, 'terminated');
    assert.ok(listed?.endedAt);
    assert.equal(listed?.claudeSessionId, `fake-${session.id}`);

    // A message to a terminated session resumes it
    assert.equal((await t.req('POST', `/api/sessions/${session.id}/messages`, { text: 'back' })).status, 202);
    await t.waitFor((e) => e.type === 'task_done' && e.result === 'Echo: back');
    const [resumed] = (await t.req<Session[]>('GET', `/api/projects/${project.id}/sessions`)).body;
    assert.equal(resumed?.status, 'idle');
    assert.equal(resumed?.endedAt, null);
    await t.app.close();
  });

  test('rejects workdirs outside rootDir or missing', async () => {
    const t = await setup();
    assert.equal((await t.req('POST', '/api/projects', { name: 'x', workdir: '/etc' })).status, 400);
    assert.equal((await t.req('POST', '/api/projects', { name: 'x', workdir: '../' })).status, 400);
    assert.equal((await t.req('POST', '/api/projects', { name: 'x', workdir: 'nope' })).status, 404);
    assert.equal((await t.req('POST', '/api/projects', { name: '' })).status, 400);
    await t.app.close();
  });

  test('creates a missing workdir only when asked', async () => {
    const t = await setup();
    const res = await t.req<Project>('POST', '/api/projects', { name: 'made', workdir: 'new/dir', createDir: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.workdir, path.join(root, 'new', 'dir'));
    assert.ok(statSync(res.body.workdir).isDirectory());
    await t.app.close();
  });

  test('rejects duplicate project names', async () => {
    const t = await setup();
    await t.createProject('alpha');
    assert.equal((await t.req('POST', '/api/projects', { name: 'alpha', workdir: 'beta' })).status, 409);
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

    // The interrupted session resumes with the next message
    assert.equal((await second.req('POST', `/api/sessions/${session.id}/messages`, { text: 'continue' })).status, 202);
    await second.waitFor((e) => e.type === 'task_done' && e.result === 'Echo: continue');
    await second.app.close();
  });

  test('/ws streams events to clients', async () => {
    const t = await setup();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as { port: number };
    // Same credential the dashboard uses: the login cookie. (Node's WebSocket accepts headers; browsers can't.)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `orch_token=${TOKEN}` } } as never);
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

describe('roles', () => {
  test('CRUD for predefined roles', async () => {
    const t = await setup();
    const pm = await t.req<Role>('POST', '/api/roles', { name: 'Product Manager', description: 'Owns the spec.' });
    assert.equal(pm.status, 201);
    assert.equal((await t.req('POST', '/api/roles', { name: 'Product Manager', description: '' })).status, 409);
    assert.equal((await t.req('POST', '/api/roles', { name: '../x', description: '' })).status, 400);
    assert.equal((await t.req('POST', '/api/roles', { name: 'a/b', description: '' })).status, 400);
    const upd = await t.req<Role>('PUT', `/api/roles/${pm.body.id}`, { name: 'PM', description: 'Writes specs.' });
    assert.equal(upd.body.name, 'PM');
    assert.deepEqual(
      (await t.req<Role[]>('GET', '/api/roles')).body.map((r) => [r.name, r.description]),
      [['PM', 'Writes specs.']],
    );
    assert.equal((await t.req('DELETE', `/api/roles/${pm.body.id}`)).status, 204);
    assert.equal((await t.req('DELETE', `/api/roles/${pm.body.id}`)).status, 404);
    assert.equal((await t.req('PUT', '/api/roles/nope', { name: 'x', description: '' })).status, 404);
    await t.app.close();
  });

  test('project with roles gets a CLAUDE.md per role, keeping existing ones', async () => {
    const t = await setup();
    mkdirSync(path.join(root, 'team', 'frontend'), { recursive: true });
    writeFileSync(path.join(root, 'team', 'frontend', 'CLAUDE.md'), 'mine');
    const roles = [
      { name: 'backend', description: 'Builds the API.' },
      { name: 'frontend', description: 'Builds the UI.' },
    ];
    const dup = await t.req('POST', '/api/projects', { name: 'team', workdir: 'team', roles: [roles[0], roles[0]] });
    assert.equal(dup.status, 400);
    const res = await t.req<Project>('POST', '/api/projects', { name: 'team', workdir: 'team', roles });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.roles, ['backend', 'frontend']);
    assert.equal(readFileSync(path.join(root, 'team', 'backend', 'CLAUDE.md'), 'utf8'), '# Role: backend\n\nBuilds the API.\n');
    assert.equal(readFileSync(path.join(root, 'team', 'frontend', 'CLAUDE.md'), 'utf8'), 'mine');
    await t.app.close();
  });

  test('a role session runs in the role folder', async () => {
    const workdirs: string[] = [];
    const t = await setup(undefined, (host) => {
      const m = new FakeSessionManager(host);
      return {
        start: (id, opts) => (workdirs.push(opts.workdir), m.start(id, opts)),
        send: (id, text) => m.send(id, text),
        interrupt: (id) => m.interrupt(id),
        stop: (id) => m.stop(id),
      };
    });
    const project = (
      await t.req<Project>('POST', '/api/projects', {
        name: 'crew',
        workdir: 'crew',
        createDir: true,
        roles: [{ name: 'qa', description: 'Tests things.' }],
      })
    ).body;
    const bad = await t.req('POST', `/api/projects/${project.id}/sessions`, { prompt: 'hi', role: 'nope' });
    assert.equal(bad.status, 400);
    const s = await t.req<Session>('POST', `/api/projects/${project.id}/sessions`, { prompt: 'hi', role: 'qa' });
    assert.equal(s.body.role, 'qa');
    await t.startSession(project.id, 'root');
    assert.deepEqual(workdirs, [path.join(root, 'crew', 'qa'), path.join(root, 'crew')]);
    await t.app.close();
  });
});

describe('client errors', () => {
  test('malformed or empty JSON bodies get 400, not 500', async () => {
    const { app } = await setup();
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const empty = await app.inject({ method: 'POST', url: '/api/projects', headers });
    assert.equal(empty.statusCode, 400);
    const broken = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: '{nope' });
    assert.equal(broken.statusCode, 400);
    await app.close();
  });
});

describe('owner token', () => {
  test('rejects missing or wrong tokens, accepts bearer and login cookie', async () => {
    const { app } = await setup();
    const get = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/api/projects', headers });

    assert.equal((await get()).statusCode, 401);
    assert.equal((await get({ authorization: 'Bearer nope' })).statusCode, 401);
    assert.equal((await get({ authorization: `Bearer ${TOKEN}` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/ws' })).statusCode, 401);

    const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { token: 'nope' } });
    assert.equal(bad.statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: TOKEN } });
    assert.equal(login.statusCode, 204);
    const cookie = String(login.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/);
    assert.equal((await get({ cookie: cookie.split(';')[0]! })).statusCode, 200);
    assert.equal((await get({ cookie: 'orch_token=%E0%A4%A' })).statusCode, 401);
    await app.close();
  });
});
