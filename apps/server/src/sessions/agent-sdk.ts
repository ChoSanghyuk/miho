import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type McpServerConfig,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { SessionHost, SessionManager, StartOptions } from './types.js';

const MAX_TOOL_RESULT_CHARS = 4000;
const DELEGATE_TOOL = 'mcp__team__delegate';

/** Push-based input stream for a streaming-input SDK session. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(text: string): void {
    this.items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.items.shift();
      if (next) yield next;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

interface Live {
  query: Query;
  input: InputQueue;
  /** Cumulative cost reported by the SDK so far; results carry running totals. */
  costSoFar: number;
  /** Set by interrupt() so the aborted turn's result is not reported as done or failed. */
  dropNextResult: boolean;
  limitReported: boolean;
  stopped: boolean;
}

/** Runs each orchestrator session as a long-lived streaming-input Agent SDK query. */
export class AgentSdkSessionManager implements SessionManager {
  private live = new Map<string, Live>();
  /** Sessions with a turn in flight; capped at maxConcurrentSessions. */
  private busy = new Set<string>();
  private waiting: { sessionId: string; run: () => void }[] = [];

  constructor(
    private host: SessionHost,
    private config: Config,
  ) {}

  start(sessionId: string, opts: StartOptions): void {
    this.stop(sessionId); // a resume replaces any stale handle
    const input = new InputQueue();
    const live: Live = {
      input,
      query: query({
        prompt: input,
        options: {
          cwd: opts.workdir,
          model: opts.model,
          permissionMode: this.config.claude.permissionMode,
          canUseTool: this.canUseTool(sessionId),
          mcpServers: { ...this.mcpServers(), ...this.teamServer(sessionId, opts.team) },
          ...(opts.team?.length ? { allowedTools: [DELEGATE_TOOL] } : {}),
          ...(opts.resume ? { resume: opts.resume } : {}),
        },
      }),
      costSoFar: opts.priorCostUsd ?? 0,
      dropNextResult: false,
      limitReported: false,
      stopped: false,
    };
    this.live.set(sessionId, live);
    void this.consume(sessionId, live);
    this.send(sessionId, opts.prompt);
  }

  send(sessionId: string, text: string): void {
    const live = this.live.get(sessionId);
    if (!live) return this.host.fail(sessionId, 'No live Claude session; resume it first');
    this.runOrQueue(sessionId, () => {
      live.limitReported = false;
      this.host.setStatus(sessionId, 'running');
      live.input.push(text);
    });
  }

  interrupt(sessionId: string): void {
    this.waiting = this.waiting.filter((w) => w.sessionId !== sessionId);
    const live = this.live.get(sessionId);
    if (live && this.busy.has(sessionId)) {
      live.dropNextResult = true;
      void live.query.interrupt().catch(() => {});
    }
    this.release(sessionId);
  }

  stop(sessionId: string): void {
    this.waiting = this.waiting.filter((w) => w.sessionId !== sessionId);
    const live = this.live.get(sessionId);
    if (live) {
      live.stopped = true;
      live.input.end();
      live.query.close();
      this.live.delete(sessionId);
    }
    this.release(sessionId);
  }

  // ---- concurrency ----

  private runOrQueue(sessionId: string, run: () => void): void {
    if (this.busy.size < this.config.claude.maxConcurrentSessions) {
      this.busy.add(sessionId);
      run();
    } else {
      this.host.setStatus(sessionId, 'queued');
      this.waiting.push({ sessionId, run });
    }
  }

  private release(sessionId: string): void {
    if (!this.busy.delete(sessionId)) return;
    const next = this.waiting.shift();
    if (next) {
      this.busy.add(next.sessionId);
      next.run();
    }
  }

  // ---- SDK stream ----

  private async consume(sessionId: string, live: Live): Promise<void> {
    try {
      for await (const msg of live.query) this.handle(sessionId, live, msg);
      if (!live.stopped) this.crash(sessionId, live, 'Claude session ended unexpectedly');
    } catch (err) {
      if (!live.stopped) this.crash(sessionId, live, err instanceof Error ? err.message : String(err));
    }
  }

  private crash(sessionId: string, live: Live, error: string): void {
    live.stopped = true;
    this.live.delete(sessionId);
    this.release(sessionId);
    this.host.fail(sessionId, error);
  }

