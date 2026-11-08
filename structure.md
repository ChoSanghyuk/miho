# Project structure

The reference for anyone, human or AI, starting work on this repo. It describes the code as it is. Rules for *how* to change it are in `CLAUDE.md`. When you change something described here, update this file in the same commit.

## What this is

**MIHO** is a single-owner service that runs Claude Code sessions on the owner's machine:

- **Sessions:** it creates them, relays the owner's commands to them, shows their output, and terminates them.
- **Two front doors:** a web dashboard and a Telegram bot.
- **Decisions:** whenever Claude needs approval (a tool permission or a question), the session pauses until the owner answers from either one.
- **Alerts:** task done, decision needed, usage limit reached and session error go to Telegram.

Everything runs in **one Node process**. The pieces are separate modules connected by an in-process event bus.

## Tech stack

| Area | Choice |
|---|---|
| Workspace | pnpm 9 workspaces (via Corepack), Node 24, TypeScript 7, ESM throughout |
| Server | Fastify 5, `@fastify/websocket`, `@fastify/static`, zod 4 for validation |
| Storage | SQLite (`better-sqlite3`) + Drizzle ORM; migrations in `apps/server/drizzle`, applied on startup |
| Claude | `@anthropic-ai/claude-agent-sdk` (streaming-input `query()`) |
| Telegram | grammY, long polling |
| Dashboard | React 19, Vite 8, TanStack Query; hash routing; no UI library |
| Logs | pino (Fastify's logger) → stdout + `pino-roll` rotating file |
| Tests | `node:test` run by `tsx --test`, Fastify `inject`, a fake session manager, and a stubbed Telegram API |

## Directory layout

```
ai_orchestrator/
├─ package.json               root scripts: dev, build, start, typecheck, test, db:migrate
├─ pnpm-workspace.yaml        apps/*, packages/*
├─ tsconfig.base.json         shared strict compiler options
├─ orchestrator.config.yaml   non-secret config (see "Configuration")
├─ .env / .env.example        secrets: ORCH_OWNER_TOKEN, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY
├─ scripts/launchd.sh         install/uninstall/print a macOS launchd agent for the server
├─ packages/
│  └─ shared/src/index.ts     THE CONTRACT: domain types, request bodies, ServerEvent union (types only)
├─ apps/
│  ├─ server/
│  │  ├─ drizzle/             generated SQL migrations (drizzle-kit); never edit by hand
│  │  └─ src/
│  │     ├─ index.ts          entry: config, owner token, logger, picks session manager, Telegram, backups, signals
│  │     ├─ app.ts            buildApp(): Fastify instance, error handler, all REST routes, /ws
│  │     ├─ auth.ts           owner-token check for /api/* and /ws; POST /api/login sets the cookie
│  │     ├─ orchestrator.ts   Orchestrator: the only owner of state and status transitions
│  │     ├─ events.ts         EventBus (emit / subscribe → unsubscribe)
│  │     ├─ config.ts         loads .env + YAML, validates with zod; repoRoot, dbPath
│  │     ├─ backup.ts         daily SQLite snapshot to backups/, keeps 7
│  │     ├─ db/               schema.ts (tables), index.ts (openDb: WAL, FKs, migrate), migrate.ts (CLI)
│  │     ├─ sessions/
│  │     │  ├─ types.ts       SessionManager / SessionHost interfaces (the AI-integration boundary)
│  │     │  ├─ agent-sdk.ts   AgentSdkSessionManager: real Claude Code sessions
│  │     │  └─ fake.ts        FakeSessionManager: echoes prompts; "[decision]" / "[limit]" trigger a permission / usage limit
│  │     ├─ telegram/index.ts createTelegram(): alerts out, button taps in
│  │     ├─ app.test.ts       API, lifecycle, auth and WebSocket tests
│  │     └─ telegram/telegram.test.ts
│  └─ dashboard/src/
│     ├─ main.tsx             QueryClient setup
│     ├─ App.tsx              auth gate (LoginPage or Shell), hash router, header with pending-decision badge
│     ├─ api.ts               typed fetch wrapper for every endpoint; throws Unauthorized on 401
│     ├─ useEvents.ts         /ws client: reconnect with backoff, patches the query cache from events
│     ├─ pages/               Projects (create, single or roles), Project (start session, add and edit roles, delete), Session (console), Tasks (todos, drag-and-drop groups; History tab for completed ones), Decisions, Roles, Guidelines, Login
│     ├─ components/          DecisionCard (answer UI), StatusPill, RoleEditor (guideline pick/order + preview)
│     └─ styles.css           design tokens (CSS variables, light/dark) and all styles; fonts are linked in index.html
```

Generated at runtime and git-ignored: `orchestrator.sqlite*`, `logs/`, `backups/`, `dist/`.

## Domains and how they connect

```
             ┌──────────── Dashboard (React) ─────────────┐
             │  REST /api/*  (commands, reads)            │
             │  WS /ws       (every ServerEvent, live)    │
             └──────────────┬─────────────────────────────┘
                            │  owner token (cookie or Bearer)
┌───────────────────────────▼──────────────────────────────────────────┐
│ apps/server (one process)                                            │
│                                                                      │
│  app.ts routes ──calls──▶ Orchestrator ◀──calls── telegram/index.ts  │
│                            │   ▲   │                    ▲            │
│                 SessionManager │   │ bus.emit            │ subscribe │
│                 (start/send/   │   ▼                    │            │
│                  interrupt/    │  EventBus ─────────────┴─▶ /ws      │
│                  stop)         │                          ─▶ logger  │
│                            ▼   │ SessionHost callbacks               │
│                  AgentSdkSessionManager ──▶ Claude Agent SDK ──▶ claude CLI subprocess
│                                                                      │
│  Orchestrator ──▶ SQLite (projects, sessions, messages, decisions)   │
└──────────────────────────────────────────────────────────────────────┘
                            ▲
             Telegram Bot API (long polling): alerts out, button taps in
```

Rules that keep the domains separate:

1. **`Orchestrator` is the only writer.** Routes and Telegram call its methods. Nothing else touches the database or emits events. Every status change goes through `Orchestrator.setStatus`, which persists the status and then emits `session_status`.
2. **The session manager never touches state.** It reports through the `SessionHost` interface (`output`, `setStatus`, `setClaudeSessionId`, `requestDecision`, `done`, `limitReached`, `fail`, `delegate`), which `Orchestrator` implements. To swap the AI backend, write a new `SessionManager`; `index.ts` chooses one with `ORCH_FAKE_SESSIONS=1`.
3. **Front doors are peers.** The dashboard and Telegram both answer decisions through `Orchestrator.answerDecision(id, answer, via)`. The first answer wins; a later one gets `409`. Both learn the outcome from the `decision_resolved` event, so each one updates itself.
4. **`packages/shared` is the contract.** It holds types only, imported with `import type`. Change it first, then fix the compile errors in server and dashboard.
5. **Events are fire-and-forget.** A failing subscriber (for example a Telegram send) is logged and never blocks the session.

## Data model (`apps/server/src/db/schema.ts`)

| Table | Key columns | Notes |
|---|---|---|
| `projects` | id, name, workdir, created_at | `name` is unique (checked on create, not by an index) and is what dashboard routes use. `workdir` is absolute, inside `projects.rootDir`, and must exist unless `createDir` is set. `roles_json` lists the project's role folder names (`[]` = single session) |
| `roles` | id, name, description, guideline_ids_json, description_index, created_at | predefined roles from the Roles menu. `name` is unique (checked in code) and doubles as a folder name (`[A-Za-z0-9][A-Za-z0-9 _.-]*`). `description` is the role's own text, placed at `description_index` among the ordered guidelines |
| `guidelines` | id, name, description, created_at | shared sections roles compose in. `name` is unique; deleting one a role uses → 409 |
| `sessions` | id, project_id, role, claude_session_id, status, model, cost_usd, started_at, ended_at | `role` is null for the project root; `claude_session_id` is the SDK's id, used for resume; `cost_usd` is the running total |
| `messages` | seq (autoincrement), id, session_id, role, body_json | console history; ordered by `seq`. Roles: user, assistant, tool, system |
| `tasks` | id, project_id, role, name, content, parallel, status, group_id, position, session_id, delegated_by, report, created_at | todo tasks (see "Todo tasks"). A group is the tasks sharing `group_id`, ordered by `position`; no groups table, and a group of one is dissolved. `delegated_by`/`report`: see "Delegation" |
| `decisions` | id, session_id, kind, payload_json, status, answered_via, answer_json | kind `permission` {toolName, input} → answer {behavior}; kind `question` {question, options} → answer {choice}. Status pending → answered or expired |

Message `body` shapes: `{text}` (user/assistant), `{tool, input}` (tool call), `{toolUseId, result, isError}` (tool result, truncated to 4000 chars).

**Roles.** The API returns each role with a computed `content` (`composeRole`): its guidelines as `## name\n\ndescription` with its own text inserted at `descriptionIndex`. It is composed on read, so a guideline edit reaches every role, but not CLAUDE.md files already written. Creating a project with `roles` makes `<workdir>/<role>/CLAUDE.md` (`# Role: <name>` + description) for each one; an existing CLAUDE.md is kept. `POST /api/projects/:id/roles` adds one more role to an existing project (also a single-session one) by the same rule. `GET/PUT /api/projects/:id/roles/:role` reads and overwrites that role's CLAUDE.md as a whole; running sessions keep what they loaded, and new or resumed ones read the new file. The request carries name and description (the dashboard sends a predefined role's `content`, preceded by optional extra text for that project only), so roles added for one project only are never stored in `roles`, and editing or deleting a predefined role doesn't touch existing projects. A session started with a `role` runs with `cwd = <workdir>/<role>` (also on resume), so Claude Code loads that role's CLAUDE.md.

