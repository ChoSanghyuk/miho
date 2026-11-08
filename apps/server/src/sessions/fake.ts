import type { SessionHost, SessionManager } from './types.js';

/**
 * Stand-in until the Agent SDK integration lands. Echoes each prompt.
 * A prompt containing "[decision]" first asks for a Bash permission, to exercise the decision flow.
 * A prompt containing "[question]" asks a multi-select question (options a, b, c).
 * A prompt containing "[limit]" hits a usage limit that resets 50 ms later.
 * A line "[delegate:<role>] <instructions>" calls the `delegate` tool (one per line).
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
    // Markers in delegate lines are for the worker; delegation results (which quote workers) are only echoed.
    const echoOnly = text.startsWith('Delegation results:');
    const own = echoOnly ? '' : text.replace(DELEGATE_LINE, '');
    if (own.includes('[decision]')) {
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

    if (own.includes('[question]')) {
      try {
        const answer = await this.host.requestDecision(sessionId, {
          kind: 'question',
          payload: { question: 'Pick some', options: ['a', 'b', 'c'], multiSelect: true },
        });
        suffix += ` (answer: ${'choice' in answer ? answer.choice : answer.behavior})`;
      } catch {
        return;
      }
      if (signal.aborted) return;
    }

    if (own.includes('[limit]')) {
      this.turns.delete(sessionId);
      this.host.limitReached(sessionId, new Date(Date.now() + 50).toISOString());
      return this.host.fail(sessionId, 'usage limit');
    }

    for (const [, role, instructions] of echoOnly ? [] : text.matchAll(DELEGATE_LINE)) {
      try {
        suffix += ` (delegated: ${this.host.delegate(sessionId, role!, instructions!)})`;
      } catch (err) {
        suffix += ` (delegate refused: ${(err as Error).message})`;
      }
    }

    const result = `Echo: ${text}${suffix}`;
    this.host.output(sessionId, 'assistant', { text: result });
    this.turns.delete(sessionId);
    this.host.done(sessionId, { result, costUsd: 0, durationMs: Date.now() - startedAt });
  }
}

const DELEGATE_LINE = /^\[delegate:([^\]]+)\] (.+)$/gm;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
