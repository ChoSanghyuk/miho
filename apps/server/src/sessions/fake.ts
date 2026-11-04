import type { SessionHost, SessionManager } from './types.js';

/**
 * Stand-in until the Agent SDK integration lands. Echoes each prompt.
 * A prompt containing "[decision]" first asks for a Bash permission, to exercise the decision flow.
 */
export class FakeSessionManager implements SessionManager {
  private turns = new Map<string, AbortController>();

  constructor(private host: SessionHost) {}

  start(sessionId: string, opts: { prompt: string }): void {
    this.host.setClaudeSessionId(sessionId, `fake-${sessionId}`);
    this.send(sessionId, opts.prompt);
  }

  send(sessionId: string, text: string): void {
    const abort = new AbortController();
    this.turns.set(sessionId, abort);
    void this.runTurn(sessionId, text, abort.signal);
  }

  interrupt(sessionId: string): void {
    this.turns.get(sessionId)?.abort();
    this.turns.delete(sessionId);
  }

  stop(sessionId: string): void {
    this.interrupt(sessionId);
  }

  private async runTurn(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    this.host.setStatus(sessionId, 'running');
    await tick();
    if (signal.aborted) return;

    let suffix = '';
    if (text.includes('[decision]')) {
      try {
        const answer = await this.host.requestDecision(sessionId, {
          kind: 'permission',
          payload: { toolName: 'Bash', input: { command: 'echo hi' } },
        });
        suffix = ` (permission: ${'behavior' in answer ? answer.behavior : answer.choice})`;
      } catch {
        return; // cancelled by interrupt or terminate
      }
      if (signal.aborted) return;
    }

    const result = `Echo: ${text}${suffix}`;
    this.host.output(sessionId, 'assistant', { text: result });
    this.turns.delete(sessionId);
    this.host.done(sessionId, { result, costUsd: 0, durationMs: Date.now() - startedAt });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