Schema change workflow: edit `schema.ts`, run `pnpm --filter @orch/server db:generate`, and commit the new file in `drizzle/`. It is applied automatically on the next start.

## AI session lifecycle

### Status machine (`SessionStatus`)

```
            start / resume
                 │
                 ▼
   ┌────────▶ queued ──(slot frees)──┐
   │                                 ▼
   │   send ─────────────────────▶ running ◀──── decision answered ────┐
   │                                 │ │                               │
   │                                 │ └── canUseTool ─▶ waiting_decision
   │                     result ok   │ result error / stream crash
   │                                 ▼               ▼
   └──── send ─────────────────── idle            error ──┐
                                   ▲                      │
   interrupt (queued/running/      │                      │ send = resume
   waiting_decision) ──────────────┘                      │
                                                          │
   terminate (any but terminated) ──▶ terminated ─────────┤ send = resume
   server restart (queued/running/                        │
   waiting_decision/idle) ──▶ interrupted ────────────────┘ send = resume
```

`limit_reached` is an event only; the status doesn't change. The turn usually ends in `error` afterwards.

### How each operation works

| Operation | Orchestrator | AgentSdkSessionManager |
|---|---|---|
| **Start** `POST /api/projects/:id/sessions` | inserts the session as `running`, stores the prompt as a `user` message, calls `manager.start` | creates an `InputQueue` (async iterable) and one long-lived `query({prompt: input, options: {cwd, model, permissionMode, canUseTool, mcpServers, resume?}})`, starts consuming its stream, pushes the prompt |
| **Turn** | receives `output` / `setStatus` / `done` / `fail` | `system/init` → `setClaudeSessionId`. Assistant text and tool_use blocks → `output`. tool_result → `output`. Subagent messages (`parent_tool_use_id`) are skipped. `result` → `done(costDelta)` or `fail` |
| **Follow-up** `POST /api/sessions/:id/messages` on `idle` | stores a `user` message, calls `manager.send` | pushes the text into the same `InputQueue`. Same SDK process, same context |
| **Decision** | `requestDecision` inserts a pending row, sets `waiting_decision`, emits `decision_needed`, returns a Promise held in `waiters` | `canUseTool` awaits that Promise. Permission → allow/deny. `AskUserQuestion` → one decision per question, returned as `updatedInput.answers`. A rejected Promise (cancelled) → deny with `interrupt: true` |
| **Answer** `POST /api/decisions/:id` or a Telegram tap | validates the answer against the kind and options, marks it answered, emits `decision_resolved`, sets `running`, resolves the waiter | `canUseTool` returns and the turn continues |
| **Interrupt** | allowed only when queued, running or waiting_decision; expires pending decisions (rejecting their waiters); sets `idle` | removes the session from the wait queue; if it is mid-turn, sets `dropNextResult` and calls `query.interrupt()`. The process stays alive for the next message |
| **Terminate** `DELETE /api/sessions/:id` | expires decisions, sets `ended_at` and `terminated` | `stop()`: ends the input, `query.close()` (kills the CLI subprocess), forgets the session |
| **Resume** (message to an interrupted, error or terminated session) | requires `claude_session_id`; clears `ended_at`; calls `manager.start` with `resume` and `priorCostUsd = session.costUsd` | a new `query()` with `resume: claudeSessionId`. The SDK reloads the conversation, so context survives restarts |
| **Shutdown** (SIGINT/SIGTERM, `app.close()`) | `shutdown()` stops every live session; statuses are left as they are | `stop()` for each, so no orphan `claude` processes |
| **Startup recovery** | `recoverAfterRestart()`: queued/running/waiting_decision/idle → `interrupted`; pending decisions → `expired` | none: no process survives a restart |

