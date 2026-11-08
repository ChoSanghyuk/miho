import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Decision, Guideline, Project, Role, ServerEvent, Session, SessionMessage, Task, TasksResponse } from '@orch/shared';
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

  test('delete project removes its records but keeps the directory', async () => {
    const t = await setup();
    const project = await t.createProject('alpha');
    writeFileSync(path.join(root, 'alpha', 'keep.txt'), 'x');
    const session = await t.startSession(project.id, '[decision]');
    await t.waitFor((e) => e.type === 'decision_needed');
    assert.equal((await t.req('DELETE', `/api/projects/${project.id}`)).status, 409);

    assert.equal((await t.req('POST', `/api/sessions/${session.id}/interrupt`)).status, 204);
    await t.req('POST', '/api/tasks', { projectId: project.id, name: 't', content: 'c', parallel: false });
    assert.equal((await t.req('DELETE', `/api/projects/${project.id}`)).status, 204);

    assert.deepEqual((await t.req<Project[]>('GET', '/api/projects')).body, []);
    assert.equal((await t.req('GET', `/api/sessions/${session.id}`)).status, 404);
    assert.deepEqual((await t.req<Decision[]>('GET', '/api/decisions')).body, []);
    assert.deepEqual((await t.req<TasksResponse>('GET', '/api/tasks')).body.tasks, []);
    assert.equal(readFileSync(path.join(root, 'alpha', 'keep.txt'), 'utf8'), 'x');
    assert.equal((await t.req('DELETE', `/api/projects/${project.id}`)).status, 404);
    await t.createProject('alpha'); // the name and folder are free again
    rmSync(path.join(root, 'alpha', 'keep.txt'));
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

  test('a multi-select question takes several options or free text', async () => {
    const t = await setup();
    const project = await t.createProject('alpha');
    await t.startSession(project.id, '[question]');
    const needed = await t.waitFor((e) => e.type === 'decision_needed');
    assert.ok(needed.type === 'decision_needed' && needed.decision.kind === 'question');
    assert.equal(needed.decision.payload.multiSelect, true);
    const id = needed.decision.id;

    assert.equal((await t.req('POST', `/api/decisions/${id}`, { answer: { choice: '' } })).status, 400);
    assert.equal((await t.req('POST', `/api/decisions/${id}`, { answer: { behavior: 'allow' } })).status, 400);
    assert.equal((await t.req('POST', `/api/decisions/${id}`, { answer: { choice: 'a, c' } })).status, 200);
    const done = await t.waitFor((e) => e.type === 'task_done');
    assert.ok(done.type === 'task_done' && done.result.endsWith('(answer: a, c)'));
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

  test('CRUD for guidelines; a guideline in use cannot be deleted', async () => {
    const t = await setup();
    const g = await t.req<Guideline>('POST', '/api/guidelines', { name: 'Git', description: 'Small commits.' });
    assert.equal(g.status, 201);
    assert.equal((await t.req('POST', '/api/guidelines', { name: 'Git', description: '' })).status, 409);
    const upd = await t.req<Guideline>('PUT', `/api/guidelines/${g.body.id}`, { name: 'Git rules', description: 'Tiny commits.' });
    assert.equal(upd.body.name, 'Git rules');
    assert.equal((await t.req<Guideline[]>('GET', '/api/guidelines')).body.length, 1);
    assert.equal((await t.req('PUT', '/api/guidelines/nope', { name: 'x', description: '' })).status, 404);
    const role = await t.req<Role>('POST', '/api/roles', { name: 'dev', description: '', guidelineIds: [g.body.id], descriptionIndex: 1 });
    const inUse = await t.req<{ error: string }>('DELETE', `/api/guidelines/${g.body.id}`);
    assert.equal(inUse.status, 409);
    assert.match(inUse.body.error, /dev/);
    await t.req('DELETE', `/api/roles/${role.body.id}`);
    assert.equal((await t.req('DELETE', `/api/guidelines/${g.body.id}`)).status, 204);
    assert.equal((await t.req('DELETE', `/api/guidelines/${g.body.id}`)).status, 404);
    await t.app.close();
  });

  test('role content composes guidelines in the chosen order, live', async () => {
    const t = await setup();
    const g1 = (await t.req<Guideline>('POST', '/api/guidelines', { name: 'G1', description: 'one' })).body;
    const g2 = (await t.req<Guideline>('POST', '/api/guidelines', { name: 'G2', description: 'two' })).body;
    const body = (ids: string[], idx: number) => ({ name: 'pm', description: 'own', guidelineIds: ids, descriptionIndex: idx });
    assert.equal((await t.req('POST', '/api/roles', body(['nope'], 0))).status, 400);
    assert.equal((await t.req('POST', '/api/roles', body([g1.id, g1.id], 0))).status, 400);
    assert.equal((await t.req('POST', '/api/roles', body([g1.id], 2))).status, 400);
    const role = await t.req<Role>('POST', '/api/roles', body([g2.id, g1.id], 1));
    assert.equal(role.status, 201);
    assert.equal(role.body.content, '## G2\n\ntwo\n\nown\n\n## G1\n\none');
    await t.req('PUT', `/api/guidelines/${g1.id}`, { name: 'G1', description: 'uno' });
    const [listed] = (await t.req<Role[]>('GET', '/api/roles')).body;
    assert.equal(listed?.content, '## G2\n\ntwo\n\nown\n\n## G1\n\nuno');
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

  test('roles can be added to an existing project', async () => {
    const t = await setup();
    const project = (await t.req<Project>('POST', '/api/projects', { name: 'later', workdir: 'later', createDir: true })).body;
    assert.deepEqual(project.roles, []);
    const res = await t.req<Project>('POST', `/api/projects/${project.id}/roles`, { name: 'qa', description: 'Tests.' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.roles, ['qa']);
    assert.equal(readFileSync(path.join(root, 'later', 'qa', 'CLAUDE.md'), 'utf8'), '# Role: qa\n\nTests.\n');
    assert.equal((await t.req('POST', `/api/projects/${project.id}/roles`, { name: 'qa', description: '' })).status, 409);
    assert.equal((await t.req('POST', `/api/projects/${project.id}/roles`, { name: '../x', description: '' })).status, 400);
    assert.equal((await t.req('POST', '/api/projects/nope/roles', { name: 'dev', description: '' })).status, 404);
    mkdirSync(path.join(root, 'later', 'dev'));
    writeFileSync(path.join(root, 'later', 'dev', 'CLAUDE.md'), 'mine');
    const two = await t.req<Project>('POST', `/api/projects/${project.id}/roles`, { name: 'dev', description: 'Codes.' });
    assert.deepEqual(two.body.roles, ['qa', 'dev']);
    assert.equal(readFileSync(path.join(root, 'later', 'dev', 'CLAUDE.md'), 'utf8'), 'mine');
    assert.deepEqual((await t.req<Project[]>('GET', '/api/projects')).body.find((p) => p.id === project.id)?.roles, ['qa', 'dev']);
    const s = await t.req<Session>('POST', `/api/projects/${project.id}/sessions`, { prompt: 'hi', role: 'qa' });
    assert.equal(s.status, 201);
    await t.app.close();
  });

  test('a project role CLAUDE.md can be read and updated', async () => {
    const t = await setup();
    const project = (
      await t.req<Project>('POST', '/api/projects', {
        name: 'edit',
        workdir: 'edit',
        createDir: true,
        roles: [{ name: 'qa', description: 'Tests.' }],
      })
    ).body;
    const url = `/api/projects/${project.id}/roles/qa`;
    assert.deepEqual((await t.req('GET', url)).body, { name: 'qa', content: '# Role: qa\n\nTests.\n' });
    const res = await t.req('PUT', url, { content: '# Role: qa\n\nTests everything.\n' });
    assert.equal(res.status, 200);
    assert.equal(readFileSync(path.join(root, 'edit', 'qa', 'CLAUDE.md'), 'utf8'), '# Role: qa\n\nTests everything.\n');
    assert.equal((await t.req('PUT', `/api/projects/${project.id}/roles/dev`, { content: '' })).status, 404);
    assert.equal((await t.req('PUT', url, {})).status, 400);
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

describe('tasks', () => {
  async function tasksSetup(dbFile?: string) {
    const t = await setup(dbFile);
    const createTask = async (projectId: string, name: string, extra: { parallel?: boolean; role?: string; content?: string } = {}) =>
      (
        await t.req<Task>('POST', '/api/tasks', {
          projectId,
          name,
          content: extra.content ?? name,
          parallel: extra.parallel ?? false,
          ...(extra.role ? { role: extra.role } : {}),
        })
      ).body;
    const list = async () => (await t.req<TasksResponse>('GET', '/api/tasks')).body;
    const task = async (id: string) => (await list()).tasks.find((x) => x.id === id)!;
    const run = (id: string) => t.req('PUT', `/api/tasks/${id}/status`, { status: 'run' });
    /** Polls until the task reaches the status. */
    const waitTask = async (id: string, status: Task['status']) => {
      for (let i = 0; i < 200; i++) {
        const x = await task(id);
        if (x.status === status) return x;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`Timed out waiting for task ${status}; is ${(await task(id)).status}`);
    };
    return { ...t, createTask, list, task, run, waitTask };
  }

  test('a task waits until switched to run, then runs in a fresh session', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const a = await t.createTask(project.id, 'first', { content: 'do it' });
    assert.equal(a.status, 'wait');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await t.task(a.id)).status, 'wait');

    assert.equal((await t.run(a.id)).status, 200);
    const done = await t.waitTask(a.id, 'done');
    assert.ok(done.sessionId);
    const history = (await t.req<SessionMessage[]>('GET', `/api/sessions/${done.sessionId}/messages`)).body;
    assert.equal((history[0]!.body as { text: string }).text, 'do it');
    assert.equal((await t.run(a.id)).status, 409); // done can't be changed
    await t.app.close();
  });

  test('grouped tasks run in order and share the session of the same project+role', async () => {
    const t = await tasksSetup();
    const alpha = await t.createProject('alpha');
    const beta = await t.createProject('beta');
    const a = await t.createTask(alpha.id, 'a');
    const b = await t.createTask(alpha.id, 'b');
    const c = await t.createTask(beta.id, 'c');
    // drop a on b → [a, b]; then append c to the group
    assert.equal((await t.req('PUT', `/api/tasks/${a.id}/position`, { before: b.id })).status, 204);
    const groupId = (await t.task(a.id)).groupId!;
    assert.equal((await t.req('PUT', `/api/tasks/${c.id}/position`, { groupId })).status, 204);
    assert.deepEqual(
      (await t.list()).tasks.filter((x) => x.groupId === groupId).sort((x, y) => x.position - y.position).map((x) => x.name),
      ['a', 'b', 'c'],
    );

    // Run b and c first: they must wait for a.
    await t.run(c.id);
    await t.run(b.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await t.task(b.id)).status, 'run');
    assert.equal((await t.task(c.id)).status, 'run');

    await t.run(a.id);
    const doneC = await t.waitTask(c.id, 'done');
    const doneA = await t.task(a.id);
    const doneB = await t.task(b.id);
    assert.equal(doneA.status, 'done');
    assert.equal(doneB.sessionId, doneA.sessionId);
    assert.notEqual(doneC.sessionId, doneA.sessionId);
    const history = (await t.req<SessionMessage[]>('GET', `/api/sessions/${doneA.sessionId}/messages`)).body;
    assert.deepEqual(
      history.filter((m) => m.role === 'user').map((m) => (m.body as { text: string }).text),
      ['a', 'b'],
    );

    // Done tasks can't be moved or switched back.
    assert.equal((await t.req('PUT', `/api/tasks/${c.id}/position`, {})).status, 409);
    assert.equal((await t.req('PUT', `/api/tasks/${a.id}/status`, { status: 'wait' })).status, 409);
    await t.app.close();
  });

  test('group run activates all members; ungrouping the last but one dissolves the group', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const a = await t.createTask(project.id, 'a');
    const b = await t.createTask(project.id, 'b');
    await t.req('PUT', `/api/tasks/${b.id}/position`, { before: a.id });
    await t.req('PUT', `/api/tasks/${a.id}/position`, {});
    assert.equal((await t.task(b.id)).groupId, null);

    await t.req('PUT', `/api/tasks/${b.id}/position`, { before: a.id });
    const groupId = (await t.task(a.id)).groupId!;
    assert.equal((await t.req('POST', `/api/task-groups/${groupId}/run`)).status, 204);
    await t.waitTask(a.id, 'done');
    assert.equal((await t.task(b.id)).status, 'done');
    assert.equal((await t.req('POST', '/api/task-groups/nope/run')).status, 404);
    await t.app.close();
  });

  test('a task can be edited until it is working or done; the run uses the new content', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const a = await t.createTask(project.id, 'first', { content: 'old' });
    const edited = await t.req<Task>('PUT', `/api/tasks/${a.id}`, { name: 'renamed', content: 'new' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, 'renamed');
    assert.equal((await t.req('PUT', `/api/tasks/${a.id}`, { name: 'x', content: '' })).status, 400);
    assert.equal((await t.req('PUT', '/api/tasks/nope', { name: 'x', content: 'y' })).status, 404);

    await t.run(a.id);
    const done = await t.waitTask(a.id, 'done');
    const history = (await t.req<SessionMessage[]>('GET', `/api/sessions/${done.sessionId}/messages`)).body;
    assert.equal((history[0]!.body as { text: string }).text, 'new');
    assert.equal((await t.req('PUT', `/api/tasks/${a.id}`, { name: 'x', content: 'y' })).status, 409);
    await t.app.close();
  });

  test('parallel tasks cannot be grouped', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const p = await t.createTask(project.id, 'p', { parallel: true });
    const s = await t.createTask(project.id, 's');
    assert.equal((await t.req('PUT', `/api/tasks/${p.id}/position`, { before: s.id })).status, 400);
    assert.equal((await t.req('PUT', `/api/tasks/${s.id}/position`, { before: p.id })).status, 400);
    await t.app.close();
  });

  test('non-parallel tasks run one at a time per project; parallel ones alongside', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const first = await t.createTask(project.id, 'first', { content: '[decision] first' });
    const second = await t.createTask(project.id, 'second');
    const par = await t.createTask(project.id, 'par', { parallel: true });
    await t.run(first.id);
    await t.waitFor((e) => e.type === 'decision_needed');
    await t.run(second.id);
    await t.run(par.id);
    await t.waitTask(par.id, 'done');
    assert.equal((await t.task(second.id)).status, 'run');

    const [decision] = (await t.req<Decision[]>('GET', '/api/decisions?status=pending')).body;
    await t.req('POST', `/api/decisions/${decision!.id}`, { answer: { behavior: 'allow' } });
    await t.waitTask(second.id, 'done');
    await t.app.close();
  });

  test('a usage limit pauses the queue and the task continues after the reset', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const a = await t.createTask(project.id, 'a', { content: '[limit]' });
    await t.run(a.id);
    await t.waitFor((e) => e.type === 'limit_reached');
    const paused = await t.list();
    assert.ok(paused.pausedUntil);
    assert.equal(paused.tasks[0]!.status, 'run');

    const done = await t.waitTask(a.id, 'done');
    assert.equal((await t.list()).pausedUntil, null);
    const history = (await t.req<SessionMessage[]>('GET', `/api/sessions/${done.sessionId}/messages`)).body;
    assert.equal((history.filter((m) => m.role === 'user').at(-1)!.body as { text: string }).text, 'Continue where you left off.');
    await t.app.close();
  });

  test('interrupting a working task fails it; retry runs it again', async () => {
    const t = await tasksSetup();
    const project = await t.createProject('alpha');
    const a = await t.createTask(project.id, 'a', { content: '[decision]' });
    await t.run(a.id);
    await t.waitFor((e) => e.type === 'decision_needed');
    const { sessionId } = await t.task(a.id);
    assert.equal((await t.req('DELETE', `/api/tasks/${a.id}`)).status, 409);
    await t.req('POST', `/api/sessions/${sessionId}/interrupt`);
    assert.equal((await t.task(a.id)).status, 'failed');

    await t.run(a.id);
    const retried = await t.waitTask(a.id, 'working');
    assert.notEqual(retried.sessionId, sessionId);
    await t.app.close();
  });

  test('working tasks continue after a restart', async () => {
    const first = await tasksSetup('tasks-restart.sqlite');
    const project = await first.createProject('alpha');
    const a = await first.createTask(project.id, 'a', { content: '[decision]' });
    await first.run(a.id);
    await first.waitFor((e) => e.type === 'decision_needed');
    const { sessionId } = await first.task(a.id);
    await first.app.close();

    const second = await tasksSetup('tasks-restart.sqlite');
    const done = await second.waitTask(a.id, 'done');
    assert.equal(done.sessionId, sessionId);
    await second.app.close();
  });
});

describe('delegation', () => {
  const ROLES = ['pm', 'backend', 'frontend'].map((name) => ({ name, description: name }));

  async function teamSetup(dbFile?: string, dir = `team-${Math.random()}`) {
    const t = await setup(dbFile);
    const project =
      (await t.req<Project[]>('GET', '/api/projects')).body.find((p) => p.name === dir) ??
      (await t.req<Project>('POST', '/api/projects', { name: dir, workdir: dir, createDir: true, roles: ROLES })).body;
    const startLead = async (prompt: string) =>
      (await t.req<Session>('POST', `/api/projects/${project.id}/sessions`, { prompt, role: 'pm' })).body;
    const delegations = async (leadId: string) =>
      (await t.req<TasksResponse>('GET', '/api/tasks')).body.tasks
        .filter((x) => x.delegatedBy === leadId)
        .sort((x, y) => x.position - y.position);
    const history = async (id: string) => (await t.req<SessionMessage[]>('GET', `/api/sessions/${id}/messages`)).body;
    const reportsTo = async (leadId: string) =>
      (await history(leadId)).filter((m) => m.role === 'system').map((m) => (m.body as { text: string }).text).join('\n');
    /** Polls until the predicate holds. */
    const until = async (pred: () => Promise<boolean>) => {
      for (let i = 0; i < 300; i++) {
        if (await pred()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('Timed out');
    };
    const settled = (leadId: string) => async () => {
      const ds = await delegations(leadId);
      const lead = (await t.req<Session>('GET', `/api/sessions/${leadId}`)).body;
      return ds.length > 0 && ds.every((d) => (d.status === 'done' || d.status === 'failed') && d.report === null) && lead.status === 'idle';
    };
    return { ...t, dir, project, startLead, delegations, history, reportsTo, until, settled };
  }

  test('a lead hands work to roles one at a time; results come back; a role keeps its session', async () => {
    const t = await teamSetup();
    const lead = await t.startLead('[delegate:backend] build api\n[delegate:frontend] build ui');
    await t.until(t.settled(lead.id));

    const [be, fe] = await t.delegations(lead.id);
    assert.deepEqual([be!.role, fe!.role, be!.groupId, fe!.parallel], ['backend', 'frontend', lead.id, false]);
    assert.ok(be!.sessionId && fe!.sessionId && be!.sessionId !== fe!.sessionId);
    const worker = (await t.req<Session>('GET', `/api/sessions/${be!.sessionId}`)).body;
    assert.equal(worker.role, 'backend');
    const reports = await t.reportsTo(lead.id);
    assert.match(reports, /backend — done[\s\S]*Echo: build api/);
    assert.match(reports, /frontend — done[\s\S]*Echo: build ui/);

    // Only the lead's last turn is a final task_done.
    const dones = t.events.filter((e) => e.type === 'task_done');
    assert.ok(dones.filter((e) => e.sessionId !== lead.id).every((e) => e.type === 'task_done' && e.intermediate));
    assert.equal(dones.filter((e) => e.type === 'task_done' && !e.intermediate).length, 1);

    // Second round: backend continues in its session.
    await t.req('POST', `/api/sessions/${lead.id}/messages`, { text: '[delegate:backend] fix api' });
    await t.until(async () => (await t.delegations(lead.id)).length === 3 && (await t.settled(lead.id))());
    const third = (await t.delegations(lead.id))[2]!;
    assert.equal(third.sessionId, be!.sessionId);
    await t.app.close();
  });

  test('refuses unknown roles, its own role, and delegation from a worker', async () => {
    const t = await teamSetup();
    const lead = await t.startLead('[delegate:nobody] x\n[delegate:pm] y\n[delegate:backend] [delegate:frontend] z');
    await t.until(t.settled(lead.id));
    const done = t.events.find((e) => e.type === 'task_done' && e.sessionId === lead.id);
    assert.ok(done?.type === 'task_done');
    assert.equal(done.result.match(/delegate refused: Unknown role/g)?.length, 2);
    assert.equal((await t.delegations(lead.id)).length, 1);
    assert.match(await t.reportsTo(lead.id), /delegate refused: A session doing delegated work cannot delegate/);
    await t.app.close();
  });

  test("a worker's question goes to the owner", async () => {
    const t = await teamSetup();
    const lead = await t.startLead('[delegate:backend] [decision] migrate');
    const needed = await t.waitFor((e) => e.type === 'decision_needed');
    assert.ok(needed.type === 'decision_needed');
    const [task] = await t.delegations(lead.id);
    assert.equal(needed.decision.sessionId, task!.sessionId);
    await t.req('POST', `/api/decisions/${needed.decision.id}`, { answer: { behavior: 'allow' } });
    await t.until(t.settled(lead.id));
    assert.match(await t.reportsTo(lead.id), /permission: allow/);
    await t.app.close();
  });

  test('a failed delegation is reported and does not block the next one', async () => {
    const t = await teamSetup();
    const lead = await t.startLead('[delegate:backend] [decision] a\n[delegate:frontend] b');
    await t.waitFor((e) => e.type === 'decision_needed');
    const [be] = await t.delegations(lead.id);
    await t.req('POST', `/api/sessions/${be!.sessionId}/interrupt`);
    await t.until(t.settled(lead.id));
    const [failed, ok] = await t.delegations(lead.id);
    assert.deepEqual([failed!.status, ok!.status], ['failed', 'done']);
    assert.match(await t.reportsTo(lead.id), /backend — failed[\s\S]*Interrupted by the owner/);
    await t.app.close();
  });

  test("interrupting the lead cancels its delegations and reports nothing", async () => {
    const t = await teamSetup();
    const lead = await t.startLead('[delegate:backend] [decision] a\n[delegate:frontend] b');
    await t.waitFor((e) => e.type === 'decision_needed');
    // The lead's own turn is over; make it busy again so interrupt is allowed.
    await t.req('POST', `/api/sessions/${lead.id}/messages`, { text: '[decision] wait' });
    await t.until(async () => (await t.req<Decision[]>('GET', '/api/decisions?status=pending')).body.length === 2);
    assert.equal((await t.req('POST', `/api/sessions/${lead.id}/interrupt`)).status, 204);

    const ds = await t.delegations(lead.id);
    assert.deepEqual(ds.map((d) => [d.status, d.report]), [['failed', null], ['failed', null]]);
    assert.equal((await t.req<Decision[]>('GET', '/api/decisions?status=pending')).body.length, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await t.reportsTo(lead.id), '');
    await t.app.close();
  });

  test('caps delegations per owner message', async () => {
    const t = await teamSetup();
    const lines = Array.from({ length: 21 }, (_, i) => `[delegate:backend] t${i}`).join('\n');
    const lead = await t.startLead(lines);
    await t.until(t.settled(lead.id));
    assert.equal((await t.delegations(lead.id)).length, 20);
    const done = t.events.find((e) => e.type === 'task_done' && e.sessionId === lead.id);
    assert.ok(done?.type === 'task_done' && done.result.includes('Delegation limit (20) reached'));
    await t.app.close();
  });

  test('a delegation run survives a restart', async () => {
    const first = await teamSetup('team-restart.sqlite', 'team-restart');
    const lead = await first.startLead('[delegate:backend] [decision] a');
    await first.waitFor((e) => e.type === 'decision_needed');
    await first.app.close();

    const second = await teamSetup('team-restart.sqlite', 'team-restart');
    await second.until(second.settled(lead.id));
    assert.match(await second.reportsTo(lead.id), /backend — done[\s\S]*Continue where you left off/);
    await second.app.close();
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
