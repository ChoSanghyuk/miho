import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AnsweredVia, Decision, MessageRole, SessionStatus, TaskStatus } from '@orch/shared';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  workdir: text('workdir').notNull(),
  roles: text('roles_json', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
});

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  guidelineIds: text('guideline_ids_json', { mode: 'json' }).$type<string[]>().notNull().default([]),
  descriptionIndex: integer('description_index').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const guidelines = sqliteTable('guidelines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  role: text('role'),
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

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  role: text('role'),
  name: text('name').notNull(),
  content: text('content').notNull(),
  parallel: integer('parallel', { mode: 'boolean' }).notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  groupId: text('group_id'),
  position: integer('position').notNull().default(0),
  sessionId: text('session_id'),
  delegatedBy: text('delegated_by'),
  report: text('report'),
  createdAt: text('created_at').notNull(),
});