### Concurrency

`claude.maxConcurrentSessions` limits how many sessions can have a **turn in flight** at once; idle sessions don't count. `runOrQueue` either runs the turn or sets `queued` and adds it to a FIFO. `release()` (on result, interrupt, stop or crash) starts the next queued turn.

### Cost accounting

The SDK's `result.total_cost_usd` is a running total for the `query()`. The manager tracks `costSoFar` and reports only the difference to `done`, which adds it to `sessions.cost_usd`. On resume the SDK total already includes earlier turns, so `costSoFar` starts at `priorCostUsd` to avoid counting them twice.

### Usage limits

A `rate_limit_event` with status `rejected`, or a `system/api_retry` with error `rate_limit`, triggers `limitReached` once per turn (`limitReported` flag).

## Todo tasks

Status: `wait` (default) → `run` (owner activated it) → `working` (its session turn is in flight) → `done` | `failed`. The owner can switch `wait` ↔ `run` and `failed` → `run` (retry from the content); `POST /api/task-groups/:id/run` activates a whole group.

`Orchestrator.scheduleTasks()` runs after every task change and every turn end (`done`, `fail`, interrupt, terminate). It starts each `run` task unless:
- the queue is paused by a usage limit;
- an earlier member of its group isn't `done` (a failed member blocks the rest);
- it is non-parallel and another non-parallel task of the same project is `working` (parallel tasks only share `maxConcurrentSessions`);
- the session it would reuse is busy.

