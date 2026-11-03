import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AnsweredVia, Decision, MessageRole, SessionStatus } from '@orch/shared';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  workdir: text('workdir').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  claudeSessionId: text('claude_session_id'),
  status: text('status').$type<SessionStatus>().notNull(),
  model: text('model').notNull(),
  costUsd: real('cost_usd').notNull().default(0),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

export const messages = sqliteTable('messages', {
  // Autoincrement keeps insertion order for history reads.
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  role: text('role').$type<MessageRole>().notNull(),
  body: text('body_json', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  kind: text('kind').$type<Decision['kind']>().notNull(),
  payload: text('payload_json', { mode: 'json' }).$type<Decision['payload']>().notNull(),
  status: text('status').$type<Decision['status']>().notNull(),
  answeredVia: text('answered_via').$type<AnsweredVia>(),
  answer: text('answer_json', { mode: 'json' }).$type<NonNullable<Decision['answer']>>(),
  createdAt: text('created_at').notNull(),
});
