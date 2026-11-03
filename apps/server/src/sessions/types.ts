import type { Decision, MessageRole, SessionStatus } from '@orch/shared';

type DecisionRequest = Pick<Decision, 'kind' | 'payload'>;
type DecisionAnswer = NonNullable<Decision['answer']>;

/** What a session manager reports back. Implemented by the Orchestrator, which persists and emits events. */
export interface SessionHost {
  output(sessionId: string, role: MessageRole, body: unknown): void;
  setStatus(sessionId: string, status: SessionStatus): void;
  /** Resolves with the user's answer; rejects if the decision is cancelled (interrupt, terminate). */
  requestDecision(sessionId: string, request: DecisionRequest): Promise<DecisionAnswer>;
  done(sessionId: string, result: { result: string; costUsd: number; durationMs: number }): void;
  fail(sessionId: string, error: string): void;
}

/** The AI integration boundary. The fake echoes; the Agent SDK version replaces it. */
export interface SessionManager {
  start(sessionId: string, opts: { workdir: string; model: string; prompt: string }): void;
  send(sessionId: string, text: string): void;
  interrupt(sessionId: string): void;
  stop(sessionId: string): void;
}

export type SessionManagerFactory = (host: SessionHost) => SessionManager;
