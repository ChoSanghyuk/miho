import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ServerEventType } from '@orch/shared';

// apps/server/{src,dist}/config.* -> repo root
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const dbPath = `${repoRoot}orchestrator.sqlite`;

const notifyEvents = [
  'task_done',
  'decision_needed',
  'limit_reached',
  'session_error',
] as const satisfies readonly ServerEventType[];

const schema = z.object({
  server: z.object({
    port: z.number().int().positive(),
    dashboardOrigin: z.string().url(),
  }),
  claude: z.object({
    defaultModel: z.string().min(1),
    permissionMode: z.enum(['default', 'acceptEdits', 'auto']),
    maxConcurrentSessions: z.number().int().positive(),
  }),
  projects: z.object({
    rootDir: z.string().transform((p) => p.replace(/^~(?=$|\/)/, homedir())),
  }),
  telegram: z.object({
    botTokenEnv: z.string().min(1),
    chatId: z.number().int(),
    notify: z.array(z.enum(notifyEvents)),
  }),
  mcp: z.object({
    codex: z.object({
      enabled: z.boolean(),
      command: z.string().min(1),
      args: z.array(z.string()),
    }),
  }),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const envPath = `${repoRoot}.env`;
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const configPath = process.env.ORCH_CONFIG ?? `${repoRoot}orchestrator.config.yaml`;
  const result = schema.safeParse(parse(readFileSync(configPath, 'utf8')));
  if (!result.success) {
    throw new Error(`Invalid config at ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
