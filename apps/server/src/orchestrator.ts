import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  AnswerDecisionRequest,
  AnsweredVia,
  CreateProjectRequest,
  Decision,
  Guideline,
  GuidelineRequest,
  MessageRole,
  Project,
  Role,
  RoleInput,
  RoleRequest,
  Session,
  SessionMessage,
  SessionStatus,
  StartSessionRequest,
} from '@orch/shared';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { decisions, guidelines, messages, projects, roles, sessions } from './db/schema.js';
import { EventBus } from './events.js';
import type { SessionHost, SessionManager, SessionManagerFactory } from './sessions/types.js';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type DecisionAnswer = NonNullable<Decision['answer']>;
type Waiter = { sessionId: string; resolve: (a: DecisionAnswer) => void; reject: (e: Error) => void };

const now = () => new Date().toISOString();

/** A role session runs in its role folder, so Claude Code loads that role's CLAUDE.md. */
const sessionCwd = (project: Project, role: string | null) => (role ? path.join(project.workdir, role) : project.workdir);

/** A role's CLAUDE.md body: its guidelines as `## name` sections, with its own text at descriptionIndex. */
function composeRole(
  role: { description: string; guidelineIds: string[]; descriptionIndex: number },
  byId: Map<string, Guideline>,
): string {
  const parts = role.guidelineIds.map((id) => {
    const g = byId.get(id)!;
    return `## ${g.name}\n\n${g.description}`;
  });
  parts.splice(role.descriptionIndex, 0, role.description);
  return parts.filter((p) => p.trim()).join('\n\n');
}

/** Role names double as folder names: no slashes, no leading dot. */
function assertRoleName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name)) {
    throw new HttpError(400, `invalid role name "${name}": use letters, digits, space, _ . - (not starting with . or space)`);
  }
}