**Which session.** A task's `content` is the prompt. A solo task starts a fresh session. A grouped task continues in the session of the nearest earlier member with the same project and role, and starts fresh if there is none. Groups may mix projects and roles, but parallel tasks can't be grouped, and only `wait` tasks can be moved.

**Limits and restarts.** `limitReached` pauses the queue until `retryAt` (15 min if unknown), in memory only. A task whose turn then fails goes back to `run` and keeps its `sessionId`. When the pause ends, that session gets "Continue where you left off." instead of the content. Restart recovery does the same for `working` tasks. Interrupting or terminating a task's session marks it `failed`.

## Delegation (sessions handing work to other roles)

In a project with roles, every session the owner starts (directly or as a todo task) is a possible **lead**: it gets an in-process MCP server `team` with one tool, `delegate({role, instructions})`, for the project's *other* roles (`StartOptions.team`, auto-allowed via `allowedTools`). Sessions doing delegated work get no tool, so delegation is one level deep.

- **`delegate`** (`Orchestrator.delegate`) inserts a `run` task: `role`, `content = instructions`, non-parallel, `delegated_by = groupId = lead session id`, and returns at once. The lead ends its turn; nothing blocks, so no slot deadlock.
- **Running.** Normal task scheduling: one at a time per project, in delegation order, and a role continues in its earlier session (group rule). A failed delegation doesn't block the lead's later ones.
- **Results.** When a delegated turn ends, its result (or error) is stored in `report`. `deliverReports()` (run by the scheduler) sends all waiting reports to their lead as one `system` message ("Delegation results: …") once the lead is `idle` or `interrupted` (restart), then clears `report`.
- **Questions** from workers go to the owner through the normal decision flow.
- **Guards.** At most 20 delegations per owner message to the lead. Interrupting or terminating the lead fails its open delegations, stops a running one and drops undelivered reports.
- **Alerts.** `task_done.intermediate` is true for worker turns and for lead turns with delegations still pending; Telegram skips those, so a run sends one alert.

Who to call and in what order is the lead's judgment, steered by its role's CLAUDE.md.

## Events (`ServerEvent` in `packages/shared`)

