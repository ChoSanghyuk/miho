import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type {
  AnswerDecisionRequest,
  AnsweredVia,
  CreateProjectRequest,
  CreateTaskRequest,
  Decision,
  Guideline,
  GuidelineRequest,
  MessageRole,
  Project,
  ProjectRoleFile,
  Role,
  RoleInput,
  RoleRequest,
  Session,
  SessionMessage,
  SessionStatus,
  StartSessionRequest,
  Task,
  TasksResponse,
  UpdateTaskRequest,
} from '@orch/shared';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { decisions, guidelines, messages, projects, roles, sessions, tasks } from './db/schema.js';
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

/** How long the task queue pauses after a usage limit with no known reset time. */
const LIMIT_FALLBACK_MS = 15 * 60_000;
const CONTINUE_PROMPT = 'Continue where you left off.';
const BUSY: SessionStatus[] = ['queued', 'running', 'waiting_decision'];
/** A lead may delegate this many times per owner message, so two sessions can't loop forever. */
const MAX_DELEGATIONS = 20;
const OPEN_TASK: Task['status'][] = ['wait', 'run', 'working'];

/** A role session runs in its role folder, so Claude Code loads that role's CLAUDE.md. */
const sessionCwd = (project: Project, role: string | null) => (role ? path.join(project.workdir, role) : project.workdir);

