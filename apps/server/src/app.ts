import Fastify, { type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import { openDb } from './db/index.js';
import { HttpError, Orchestrator } from './orchestrator.js';
import type { SessionManagerFactory } from './sessions/types.js';

const roleBody = z.object({ name: z.string().min(1), description: z.string() });
const roleRequestBody = roleBody.extend({
  guidelineIds: z.array(z.string()).optional(),
  descriptionIndex: z.number().int().optional(),
});
const createProjectBody = z.object({
  name: z.string().min(1),
  workdir: z.string().min(1),
  createDir: z.boolean().optional(),
  roles: z.array(roleBody).optional(),
});
const startSessionBody = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
});
const sendMessageBody = z.object({ text: z.string().min(1) });
const answerDecisionBody = z.object({
  answer: z.union([z.object({ behavior: z.enum(['allow', 'deny']) }), z.object({ choice: z.string() })]),
});
const createTaskBody = z.object({
  projectId: z.string().min(1),
  role: z.string().min(1).optional(),
  name: z.string().min(1),
  content: z.string().min(1),
  parallel: z.boolean(),
});
const taskStatusBody = z.object({ status: z.enum(['wait', 'run']) });
const moveTaskBody = z.object({ before: z.string().min(1).optional(), groupId: z.string().min(1).optional() });
const decisionsQuery = z.object({ status: z.enum(['pending', 'answered', 'expired']).optional() });
const idParams = z.object({ id: z.string() });

export async function buildApp(opts: {
  config: Config;
  dbPath: string;
  sessionManager: SessionManagerFactory;
  ownerToken: string;
  /** Built dashboard to serve at `/` (production). Omit in dev, where Vite serves it. */
  dashboardDir?: string;
  logger?: FastifyServerOptions['logger'];
}) {
  const db = openDb(opts.dbPath);
  const orch = new Orchestrator(db, opts.config, opts.sessionManager);
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: z.prettifyError(err) });
    // Fastify's own client errors (malformed JSON, empty JSON body, ...) keep their 4xx status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Internal error' });
  });
  app.addHook('onClose', async () => {
    orch.shutdown();
    db.$client.close();
  });

  registerAuth(app, opts.ownerToken);
  await app.register(websocket);
  if (opts.dashboardDir) await app.register(fastifyStatic, { root: opts.dashboardDir });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/projects', async (req, reply) => {
    reply.status(201);
    return orch.createProject(createProjectBody.parse(req.body));
  });
  app.get('/api/projects', async () => orch.listProjects());
  app.post('/api/projects/:id/roles', async (req, reply) => {
    const project = orch.addProjectRole(idParams.parse(req.params).id, roleBody.parse(req.body));
    reply.status(201);
    return project;
  });

  app.get('/api/roles', async () => orch.listRoles());
  app.post('/api/roles', async (req, reply) => {
    reply.status(201);
    return orch.createRole(roleRequestBody.parse(req.body));
  });
  app.put('/api/roles/:id', async (req) => orch.updateRole(idParams.parse(req.params).id, roleRequestBody.parse(req.body)));
  app.delete('/api/roles/:id', async (req, reply) => {
    orch.deleteRole(idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/api/guidelines', async () => orch.listGuidelines());
  app.post('/api/guidelines', async (req, reply) => {
    reply.status(201);
    return orch.createGuideline(roleBody.parse(req.body));
  });
  app.put('/api/guidelines/:id', async (req) => orch.updateGuideline(idParams.parse(req.params).id, roleBody.parse(req.body)));
  app.delete('/api/guidelines/:id', async (req, reply) => {
    orch.deleteGuideline(idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/sessions', async (req) => orch.listSessions(idParams.parse(req.params).id));
  app.post('/api/projects/:id/sessions', async (req, reply) => {
    reply.status(201);
    return orch.startSession(idParams.parse(req.params).id, startSessionBody.parse(req.body));
  });

  app.get('/api/sessions/:id', async (req) => orch.getSession(idParams.parse(req.params).id));
  app.get('/api/sessions/:id/messages',async (req) => orch.listMessages(idParams.parse(req.params).id));
  app.post('/api/sessions/:id/messages', async (req, reply) => {
    orch.sendMessage(idParams.parse(req.params).id, sendMessageBody.parse(req.body).text);
    return reply.status(202).send();
  });
  app.post('/api/sessions/:id/interrupt', async (req, reply) => {
    orch.interrupt(idParams.parse(req.params).id);
    return reply.status(204).send();
  });
  app.delete('/api/sessions/:id', async (req, reply) => {
    orch.terminate(idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/api/tasks', async () => orch.listTasks());
  app.post('/api/tasks', async (req, reply) => {
    reply.status(201);
    return orch.createTask(createTaskBody.parse(req.body));
  });
  app.put('/api/tasks/:id/status', async (req) =>
    orch.setTaskStatus(idParams.parse(req.params).id, taskStatusBody.parse(req.body).status),
  );
  app.put('/api/tasks/:id/position', async (req, reply) => {
    orch.moveTask(idParams.parse(req.params).id, moveTaskBody.parse(req.body));
    return reply.status(204).send();
  });
  app.delete('/api/tasks/:id', async (req, reply) => {
    orch.deleteTask(idParams.parse(req.params).id);
    return reply.status(204).send();
  });
  app.post('/api/task-groups/:id/run', async (req, reply) => {
    orch.runGroup(idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get('/api/decisions', async (req) => orch.listDecisions(decisionsQuery.parse(req.query).status));
  app.post('/api/decisions/:id', async (req) =>
    orch.answerDecision(idParams.parse(req.params).id, answerDecisionBody.parse(req.body), 'web'),
  );

  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = orch.bus.subscribe((event) => socket.send(JSON.stringify(event)));
    socket.on('close', unsubscribe);
  });

  return { app, orch, db };
}
