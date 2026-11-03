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
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
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
}

export interface StartSessionRequest {
  prompt: string;
  model?: string;
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
