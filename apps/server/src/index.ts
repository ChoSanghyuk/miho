import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { startDailyBackup } from './backup.js';
import { dbPath, loadConfig, repoRoot } from './config.js';
import { AgentSdkSessionManager } from './sessions/agent-sdk.js';
import { FakeSessionManager } from './sessions/fake.js';
import { createTelegram } from './telegram/index.js';

const config = loadConfig();
// ORCH_FAKE_SESSIONS=1 swaps in the echo manager, for UI work without spending tokens.
const fake = process.env.ORCH_FAKE_SESSIONS === '1';

const ownerToken = process.env.ORCH_OWNER_TOKEN;
if (!ownerToken) {
  console.error('ORCH_OWNER_TOKEN is not set. Add one to .env, e.g. ORCH_OWNER_TOKEN=$(openssl rand -hex 32)');
  process.exit(1);
}

const dashboardDir = `${repoRoot}apps/dashboard/dist`;

const { app, orch, db } = await buildApp({
  config,
  dbPath,
  sessionManager: (host) => (fake ? new FakeSessionManager(host) : new AgentSdkSessionManager(host, config)),
  ownerToken,
  dashboardDir: existsSync(dashboardDir) ? dashboardDir : undefined,
  logger: {
    transport: {
      targets: [
        { target: 'pino/file', options: { destination: 1 } },
        // Rotated daily or at 10 MB, keeping 14 old files.
        {
          target: 'pino-roll',
          options: { file: `${repoRoot}logs/orchestrator`, extension: '.log', frequency: 'daily', size: '10m', limit: { count: 14 }, mkdir: true },
        },
      ],
    },
  },
});

// Lifecycle log: ids, event names, cost and duration only. Never prompt or output bodies.
orch.bus.subscribe((e) => {
  switch (e.type) {
    case 'session_status':
      return app.log.info({ sessionId: e.sessionId, event: e.type, status: e.status }, 'session status');
    case 'task_done':
      return app.log.info({ sessionId: e.sessionId, event: e.type, costUsd: e.costUsd, durationMs: e.durationMs }, 'task done');
    case 'decision_needed':
      return app.log.info({ sessionId: e.decision.sessionId, event: e.type, decisionId: e.decision.id, kind: e.decision.kind }, 'decision needed');
    case 'decision_resolved':
      return app.log.info({ event: e.type, decisionId: e.decisionId, answeredVia: e.answeredVia }, 'decision resolved');
    case 'limit_reached':
      return app.log.warn({ sessionId: e.sessionId, event: e.type, retryAt: e.retryAt }, 'limit reached');
    case 'session_error':
      return app.log.error({ sessionId: e.sessionId, event: e.type, error: e.error }, 'session error');
  }
});

const stopBackup = startDailyBackup(db.$client, `${repoRoot}backups`, app.log);
app.addHook('onClose', async () => stopBackup());

const token = process.env[config.telegram.botTokenEnv];
if (token && config.telegram.chatId) {
  const telegram = createTelegram(orch, { token, chatId: config.telegram.chatId, notify: config.telegram.notify }, app.log);
  telegram.start();
  app.addHook('onClose', () => telegram.stop());
} else {
  app.log.warn(`Telegram disabled: set ${config.telegram.botTokenEnv} in .env and telegram.chatId in the config`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ host: '127.0.0.1', port: config.server.port });