  private handle(sessionId: string, live: Live, msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.host.setClaudeSessionId(sessionId, msg.session_id);
        if (msg.subtype === 'api_retry' && msg.error === 'rate_limit') this.reportLimit(sessionId, live, null);
        return;

      case 'rate_limit_event':
        if (msg.rate_limit_info.status === 'rejected') {
          const at = msg.rate_limit_info.resetsAt;
          // Unit is undocumented; treat small values as epoch seconds.
          this.reportLimit(sessionId, live, at ? new Date(at < 1e12 ? at * 1000 : at).toISOString() : null);
        }
        return;

      case 'assistant':
        if (msg.parent_tool_use_id) return; // subagent internals stay out of the console
        for (const block of msg.message.content) {
          if (block.type === 'text') this.host.output(sessionId, 'assistant', { text: block.text });
          if (block.type === 'tool_use') this.host.output(sessionId, 'tool', { tool: block.name, input: block.input });
        }
        return;

      case 'user': {
        if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return;
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          const text =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          this.host.output(sessionId, 'tool', {
            toolUseId: block.tool_use_id,
            result: text.slice(0, MAX_TOOL_RESULT_CHARS),
            isError: block.is_error ?? false,
          });
        }
        return;
      }

      case 'result': {
        const costUsd = Math.max(0, msg.total_cost_usd - live.costSoFar);
        live.costSoFar = msg.total_cost_usd;
        this.release(sessionId);
        if (live.dropNextResult) {
          live.dropNextResult = false;
          return;
        }
        if (msg.subtype === 'success' && !msg.is_error) {
          this.host.done(sessionId, { result: msg.result, costUsd, durationMs: msg.duration_ms });
        } else {
          const error = msg.subtype === 'success' ? msg.result : msg.errors.join('\n') || msg.subtype;
          this.host.fail(sessionId, error);
        }
        return;
      }
    }
  }

  private reportLimit(sessionId: string, live: Live, retryAt: string | null): void {
    if (live.limitReported) return;
    live.limitReported = true;
    this.host.limitReached(sessionId, retryAt);
  }

  // ---- permissions and questions ----

  private canUseTool(sessionId: string): CanUseTool {
    return async (toolName, input) => {
      try {
        if (toolName === 'AskUserQuestion') {
          const questions = (input.questions ?? []) as {
            question: string;
            options: { label: string }[];
            multiSelect?: boolean;
          }[];
          const answers: Record<string, string> = {};
          for (const q of questions) {
            const answer = await this.host.requestDecision(sessionId, {
              kind: 'question',
              payload: { question: q.question, options: q.options.map((o) => o.label), multiSelect: q.multiSelect === true },
            });
            if ('choice' in answer) answers[q.question] = answer.choice;
          }
          return { behavior: 'allow', updatedInput: { ...input, answers } };
        }

        const answer = await this.host.requestDecision(sessionId, {
          kind: 'permission',
          payload: { toolName, input },
        });
        return 'behavior' in answer && answer.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user denied this action.' };
      } catch {
        return { behavior: 'deny', message: 'Cancelled by the user.', interrupt: true };
      }
    };
  }

  /** In-process `team` server with the `delegate` tool; the orchestrator does the work through host.delegate. */
  private teamServer(sessionId: string, team: string[] | undefined): Record<string, McpServerConfig> {
    if (!team?.length) return {};
    const delegate = tool(
      'delegate',
      `Hand a piece of work to another role's Claude session: ${team.join(', ')}. ` +
        'Returns at once. Delegations run one at a time, in the order you make them, and a role keeps its context between them. ' +
        "After delegating, end your turn: each result arrives later as a message. Anything the role is unsure about goes to the owner.",
      { role: z.enum(team as [string, ...string[]]), instructions: z.string().min(1).describe('Self-contained instructions for that role') },
      async ({ role, instructions }) => {
        try {
          return { content: [{ type: 'text', text: this.host.delegate(sessionId, role, instructions) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    );
    return { team: createSdkMcpServer({ name: 'team', tools: [delegate] }) };
  }

  private mcpServers(): Record<string, McpServerConfig> {
    const { codex } = this.config.mcp;
    return codex.enabled ? { codex: { type: 'stdio', command: codex.command, args: codex.args } } : {};
  }
}
