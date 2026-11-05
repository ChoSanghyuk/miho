import type { Decision, MessageRole, SessionStatus } from '@orch/shared';

type DecisionRequest = Pick<Decision, 'kind' | 'payload'>;
type DecisionAnswer = NonNullable<Decision['answer']>;

/** What a session manager reports back. Implemented by the Orchestrator, which persists and emits events. */
export interface SessionHost {
  output(sessionId: string, role: MessageRole, body: unknown): void;
  setStatus(sessionId: string, status: SessionStatus): void;
  setClaudeSessionId(sessionId: string, claudeSessionId: string): void;
  /** Resolves with the user's answer; rejects if the decision is cancelled (interrupt, terminate). */
  requestDecision(sessionId: string, request: DecisionRequest): Promise<DecisionAnswer>;
  done(sessionId: string, result: { result: string; costUsd: number; durationMs: number }): void;
  limitReached(sessionId: string, retryAt: string | null): void;
  fail(sessionId: string, error: string): void;
  /** The `delegate` tool: queues work for another role and returns the tool's reply. Throws if refused. */
  delegate(sessionId: string, role: string, instructions: string): string;
}

export interface StartOptions {
  workdir: string;
  model: string;
  prompt: string;
  /** Claude session ID to resume instead of starting fresh. */
  resume?: string;
  /** Cost already recorded for this session; the SDK's running total on resume includes it. */
  priorCostUsd?: number;
  /** Roles this session may hand work to with the `delegate` tool; absent or empty = no tool. */
  team?: string[];
}

/** The AI integration boundary: FakeSessionManager for tests, AgentSdkSessionManager for real use. */
export interface SessionManager {
  start(sessionId: string, opts: StartOptions): void;
  send(sessionId: string, text: string): void;
  interrupt(sessionId: string): void;
  stop(sessionId: string): void;
}

export type SessionManagerFactory = (host: SessionHost) => SessionManager;
