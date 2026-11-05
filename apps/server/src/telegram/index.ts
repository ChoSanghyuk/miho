import { Bot, InlineKeyboard, type BotConfig, type Context } from 'grammy';
import type { Decision, ServerEvent } from '@orch/shared';
import type { Config } from '../config.js';
import type { Orchestrator } from '../orchestrator.js';
import { HttpError } from '../orchestrator.js';

const RESUME_PROMPT = 'Continue where you left off.';

interface Log {
  info(msg: string): void;
  warn(msg: string): void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Sends orchestrator alerts to the owner's chat and turns button taps into decision answers.
 * callback_data: "p:<decisionId>:a|d" (permission), "q:<decisionId>:<optionIndex>" (question), "r:<sessionId>" (resume).
 */
export function createTelegram(
  orch: Orchestrator,
  opts: { token: string; chatId: number; notify: Config['telegram']['notify'] },
  log: Log,
  botConfig?: BotConfig<Context>,
) {
  const bot = new Bot(opts.token, botConfig);
  /** Sent decision prompts, so they can be edited once answered or expired. */
  const prompts = new Map<string, { messageId: number; text: string }>();

  const label = (sessionId: string) => {
    const session = orch.getSession(sessionId);
    return `${orch.getProject(session.projectId).name} · session ${session.id.slice(0, 8)}`;
  };

  const send = (text: string, keyboard?: InlineKeyboard) =>
    bot.api.sendMessage(opts.chatId, text, keyboard ? { reply_markup: keyboard } : {});

  async function notify(event: ServerEvent): Promise<void> {
    if (event.type === 'decision_resolved') {
      const prompt = prompts.get(event.decisionId);
      if (!prompt) return;
      prompts.delete(event.decisionId);
      const outcome = event.answeredVia ? `Answered via ${event.answeredVia}` : 'Expired';
      await bot.api.editMessageText(opts.chatId, prompt.messageId, `${prompt.text}\n\n— ${outcome}`);
      return;
    }
    if (!(opts.notify as string[]).includes(event.type)) return;

    switch (event.type) {
      case 'task_done': {
        if (event.intermediate) return; // one alert per delegation run, when the lead is done
        const secs = Math.round(event.durationMs / 1000);
        await send(`Task done — ${label(event.sessionId)}\n\n${clip(event.result, 1500)}\n\n$${event.costUsd.toFixed(4)} · ${secs}s`);
        return;
      }
      case 'decision_needed': {
        const text = decisionText(event.decision, label(event.decision.sessionId));
        const msg = await send(text, decisionKeyboard(event.decision));
        prompts.set(event.decision.id, { messageId: msg.message_id, text });
        return;
      }
      case 'limit_reached': {
        const when = event.retryAt ? `Resets at ${new Date(event.retryAt).toLocaleString()}.` : 'Reset time unknown.';
        await send(`Usage limit reached — ${label(event.sessionId)}\n\n${when}`);
        return;
      }
      case 'session_error':
        await send(
          `Session error — ${label(event.sessionId)}\n\n${clip(event.error, 1500)}`,
          new InlineKeyboard().text('Resume', `r:${event.sessionId}`),
        );
        return;
    }
  }

  // Only the configured chat may act; everything else is dropped and logged.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id === opts.chatId) return next();
    log.warn(`telegram: ignored update from chat ${ctx.chat?.id ?? 'unknown'} (user ${ctx.from?.id ?? 'unknown'})`);
  });

  bot.on('callback_query:data', async (ctx) => {
    const [kind, id = '', arg] = ctx.callbackQuery.data.split(':');
    try {
      if (kind === 'p') {
        orch.answerDecision(id, { answer: { behavior: arg === 'a' ? 'allow' : 'deny' } }, 'telegram');
      } else if (kind === 'q') {
        const decision = orch.listDecisions('pending').find((d) => d.id === id);
        const choice = decision?.kind === 'question' ? decision.payload.options[Number(arg)] : undefined;
        if (!choice) throw new HttpError(409, 'Decision already answered');
        orch.answerDecision(id, { answer: { choice } }, 'telegram');
      } else if (kind === 'r') {
        orch.sendMessage(id, RESUME_PROMPT);
        await ctx.editMessageReplyMarkup();
      }
      await ctx.answerCallbackQuery();
    } catch (err) {
      await ctx.answerCallbackQuery({ text: err instanceof HttpError ? err.message : 'Failed' });
      if (!(err instanceof HttpError)) throw err;
    }
  });

  bot.catch((err) => log.warn(`telegram: ${err.message}`));

  const unsubscribe = orch.bus.subscribe((event) => {
    notify(event).catch((err: Error) => log.warn(`telegram: failed to send ${event.type}: ${err.message}`));
  });

  return {
    bot,
    start() {
      void bot.start({ onStart: (me) => log.info(`telegram: polling as @${me.username}`) });
    },
    async stop() {
      unsubscribe();
      if (bot.isRunning()) await bot.stop();
    },
  };
}

function decisionText(d: Decision, where: string): string {
  if (d.kind === 'question') return `Question — ${where}\n\n${d.payload.question}`;
  return `Permission needed — ${where}\n\nTool: ${d.payload.toolName}\n${clip(JSON.stringify(d.payload.input, null, 2), 1500)}`;
}

function decisionKeyboard(d: Decision): InlineKeyboard {
  if (d.kind === 'permission') {
    return new InlineKeyboard().text('Approve', `p:${d.id}:a`).text('Deny', `p:${d.id}:d`);
  }
  const kb = new InlineKeyboard();
  d.payload.options.forEach((option, i) => kb.text(clip(option, 40), `q:${d.id}:${i}`).row());
  return kb;
}
