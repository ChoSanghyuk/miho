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

// REST request bodies

export interface CreateProjectRequest {
  name: string;
  workdir: string;
  /** Create `workdir` if it doesn't exist. Without it, a missing workdir is a 404. */
  createDir?: boolean;
  /** Creates <workdir>/<name>/CLAUDE.md for each role (existing files are kept). */
  roles?: RoleInput[];
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
    }
  | { type: 'limit_reached'; sessionId: string; retryAt: string | null }
  | { type: 'session_error'; sessionId: string; error: string };

export type ServerEventType = ServerEvent['type'];