/** Creates <workdir>/<role>/CLAUDE.md; an existing CLAUDE.md is kept. */
function writeRoleFolder(workdir: string, role: RoleInput): void {
  const dir = path.join(workdir, role.name);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, 'CLAUDE.md'), `# Role: ${role.name}\n\n${role.description}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/** Owns all state. The API and Telegram call it; the session manager reports back through SessionHost. */
export class Orchestrator implements SessionHost {
  readonly bus = new EventBus();
  private manager: SessionManager;
  private waiters = new Map<string, Waiter>();

  constructor(
    private db: Db,
    private config: Config,
    managerFactory: SessionManagerFactory,
  ) {
    this.manager = managerFactory(this);
    this.recoverAfterRestart();
  }

  // ---- Projects ----

  createProject(req: CreateProjectRequest): Project {
    const projectRoles = req.roles ?? [];
    projectRoles.forEach((r) => assertRoleName(r.name));
    const names = projectRoles.map((r) => r.name);
    if (new Set(names).size !== names.length) throw new HttpError(400, 'duplicate role names');
    const root = this.config.projects.rootDir;
    const workdir = path.resolve(root, req.workdir.replace(/^~(?=$|\/)/, homedir()));
    const rel = path.relative(root, workdir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new HttpError(400, `workdir must be inside ${root}`);
    }
    if (this.listProjects().some((p) => p.name === req.name)) {
      throw new HttpError(409, `a project named "${req.name}" already exists`);
    }
    if (!existsSync(workdir)) {
      if (!req.createDir) throw new HttpError(404, `workdir does not exist: ${workdir}`);
      mkdirSync(workdir, { recursive: true });
    } else if (!statSync(workdir).isDirectory()) {
      throw new HttpError(400, `workdir is not a directory: ${workdir}`);
    }
    for (const r of projectRoles) writeRoleFolder(workdir, r);
    const project: Project = { id: randomUUID(), name: req.name, workdir, roles: names, createdAt: now() };
    this.db.insert(projects).values(project).run();
    return project;
  }

  addProjectRole(projectId: string, role: RoleInput): Project {
    const project = this.getProject(projectId);
    assertRoleName(role.name);
    if (project.roles.includes(role.name)) throw new HttpError(409, `project already has role "${role.name}"`);
    writeRoleFolder(project.workdir, role);
    const updated = { ...project, roles: [...project.roles, role.name] };
    this.db.update(projects).set({ roles: updated.roles }).where(eq(projects.id, projectId)).run();
    return updated;
  }

  listProjects(): Project[] {
    return this.db.select().from(projects).orderBy(asc(projects.createdAt)).all();
  }

  // ---- Roles (predefined; projects copy them into folders at creation) ----

  listRoles(): Role[] {
    const byId = this.guidelinesById();
    return this.db
      .select()
      .from(roles)
      .orderBy(asc(roles.createdAt))
      .all()
      .map((r) => ({ ...r, content: composeRole(r, byId) }));
  }

  createRole(req: RoleRequest): Role {
    this.assertRoleNameFree(req.name);
    const row = { id: randomUUID(), createdAt: now(), ...this.roleFields(req) };
    this.db.insert(roles).values(row).run();
    return { ...row, content: composeRole(row, this.guidelinesById()) };
  }

  updateRole(id: string, req: RoleRequest): Role {
    const role = this.getRole(id);
    this.assertRoleNameFree(req.name, id);
    const fields = this.roleFields(req);
    this.db.update(roles).set(fields).where(eq(roles.id, id)).run();
    return { ...role, ...fields, content: composeRole(fields, this.guidelinesById()) };
  }

  deleteRole(id: string): void {
    this.getRole(id);
    this.db.delete(roles).where(eq(roles.id, id)).run();
  }

  // ---- Guidelines (shared sections composed into roles) ----

  listGuidelines(): Guideline[] {
    return this.db.select().from(guidelines).orderBy(asc(guidelines.createdAt)).all();
  }

  createGuideline(req: GuidelineRequest): Guideline {
    this.assertGuidelineNameFree(req.name);
    const guideline: Guideline = { id: randomUUID(), name: req.name, description: req.description, createdAt: now() };
    this.db.insert(guidelines).values(guideline).run();
    return guideline;
  }

  updateGuideline(id: string, req: GuidelineRequest): Guideline {
    const guideline = this.getGuideline(id);
    this.assertGuidelineNameFree(req.name, id);
    this.db.update(guidelines).set({ name: req.name, description: req.description }).where(eq(guidelines.id, id)).run();
    return { ...guideline, name: req.name, description: req.description };
  }

  deleteGuideline(id: string): void {
    this.getGuideline(id);
    const users = this.db.select().from(roles).all().filter((r) => r.guidelineIds.includes(id));
    if (users.length) throw new HttpError(409, `guideline is used by roles: ${users.map((r) => r.name).join(', ')}`);
    this.db.delete(guidelines).where(eq(guidelines.id, id)).run();
  }

  // ---- Sessions ----

  listSessions(projectId: string): Session[] {
    this.getProject(projectId);
    return this.db.select().from(sessions).where(eq(sessions.projectId, projectId)).orderBy(asc(sessions.startedAt)).all();
  }

  listMessages(sessionId: string): SessionMessage[] {
    this.getSession(sessionId);
    return this.db
      .select({ id: messages.id, sessionId: messages.sessionId, role: messages.role, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq))
      .all();
  }

  startSession(projectId: string, req: StartSessionRequest): Session {
    const project = this.getProject(projectId);
    if (req.role && !project.roles.includes(req.role)) {
      throw new HttpError(400, `project has no role "${req.role}"`);
    }
    const session: Session = {
      id: randomUUID(),
      projectId,
      role: req.role ?? null,
      claudeSessionId: null,
      status: 'running',
      model: req.model ?? this.config.claude.defaultModel,
      costUsd: 0,
      startedAt: now(),
      endedAt: null,
    };
    this.db.insert(sessions).values(session).run();
    this.output(session.id, 'user', { text: req.prompt });
    this.manager.start(session.id, { workdir: sessionCwd(project, session.role), model: session.model, prompt: req.prompt });
    return session;
  }

  /** Idle sessions take the message directly; interrupted, errored or terminated ones are resumed with it. */
  sendMessage(sessionId: string, text: string): void {
    const session = this.getSession(sessionId);
    if (session.status === 'idle') {
      this.output(sessionId, 'user', { text });
      this.manager.send(sessionId, text);
      return;
    }
    if (!['interrupted', 'error', 'terminated'].includes(session.status)) {
      throw new HttpError(409, `Session is ${session.status}`);
    }
    if (!session.claudeSessionId) throw new HttpError(409, 'Session cannot be resumed: it never started');
    const project = this.getProject(session.projectId);
    this.db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, sessionId)).run();
    this.output(sessionId, 'user', { text });
    this.manager.start(sessionId, {
      workdir: sessionCwd(project, session.role),
      model: session.model,
      prompt: text,
      resume: session.claudeSessionId,
      priorCostUsd: session.costUsd,
    });
  }

  interrupt(sessionId: string): void {
    this.requireStatus(sessionId, ['queued', 'running', 'waiting_decision']);
    this.manager.interrupt(sessionId);
    this.expireDecisions(sessionId);
    this.setStatus(sessionId, 'idle');
  }

  terminate(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.status === 'terminated') throw new HttpError(409, 'Session already terminated');
    this.manager.stop(sessionId);
    this.expireDecisions(sessionId);
    this.db.update(sessions).set({ endedAt: now() }).where(eq(sessions.id, sessionId)).run();
    this.setStatus(sessionId, 'terminated');
  }

  /** Stops every live Claude process. Statuses are left as-is; the next startup marks them interrupted. */
  shutdown(): void {
    const live = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.status, ['queued', 'running', 'waiting_decision', 'idle']))
      .all();
    for (const { id } of live) this.manager.stop(id);
  }

  // ---- Decisions ----

  listDecisions(status?: Decision['status']): Decision[] {
    const query = this.db.select().from(decisions);
    const rows = status ? query.where(eq(decisions.status, status)).all() : query.all();
    return rows.map(toDecision);
  }

  answerDecision(decisionId: string, { answer }: AnswerDecisionRequest, via: AnsweredVia): Decision {
    const row = this.db.select().from(decisions).where(eq(decisions.id, decisionId)).get();
    if (!row) throw new HttpError(404, 'Decision not found');
    if (row.status !== 'pending') throw new HttpError(409, `Decision already ${row.status}`);
    if (row.kind === 'permission' && !('behavior' in answer)) {
      throw new HttpError(400, 'Permission decisions take { behavior: "allow" | "deny" }');
    }
    if (row.kind === 'question') {
      const options = (row.payload as { options: string[] }).options;
      if (!('choice' in answer) || !options.includes(answer.choice)) {
        throw new HttpError(400, `Question decisions take { choice } from: ${options.join(', ')}`);
      }
    }

    this.db.update(decisions).set({ status: 'answered', answeredVia: via, answer }).where(eq(decisions.id, decisionId)).run();
    this.bus.emit({ type: 'decision_resolved', decisionId, answeredVia: via });
    this.setStatus(row.sessionId, 'running');
    this.waiters.get(decisionId)?.resolve(answer);
    this.waiters.delete(decisionId);
    return toDecision({ ...row, status: 'answered', answeredVia: via, answer });
  }

  // ---- SessionHost (called by the session manager) ----

  output(sessionId: string, role: MessageRole, body: unknown): void {
    const message: SessionMessage = { id: randomUUID(), sessionId, role, body, createdAt: now() };
    this.db.insert(messages).values(message).run();
    this.bus.emit({ type: 'session_output', sessionId, message });
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.db.update(sessions).set({ status }).where(eq(sessions.id, sessionId)).run();
    this.bus.emit({ type: 'session_status', sessionId, status });
  }

  requestDecision(sessionId: string, request: Pick<Decision, 'kind' | 'payload'>): Promise<DecisionAnswer> {
    const row = {
      id: randomUUID(),
      sessionId,
      kind: request.kind,
      payload: request.payload,
      status: 'pending' as const,
      answeredVia: null,
      answer: null,
      createdAt: now(),
    };
    this.db.insert(decisions).values(row).run();
    this.setStatus(sessionId, 'waiting_decision');
    this.bus.emit({ type: 'decision_needed', decision: toDecision(row) });
    return new Promise((resolve, reject) => this.waiters.set(row.id, { sessionId, resolve, reject }));
  }

  done(sessionId: string, r: { result: string; costUsd: number; durationMs: number }): void {
    const session = this.getSession(sessionId);
    this.db.update(sessions).set({ costUsd: session.costUsd + r.costUsd }).where(eq(sessions.id, sessionId)).run();
    this.setStatus(sessionId, 'idle');
    this.bus.emit({ type: 'task_done', sessionId, projectId: session.projectId, ...r });
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db.update(sessions).set({ claudeSessionId }).where(eq(sessions.id, sessionId)).run();
  }

  limitReached(sessionId: string, retryAt: string | null): void {
    this.bus.emit({ type: 'limit_reached', sessionId, retryAt });
  }

  fail(sessionId: string, error: string): void {
    this.expireDecisions(sessionId);
    this.setStatus(sessionId, 'error');
    this.bus.emit({ type: 'session_error', sessionId, error });
  }

  // ---- internals ----

  getProject(id: string): Project {
    const project = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) throw new HttpError(404, 'Project not found');
    return project;
  }

  private getRole(id: string) {
    const role = this.db.select().from(roles).where(eq(roles.id, id)).get();
    if (!role) throw new HttpError(404, 'Role not found');
    return role;
  }

  /** Validates and normalizes a role request into stored columns. */
  private roleFields(req: RoleRequest) {
    const guidelineIds = req.guidelineIds ?? [];
    const descriptionIndex = req.descriptionIndex ?? 0;
    const byId = this.guidelinesById();
    const unknown = guidelineIds.find((g) => !byId.has(g));
    if (unknown) throw new HttpError(400, `unknown guideline: ${unknown}`);
    if (new Set(guidelineIds).size !== guidelineIds.length) throw new HttpError(400, 'duplicate guidelines');
    if (!Number.isInteger(descriptionIndex) || descriptionIndex < 0 || descriptionIndex > guidelineIds.length) {
      throw new HttpError(400, `descriptionIndex must be between 0 and ${guidelineIds.length}`);
    }
    return { name: req.name, description: req.description, guidelineIds, descriptionIndex };
  }

  private guidelinesById(): Map<string, Guideline> {
    return new Map(this.listGuidelines().map((g) => [g.id, g]));
  }

  private getGuideline(id: string): Guideline {
    const guideline = this.db.select().from(guidelines).where(eq(guidelines.id, id)).get();
    if (!guideline) throw new HttpError(404, 'Guideline not found');
    return guideline;
  }

  private assertGuidelineNameFree(name: string, exceptId?: string): void {
    if (this.listGuidelines().some((g) => g.name === name && g.id !== exceptId)) {
      throw new HttpError(409, `a guideline named "${name}" already exists`);
    }
  }

  private assertRoleNameFree(name: string, exceptId?: string): void {
    assertRoleName(name);
    if (this.listRoles().some((r) => r.name === name && r.id !== exceptId)) {
      throw new HttpError(409, `a role named "${name}" already exists`);
    }
  }

  getSession(id: string): Session {
    const session = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!session) throw new HttpError(404, 'Session not found');
    return session;
  }

  private requireStatus(sessionId: string, allowed: SessionStatus[]): void {
    const { status } = this.getSession(sessionId);
    if (!allowed.includes(status)) throw new HttpError(409, `Session is ${status}`);
  }

  private expireDecisions(sessionId: string): void {
    const pending = this.db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.sessionId, sessionId), eq(decisions.status, 'pending')))
      .all();
    for (const { id } of pending) {
      this.db.update(decisions).set({ status: 'expired' }).where(eq(decisions.id, id)).run();
      this.bus.emit({ type: 'decision_resolved', decisionId: id, answeredVia: null });
      this.waiters.get(id)?.reject(new Error('Decision cancelled'));
      this.waiters.delete(id);
    }
  }

  /** No Claude process survives a restart: mark live sessions interrupted (resumable) and expire their decisions. */
  private recoverAfterRestart(): void {
    this.db
      .update(sessions)
      .set({ status: 'interrupted' })
      .where(inArray(sessions.status, ['queued', 'running', 'waiting_decision', 'idle']))
      .run();
    this.db.update(decisions).set({ status: 'expired' }).where(eq(decisions.status, 'pending')).run();
  }
}

function toDecision(row: typeof decisions.$inferSelect): Decision {
  const { createdAt: _, ...decision } = row;
  return decision as Decision;
}
