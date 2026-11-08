// Contract between backend, dashboard and Telegram. Types only: import with `import type`.

export type SessionStatus =
  | 'queued'
  | 'running'
  | 'waiting_decision'
  | 'idle'
  | 'terminated'
  | 'error'
  | 'interrupted';

export interface Project {
  id: string;
  name: string;
  workdir: string;
  /** Role folder names under workdir; empty for a single-session project. */
  roles: string[];
  createdAt: string;
}

export interface Guideline {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Role {
  id: string;
  name: string;
  /** The role's own text. */
  description: string;
  /** Guidelines composed into the role, in order. */
  guidelineIds: string[];
  /** Position of `description` among the guidelines (0 = first, guidelineIds.length = last). */
  descriptionIndex: number;
  /** Computed: the full body written under `# Role: <name>` in CLAUDE.md. */
  content: string;
  createdAt: string;
}

export interface RoleInput {
  /** Also the folder name under the project workdir. */
  name: string;
  description: string;
}

/** A project role's `<workdir>/<role>/CLAUDE.md`, read and written as a whole. */
export interface ProjectRoleFile {
  name: string;
  content: string;
}

export interface Session {
  id: string;
  projectId: string;
  /** Role folder the session runs in; null = project root. */
  role: string | null;
  claudeSessionId: string | null;
  status: SessionStatus;
  model: string;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  body: unknown;
  createdAt: string;
}

export type AnsweredVia = 'web' | 'telegram';

export type Decision = {
  id: string;
  sessionId: string;
  status: 'pending' | 'answered' | 'expired';
  answeredVia: AnsweredVia | null;
} & (
  | {
      kind: 'permission';
      payload: { toolName: string; input: unknown };
      answer: { behavior: 'allow' | 'deny' } | null;
    }
  | {
      kind: 'question';
      payload: { question: string; options: string[] };
      answer: { choice: string } | null;
    }
);

export type TaskStatus = 'wait' | 'run' | 'working' | 'done' | 'failed';

/** A todo task. `wait` until the owner switches it to `run`; the orchestrator then runs it in a session. */
export interface Task {
  id: string;
  projectId: string;
  role: string | null;
  name: string;
  /** Sent as the prompt. */
  content: string;
  /** May run alongside other tasks of the same project; can't be grouped. */
  parallel: boolean;
  status: TaskStatus;
  /** Tasks sharing a groupId run in `position` order. */
  groupId: string | null;
  position: number;
  /** Session the task ran (or is running) in. */
  sessionId: string | null;
  /** Lead session that created this task with the `delegate` tool; null for the owner's tasks. */
  delegatedBy: string | null;
  /** A finished delegation's result, waiting to be delivered to the lead; null once delivered. */
  report: string | null;
  createdAt: string;
}

// REST request bodies

export interface CreateProjectRequest {
  name: string;
  workdir: string;
  /** Create `workdir` if it doesn't exist. Without it, a missing workdir is a 404. */
  createDir?: boolean;
  /** Creates <workdir>/<name>/CLAUDE.md for each role (existing files are kept). */
  roles?: RoleInput[];
}

export interface UpdateProjectRoleRequest {
  /** The new CLAUDE.md content. */
  content: string;
}

export interface RoleRequest {
  name: string;
  description: string;
  guidelineIds?: string[];
  descriptionIndex?: number;
}

export interface GuidelineRequest {
  name: string;
  description: string;
}

export interface StartSessionRequest {
  prompt: string;
  model?: string;
  /** One of the project's roles; the session runs in that role's folder. */
  role?: string;
}

export interface SendMessageRequest {
  text: string;
}

export interface AnswerDecisionRequest {
  answer: { behavior: 'allow' | 'deny' } | { choice: string };
}

export interface CreateTaskRequest {
  projectId: string;
  role?: string;
  name: string;
  content: string;
  parallel: boolean;
}

/** Allowed unless the task is working or done. */
export interface UpdateTaskRequest {
  name: string;
  content: string;
}

export interface SetTaskStatusRequest {
  status: 'wait' | 'run';
}

/** `before`: join that task's group in front of it. `groupId`: append to that group. Neither: ungroup. */
export interface MoveTaskRequest {
  before?: string;
  groupId?: string;
}

export interface TasksResponse {
  tasks: Task[];
  /** Set while a usage limit pauses the task queue. */
  pausedUntil: string | null;
}

// Events pushed over /ws and consumed by the Telegram module

export type ServerEvent =
  | { type: 'session_output'; sessionId: string; message: SessionMessage }
  | { type: 'session_status'; sessionId: string; status: SessionStatus }
  | { type: 'decision_needed'; decision: Decision }
  // answeredVia is null when the decision expired (interrupt, terminate, restart)
  | { type: 'decision_resolved'; decisionId: string; answeredVia: AnsweredVia | null }
  | {
      type: 'task_done';
      sessionId: string;
      projectId: string;
      result: string;
      costUsd: number;
      durationMs: number;
      /** A turn inside a delegation run: a worker's, or a lead's with delegations still pending. */
      intermediate: boolean;
    }
  | { type: 'limit_reached'; sessionId: string; retryAt: string | null }
  | { type: 'session_error'; sessionId: string; error: string }
  // any task change, or the task queue paused/resumed: refetch GET /api/tasks
  | { type: 'tasks_changed' };

export type ServerEventType = ServerEvent['type'];