| Event | Emitted when | Consumers |
|---|---|---|
| `session_output` | every stored message | WS → dashboard console |
| `session_status` | every status change | WS, log |
| `decision_needed` | Claude asks for a permission or answer | WS (badge + card), Telegram (buttons), log |
| `decision_resolved` | answered (`answeredVia` web or telegram) or expired (`null`) | WS (card disappears), Telegram (edits the prompt message), log |
| `task_done` | a turn finished successfully (result, costUsd, durationMs, intermediate) | WS, Telegram (not intermediate), log |
| `limit_reached` | usage limit hit (retryAt or null) | WS, Telegram, log |
| `session_error` | turn failed or the SDK stream died | WS, Telegram (with a Resume button), log |
| `tasks_changed` | any task change, or the task queue paused/resumed | WS (refetch `/api/tasks`) |

Every event goes to every WebSocket client. Telegram sends only the types listed in `telegram.notify`, plus `decision_resolved` edits for prompts it sent.

## HTTP API (`app.ts`)

Every route except `POST /api/login` needs the owner token. Errors are `{error: string}`: 400 for validation or malformed bodies, 401 auth, 404 not found, 409 wrong state.

| Method & path | Purpose |
|---|---|
| `POST /api/login` `{token}` | sets the HttpOnly `orch_token` cookie (30 days) |
| `GET /api/health` | `{ok:true}`; the dashboard also uses it as its "logged in?" check |
| `GET/POST /api/projects` | list / create `{name, workdir, createDir?, roles?: [{name, description}]}` (workdir relative to or inside `rootDir`). Missing workdir → 404 unless `createDir: true`, which creates it; duplicate name → 409 |
| `DELETE /api/projects/:id` | 204. Removes the project and its sessions, messages, decisions and tasks from the DB; idle sessions are stopped. The workdir on disk is never touched. Any queued/running/waiting_decision session → 409 |
| `POST /api/projects/:id/roles` `{name, description}` | add a role (folder + CLAUDE.md) to an existing project; 201 with the project. Role already in the project → 409 |
| `GET/PUT /api/projects/:id/roles/:role` | read / replace `{content}` of `<workdir>/<role>/CLAUDE.md`; `{name, content}`. Role not in the project → 404 |
| `GET/POST /api/projects/:id/sessions` | list / start `{prompt, model?, role?}` (role must be one of the project's, else 400) |
| `GET/POST /api/roles`, `PUT/DELETE /api/roles/:id` | predefined roles: list / create / update `{name, description, guidelineIds?, descriptionIndex?}` / delete. Duplicate name → 409 |
| `GET/POST /api/guidelines`, `PUT/DELETE /api/guidelines/:id` | shared guidelines `{name, description}`. Duplicate name or delete while in use → 409 |
| `GET /api/sessions/:id` | one session |
| `GET/POST /api/sessions/:id/messages` | history / send `{text}` (202). Resumes if interrupted, error or terminated |
| `POST /api/sessions/:id/interrupt` | 204 |
| `DELETE /api/sessions/:id` | terminate, 204 |
| `GET/POST /api/tasks` | `{tasks, pausedUntil}` / create `{projectId, role?, name, content, parallel}` |
| `PUT /api/tasks/:id/status` `{status: wait\|run}` | 409 if working or done |
| `PUT /api/tasks/:id/position` `{before?, groupId?}` | `before`: into that task's group, in front of it; `groupId`: append; neither: ungroup. 204 |
| `DELETE /api/tasks/:id`, `POST /api/task-groups/:id/run` | delete (not while working) / activate a group's wait and failed tasks. 204 |
| `GET /api/decisions?status=` | list (pending, answered, expired) |
| `POST /api/decisions/:id` | `{answer: {behavior}}` or `{answer: {choice}}` |
| `GET /ws` | WebSocket stream of `ServerEvent` JSON |

In production, the built dashboard (`apps/dashboard/dist`) is served at `/` by the same server, so there is one port.

## Front doors

**Dashboard.**
- **Login:** `App` first queries `/api/health`. A 401 shows `LoginPage`, which posts the token and gets the cookie.
- **Routes:** hash routes `#/`, `#/projects/<name>` (URL-encoded project name, resolved from the projects list), `#/sessions/<id>`, `#/tasks`, `#/decisions`, `#/roles`, `#/guidelines`.
- **Create project:** if the server answers 404 (folder missing), the page asks with `confirm()` and retries with `createDir: true`.
- **Live updates:** `useEvents` opens `/ws`. Browsers send the cookie on the WebSocket handshake, which is why auth uses a cookie rather than a header. Events update the TanStack Query cache directly (`session_output` appends messages, `session_status` updates a session) or invalidate queries (decisions, sessions). After a reconnect, every query is invalidated to catch up.
- **Dev setup:** in dev, Vite on :5173 proxies `/api` and `/ws` to :4000.

**Telegram** (`telegram/index.ts`).
- **Who it talks to:** one bot that only talks to `telegram.chatId`. Middleware drops and logs updates from any other chat.
- **Button data (`callback_data`):**
  - `p:<decisionId>:a|d` approves or denies a permission.
  - `q:<decisionId>:<optionIndex>` answers a question.
  - `r:<sessionId>` resumes with "Continue where you left off."
- **Message format:** plain text, no parse mode. There are no URL buttons, because Telegram rejects localhost links.

## Configuration

- **`orchestrator.config.yaml`**, validated in `config.ts`:
  - `server.port`
  - `claude.defaultModel`, `claude.permissionMode` (default, acceptEdits or auto; never bypass), `claude.maxConcurrentSessions`
  - `projects.rootDir`
  - `telegram.botTokenEnv`, `telegram.chatId`, `telegram.notify`
  - `mcp.codex` (when enabled, Codex is added to every session as a stdio MCP server)
  - `ORCH_CONFIG` overrides the file path.
- **`.env`**, loaded by `config.ts` (existing environment variables win):
  - `ORCH_OWNER_TOKEN`: required; the server exits without it.
  - `TELEGRAM_BOT_TOKEN`: Telegram is disabled with a warning if it or `chatId` is missing.
  - `ANTHROPIC_API_KEY`: optional; otherwise the claude.ai login is used.
- **`ORCH_FAKE_SESSIONS=1`** uses `FakeSessionManager`, so UI work spends no tokens. Its prompts `[decision]` and `[limit]` trigger a permission and a usage limit (reset 50 ms later); a line `[delegate:<role>] <text>` calls `delegate`.

## Operations

- **Commands:**
  - `pnpm dev`: server with auto-reload, plus Vite.
  - `pnpm build && pnpm start`: production, a single port.
  - `pnpm test`, `pnpm typecheck`.
- **Network:** the server binds to `127.0.0.1` only. For remote access use Tailscale or an SSH tunnel.
- **Logs:**
  - JSON to stdout and to `logs/orchestrator.N.log`, rotated daily or at 10 MB, keeping 14.
  - Session events are logged with ids, status, cost and duration only. Never log prompt or output text, or tokens.
- **Backups:** `backups/orchestrator-<timestamp>.sqlite` at startup and every 24 h, keeping 7, using SQLite's online backup.
- **Supervision:** `scripts/launchd.sh install` builds, writes `~/Library/LaunchAgents/com.ai-orchestrator.plist` (RunAtLoad, KeepAlive) and loads it. SIGTERM is handled like Ctrl+C.

## Testing

- `app.test.ts` drives the real `buildApp` with `FakeSessionManager` and a temporary SQLite file. It covers the lifecycle, decisions, interrupt, restart recovery, resume, todo tasks (ordering, session reuse, per-project serialization, limit pause), delegation, WebSocket, auth and 4xx handling.
- `telegram.test.ts` replaces outgoing Bot API calls via `bot.api.config.use` and feeds updates with `bot.handleUpdate`.
- Real-Claude checks are manual. Use a cheap model and an isolated copy (for example a git worktree with its own `ORCH_CONFIG`), because `dbPath` is always `<repoRoot>/orchestrator.sqlite`.

## Known gaps and quirks

- **Multi-select questions:** an `AskUserQuestion` with `multiSelect` is answered with a single option, and free-text "Other" answers aren't supported.
- **Background commands:** Claude Code can move a long command into the background and end its turn. The session then shows `idle` while the command runs, and Interrupt has no turn to stop.
- **Bare sleeps:** Claude Code refuses plain `sleep` waits. Use real work when testing interrupts.
- **`interrupt` is optimistic:** the status becomes `idle` immediately, and the aborted turn's `result` is dropped when it arrives.
- **Unused config:** `server.dashboardOrigin` is validated but not used anywhere.
- **No logout:** there is no logout endpoint, and the cookie lasts 30 days. Changing `ORCH_OWNER_TOKEN` invalidates it.
