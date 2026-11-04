import { buildApp } from './app.js';
import { dbPath, loadConfig } from './config.js';
import { AgentSdkSessionManager } from './sessions/agent-sdk.js';
import { FakeSessionManager } from './sessions/fake.js';
import { createTelegram } from './telegram/index.js';

const config = loadConfig();
// ORCH_FAKE_SESSIONS=1 swaps in the echo manager, for UI work without spending tokens.
const fake = process.env.ORCH_FAKE_SESSIONS === '1';

const { app, orch } = await buildApp({
  config,
  dbPath,
  sessionManager: (host) => (fake ? new FakeSessionManager(host) : new AgentSdkSessionManager(host, config)),
  logger: true,
});

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