/** Roles a session may delegate to: the project's other roles. */
const teamOf = (project: Project, role: string | null) => project.roles.filter((r) => r !== role);

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
  /** Set while a usage limit pauses the task queue (memory only). */
  private pausedUntil: string | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduling = false;
  private rescheduled = false;

  constructor(
    private db: Db,
    private config: Config,
    managerFactory: SessionManagerFactory,
  ) {
    this.manager = managerFactory(this);
    this.recoverAfterRestart();
    this.scheduleTasks();
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

  /** A project role's CLAUDE.md. Running sessions keep what they loaded; new and resumed ones read the file again. */
  getProjectRole(projectId: string, role: string): ProjectRoleFile {
    const file = this.roleFile(projectId, role);
    return { name: role, content: existsSync(file) ? readFileSync(file, 'utf8') : '' };
  }

  updateProjectRole(projectId: string, role: string, content: string): ProjectRoleFile {
    const file = this.roleFile(projectId, role);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return { name: role, content };
  }

  private roleFile(projectId: string, role: string): string {
    const project = this.getProject(projectId);
    if (!project.roles.includes(role)) throw new HttpError(404, `project has no role "${role}"`);
    return path.join(project.workdir, role, 'CLAUDE.md');
  }

  /** Removes the project and its sessions, history, decisions and tasks from the DB. The workdir is never touched. */
  deleteProject(id: string): void {
    this.getProject(id);
    const projectSessions = this.db.select().from(sessions).where(eq(sessions.projectId, id)).all();
    const busy = projectSessions.filter((s) => BUSY.includes(s.status));
    if (busy.length) throw new HttpError(409, `Project has ${busy.length} busy session(s); interrupt or terminate them first`);
    const projectTasks = this.db.select().from(tasks).where(eq(tasks.projectId, id)).all();

    const sessionIds = projectSessions.map((s) => s.id);
    for (const s of projectSessions) if (s.status === 'idle') this.manager.stop(s.id);
    this.db.transaction((tx) => {
      if (sessionIds.length) {
        tx.delete(decisions).where(inArray(decisions.sessionId, sessionIds)).run();
        tx.delete(messages).where(inArray(messages.sessionId, sessionIds)).run();
      }
      tx.delete(tasks).where(eq(tasks.projectId, id)).run();
      tx.delete(sessions).where(eq(sessions.projectId, id)).run();
      tx.delete(projects).where(eq(projects.id, id)).run();
    });
    // Groups may mix projects: renumber what is left of each affected group.
    for (const groupId of new Set(projectTasks.map((t) => t.groupId).filter((g) => g !== null))) {
      this.writeGroup(groupId, this.groupMembers(groupId).map((t) => t.id));
    }
    if (projectTasks.length) this.tasksChanged();
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

  /** `worker`: runs a delegated task, so it gets no `delegate` tool. */
  startSession(projectId: string, req: StartSessionRequest, worker = false): Session {
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
    this.manager.start(session.id, {
      workdir: sessionCwd(project, session.role),
      model: session.model,
      prompt: req.prompt,
      team: worker ? undefined : teamOf(project, session.role),
    });
    return session;
  }

  /**
   * Idle sessions take the message directly; interrupted, errored or terminated ones are resumed with it.
   * `as`: how the console shows it; delegation results are `system`.
   */
  sendMessage(sessionId: string, text: string, as: MessageRole = 'user'): void {
    const session = this.getSession(sessionId);
    if (session.status === 'idle') {
      this.output(sessionId, as, { text });
      this.manager.send(sessionId, text);
      return;
    }
    if (!['interrupted', 'error', 'terminated'].includes(session.status)) {
      throw new HttpError(409, `Session is ${session.status}`);
    }
    if (!session.claudeSessionId) throw new HttpError(409, 'Session cannot be resumed: it never started');
    const project = this.getProject(session.projectId);
    this.db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, sessionId)).run();
    this.output(sessionId, as, { text });
    const worker = !!this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.sessionId, sessionId), isNotNull(tasks.delegatedBy)))
      .get();
    this.manager.start(sessionId, {
      workdir: sessionCwd(project, session.role),
      model: session.model,
      prompt: text,
      resume: session.claudeSessionId,
      priorCostUsd: session.costUsd,
      team: worker ? undefined : teamOf(project, session.role),
    });
  }

  interrupt(sessionId: string): void {
    this.requireStatus(sessionId, ['queued', 'running', 'waiting_decision']);
    this.manager.interrupt(sessionId);
    this.expireDecisions(sessionId);
    this.setStatus(sessionId, 'idle');
    this.cancelDelegations(sessionId);
    this.finishTask(sessionId, 'failed', 'Interrupted by the owner.');
  }

  terminate(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.status === 'terminated') throw new HttpError(409, 'Session already terminated');
    this.manager.stop(sessionId);
    this.expireDecisions(sessionId);
    this.db.update(sessions).set({ endedAt: now() }).where(eq(sessions.id, sessionId)).run();
    this.setStatus(sessionId, 'terminated');
    this.cancelDelegations(sessionId);
    this.finishTask(sessionId, 'failed', 'Terminated by the owner.');
  }

  /** Stops every live Claude process. Statuses are left as-is; the next startup marks them interrupted. */
  shutdown(): void {
    clearTimeout(this.pauseTimer);
    const live = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.status, ['queued', 'running', 'waiting_decision', 'idle']))
      .all();
    for (const { id } of live) this.manager.stop(id);
  }

  // ---- Tasks (todo queue run by scheduleTasks) ----

  listTasks(): TasksResponse {
    const all = this.db.select().from(tasks).orderBy(asc(tasks.createdAt)).all();
    return { tasks: all, pausedUntil: this.pausedUntil };
  }

  createTask(req: CreateTaskRequest): Task {
    const project = this.getProject(req.projectId);
    if (req.role && !project.roles.includes(req.role)) throw new HttpError(400, `project has no role "${req.role}"`);
    const task: Task = {
      id: randomUUID(),
      projectId: project.id,
      role: req.role ?? null,
      name: req.name,
      content: req.content,
      parallel: req.parallel,
      status: 'wait',
      groupId: null,
      position: 0,
      sessionId: null,
      delegatedBy: null,
      report: null,
      createdAt: now(),
    };
    this.db.insert(tasks).values(task).run();
    this.bus.emit({ type: 'tasks_changed' });
    return task;
  }

  /** Name and content (the prompt); not while working or after it is done. */
  updateTask(id: string, req: UpdateTaskRequest): Task {
    const task = this.getTask(id);
    if (task.status === 'working' || task.status === 'done') throw new HttpError(409, `Task is ${task.status}`);
    this.db.update(tasks).set({ name: req.name, content: req.content }).where(eq(tasks.id, id)).run();
    this.tasksChanged();
    return { ...task, name: req.name, content: req.content };
  }

  deleteTask(id: string): void {
    const task = this.getTask(id);
    if (task.status === 'working') throw new HttpError(409, 'Task is working; interrupt its session first');
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
    if (task.groupId) this.writeGroup(task.groupId, this.groupMembers(task.groupId).map((t) => t.id));
    this.tasksChanged();
  }

  /** wait <-> run; failed -> run retries from the content in a fresh (or the group's) session. */
  setTaskStatus(id: string, status: 'wait' | 'run'): Task {
    const task = this.getTask(id);
    if (task.status === 'working' || task.status === 'done') throw new HttpError(409, `Task is ${task.status}`);
    const sessionId = task.status === 'failed' ? null : task.sessionId;
    this.db.update(tasks).set({ status, sessionId, report: null }).where(eq(tasks.id, id)).run();
    this.tasksChanged();
    return { ...task, status, sessionId, report: null };
  }

  runGroup(groupId: string): void {
    const members = this.groupMembers(groupId);
    if (!members.length) throw new HttpError(404, 'Group not found');
    for (const t of members) {
      if (t.status === 'wait') this.db.update(tasks).set({ status: 'run' }).where(eq(tasks.id, t.id)).run();
      if (t.status === 'failed') this.db.update(tasks).set({ status: 'run', sessionId: null }).where(eq(tasks.id, t.id)).run();
    }
    this.tasksChanged();
  }

  /** `before`: join that task's group in front of it. `groupId`: append. Neither: ungroup. */
  moveTask(id: string, req: { before?: string; groupId?: string }): void {
    const task = this.getTask(id);
    if (task.parallel) throw new HttpError(400, 'Parallel tasks cannot be grouped');
    if (task.status !== 'wait') throw new HttpError(409, `Only waiting tasks can be moved; task is ${task.status}`);
    if (req.before === id) return;

    let target: { groupId: string; ids: string[] } | null = null;
    if (req.before) {
      const before = this.getTask(req.before);
      if (before.parallel) throw new HttpError(400, 'Parallel tasks cannot be grouped');
      const groupId = before.groupId ?? randomUUID();
      const ids = before.groupId ? this.groupMembers(groupId).map((t) => t.id).filter((x) => x !== id) : [before.id];
      ids.splice(ids.indexOf(before.id), 0, id);
      target = { groupId, ids };
    } else if (req.groupId) {
      const ids = this.groupMembers(req.groupId).map((t) => t.id).filter((x) => x !== id);
      if (!ids.length) throw new HttpError(404, 'Group not found');
      target = { groupId: req.groupId, ids: [...ids, id] };
    }

    if (task.groupId && task.groupId !== target?.groupId) {
      this.writeGroup(task.groupId, this.groupMembers(task.groupId).map((t) => t.id).filter((x) => x !== id));
    }
    if (target) this.writeGroup(target.groupId, target.ids);
    else this.db.update(tasks).set({ groupId: null, position: 0 }).where(eq(tasks.id, id)).run();
    this.tasksChanged();
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
    // A question takes any non-empty text: an option, several joined with ", ", or the owner's own words.
    if (row.kind === 'question' && !('choice' in answer && answer.choice.trim())) {
      throw new HttpError(400, 'Question decisions take { choice: string }');
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
    const worker = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.sessionId, sessionId), eq(tasks.status, 'working'), isNotNull(tasks.delegatedBy)))
      .get();
    const pending = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.delegatedBy, sessionId))
      .all()
      .some((t) => OPEN_TASK.includes(t.status) || t.report !== null);
    this.bus.emit({ type: 'task_done', sessionId, projectId: session.projectId, ...r, intermediate: !!worker || pending });
    this.finishTask(sessionId, 'done', r.result);
  }

  /** Queues `instructions` as a task for `role`, run in that role's session; the result goes back to the lead. */
  delegate(sessionId: string, role: string, instructions: string): string {
    const lead = this.getSession(sessionId);
    const project = this.getProject(lead.projectId);
    const mine = this.db.select().from(tasks).where(eq(tasks.delegatedBy, sessionId)).all();
    if (this.db.select().from(tasks).where(and(eq(tasks.sessionId, sessionId), isNotNull(tasks.delegatedBy))).get()) {
      throw new HttpError(409, 'A session doing delegated work cannot delegate further.');
    }
    if (!teamOf(project, lead.role).includes(role)) throw new HttpError(400, `Unknown role "${role}".`);
    const lastOwnerMessage = this.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.seq))
      .get();
    if (mine.filter((t) => t.createdAt >= (lastOwnerMessage?.createdAt ?? '')).length >= MAX_DELEGATIONS) {
      throw new HttpError(409, `Delegation limit (${MAX_DELEGATIONS}) reached. Stop and report your progress to the owner.`);
    }
    const task: Task = {
      id: randomUUID(),
      projectId: project.id,
      role,
      name: `${role}: ${instructions.split('\n')[0]!.slice(0, 80)}`,
      content: instructions,
      parallel: false,
      status: 'run',
      // All of a lead's delegations form one group: they run in order and each role reuses its session.
      groupId: sessionId,
      position: mine.length,
      sessionId: null,
      delegatedBy: sessionId,
      report: null,
      createdAt: now(),
    };
    this.db.insert(tasks).values(task).run();
    this.tasksChanged();
    return `Queued for ${role} (task ${task.id}). End your turn; the result will arrive as a message.`;
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db.update(sessions).set({ claudeSessionId }).where(eq(sessions.id, sessionId)).run();
  }

  /** The limit is account-wide, so any session hitting it pauses the task queue until the reset. */
  limitReached(sessionId: string, retryAt: string | null): void {
    this.bus.emit({ type: 'limit_reached', sessionId, retryAt });
    const until = retryAt ?? new Date(Date.now() + LIMIT_FALLBACK_MS).toISOString();
    if (this.pausedUntil && this.pausedUntil >= until) return;
    this.pausedUntil = until;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pausedUntil = null;
      this.tasksChanged();
    }, Math.max(0, Date.parse(until) - Date.now()));
    this.bus.emit({ type: 'tasks_changed' });
  }

  fail(sessionId: string, error: string): void {
    this.expireDecisions(sessionId);
    this.setStatus(sessionId, 'error');
    this.bus.emit({ type: 'session_error', sessionId, error });
    // A turn cut off by a usage limit goes back to `run` and continues in the same session after the reset.
    this.finishTask(sessionId, this.pausedUntil ? 'run' : 'failed', `Error: ${error}`);
  }

  // ---- internals ----

  private getTask(id: string): Task {
    const task = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new HttpError(404, 'Task not found');
    return task;
  }

  private groupMembers(groupId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.groupId, groupId)).orderBy(asc(tasks.position)).all();
  }

  /** Stores the group's order as positions 0..n-1; a group of one is dissolved. */
  private writeGroup(groupId: string, ids: string[]): void {
    ids.forEach((id, position) => {
      this.db.update(tasks).set({ groupId: ids.length > 1 ? groupId : null, position }).where(eq(tasks.id, id)).run();
    });
  }

  private tasksChanged(): void {
    this.bus.emit({ type: 'tasks_changed' });
    this.scheduleTasks();
  }

  /**
   * Called when a session's turn ends: its working task (if any) moves to `status`.
   * A finished delegated task keeps `report` until it is delivered to its lead.
   */
  private finishTask(sessionId: string, status: 'done' | 'failed' | 'run', report?: string): void {
    const task = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.sessionId, sessionId), eq(tasks.status, 'working')))
      .get();
    if (task) {
      const withReport = task.delegatedBy && status !== 'run' ? { report: report ?? '' } : {};
      this.db.update(tasks).set({ status, ...withReport }).where(eq(tasks.id, task.id)).run();
      this.bus.emit({ type: 'tasks_changed' });
    }
    this.scheduleTasks();
  }

  /**
   * Starts every `run` task that may go now: not paused, earlier group members done,
   * no other non-parallel task working in the same project, and the session to reuse not busy.
   */
  private scheduleTasks(): void {
    // Starting a task can end a turn synchronously, which schedules again: rerun the loop instead of nesting.
    if (this.scheduling) {
      this.rescheduled = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduled = false;
        this.scheduleOnce();
      } while (this.rescheduled);
    } finally {
      this.scheduling = false;
    }
  }

  private scheduleOnce(): void {
    if (this.pausedUntil) return;
    this.deliverReports();
    const all = this.db.select().from(tasks).orderBy(asc(tasks.createdAt)).all();
    const busyProjects = new Set(all.filter((t) => t.status === 'working' && !t.parallel).map((t) => t.projectId));
    for (const task of all) {
      if (task.status !== 'run') continue;
      const earlier = task.groupId ? all.filter((t) => t.groupId === task.groupId && t.position < task.position) : [];
      // A failed delegation doesn't block the lead's later ones: the lead is told and decides.
      if (earlier.some((t) => t.status !== 'done' && !(t.delegatedBy && t.status === 'failed'))) continue;
      if (!task.parallel && busyProjects.has(task.projectId)) continue;
      // Own session: cut off by a limit or restart. Otherwise the nearest earlier group member with the same project+role.
      const reuse =
        task.sessionId ??
        earlier.filter((t) => t.projectId === task.projectId && t.role === task.role && t.sessionId).at(-1)?.sessionId ??
        null;
      if (reuse && BUSY.includes(this.getSession(reuse).status)) continue;
      if (!task.parallel) busyProjects.add(task.projectId);
      this.startTask(task, reuse);
    }
  }

  private startTask(task: Task, reuse: string | null): void {
    try {
      if (reuse) {
        this.db.update(tasks).set({ status: 'working', sessionId: reuse }).where(eq(tasks.id, task.id)).run();
        this.sendMessage(reuse, task.sessionId ? CONTINUE_PROMPT : task.content);
      } else {
        this.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, task.id)).run();
        const session = this.startSession(task.projectId, { prompt: task.content, role: task.role ?? undefined }, !!task.delegatedBy);
        this.db.update(tasks).set({ sessionId: session.id }).where(eq(tasks.id, task.id)).run();
      }
    } catch {
      this.db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, task.id)).run();
    }
    this.bus.emit({ type: 'tasks_changed' });
  }

  /** Sends finished delegations' results to each lead that is idle (or interrupted by a restart), one message per lead. */
  private deliverReports(): void {
    const waiting = this.db.select().from(tasks).where(isNotNull(tasks.report)).orderBy(asc(tasks.position)).all();
    for (const leadId of new Set(waiting.map((t) => t.delegatedBy!))) {
      if (!['idle', 'interrupted'].includes(this.getSession(leadId).status)) continue;
      const reports = waiting.filter((t) => t.delegatedBy === leadId);
      this.db.update(tasks).set({ report: null }).where(inArray(tasks.id, reports.map((t) => t.id))).run();
      const body = reports.map((t) => `## ${t.role} — ${t.status} ("${t.name}")\n\n${t.report}`).join('\n\n');
      try {
        this.sendMessage(leadId, `Delegation results:\n\n${body}`, 'system');
      } catch {
        // never started, so it can't be resumed; the results stay visible on the Tasks page
      }
      this.bus.emit({ type: 'tasks_changed' });
    }
  }

  /** The lead was interrupted or terminated: its open delegations fail, a running one is stopped, nothing is reported. */
  private cancelDelegations(leadId: string): void {
    const open = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.delegatedBy, leadId), inArray(tasks.status, OPEN_TASK)))
      .all();
    for (const t of open) {
      if (t.status === 'working' && t.sessionId) {
        this.manager.interrupt(t.sessionId);
        this.expireDecisions(t.sessionId);
        this.setStatus(t.sessionId, 'idle');
      }
    }
    if (open.length) {
      this.db.update(tasks).set({ status: 'failed' }).where(inArray(tasks.id, open.map((t) => t.id))).run();
    }
    this.db.update(tasks).set({ report: null }).where(eq(tasks.delegatedBy, leadId)).run();
    if (open.length) this.bus.emit({ type: 'tasks_changed' });
  }

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
    // Working tasks keep their session and continue in it on the next schedule.
    this.db.update(tasks).set({ status: 'run' }).where(eq(tasks.status, 'working')).run();
  }
}

function toDecision(row: typeof decisions.$inferSelect): Decision {
  const { createdAt: _, ...decision } = row;
  return decision as Decision;
}
