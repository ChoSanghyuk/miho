import Fastify from 'fastify';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = Fastify({ logger: true });

app.get('/api/health', async () => ({ ok: true }));

await app.listen({ host: '127.0.0.1', port: config.server.port });
