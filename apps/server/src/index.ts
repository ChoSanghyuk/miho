import { buildApp } from './app.js';
import { dbPath, loadConfig } from './config.js';
import { FakeSessionManager } from './sessions/fake.js';

const config = loadConfig();
const { app } = await buildApp({
  config,
  dbPath,
  sessionManager: (host) => new FakeSessionManager(host),
  logger: true,
});

await app.listen({ host: '127.0.0.1', port: config.server.port });
