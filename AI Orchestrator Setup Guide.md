# AI Orchestrator Setup Guide

Nov 3, 2026 · @Jo

## Overview

The orchestrator is one backend process that owns every Claude Code session. Users reach it in only two ways: the dashboard (web) and Telegram. The repo currently holds only `CLAUDE.md`, so this guide proposes a stack. It splits the build into five domains, each with its own owner and a clear contract with the others.

| Domain | Owns | Talks to | Proposed stack |
| --- | --- | --- | --- |
| Backend (orchestrator core) | Projects, tasks, session lifecycle, event bus, REST/WebSocket API, persistence | Every other domain | Node 22 + TypeScript, Fastify, SQLite (Drizzle) |
| AI integration | Creating, prompting, streaming, resuming and stopping Claude Code sessions; MCP tools (for example Codex) | Backend (in-process module) | `@anthropic-ai/claude-agent-sdk`, Claude Code CLI |
| Frontend (dashboard) | Project list, task console, live output, decision prompts | Backend API + WebSocket | React + Vite + TypeScript |
| Messaging (Telegram) | Alerts, decision prompts with buttons, replies routed back | Backend event bus | grammY (Telegram Bot API) |
| Infra / DevOps & security | Config, secrets, process supervision, auth, logs | All | pnpm workspaces, launchd or pm2, `.env` |

The AI-integration domain runs inside the backend process, not as a separate service. It is split out because it carries the most Claude Code-specific knowledge and changes on its own schedule.

&#91;embedded content: architecture · 5 domains, 1 process\]

The dashboard and Telegram are interchangeable front doors. A decision answered in either one resolves the same backend record.

## Prerequisites and shared setup

Everyone sets these up once, before starting on any domain.

| Item | Version / detail | Check |
| --- | --- | --- |
| Claude Code CLI | Installed and logged in with the owner's claude.ai account (or `ANTHROPIC_API_KEY`) | `claude --version`, then `claude -p "hi"` |
| Node.js | 22 LTS | `node -v` |
| pnpm | 9+ | `pnpm -v` |
| Bun | Only if you also run the official Telegram channel plugin | `bun --version` |
| Telegram bot | Token from BotFather (`/newbot`) and the target chat ID | Send a message to the bot, then call `getUpdates` |
| Codex CLI (optional) | Only for the Codex MCP tool | `codex --version` |

### Repo layout

```
ai_orchestrator/
  apps/
    server/        # backend + AI integration + Telegram (one process)
      src/sessions/   # AI integration domain
      src/telegram/   # messaging domain
      src/api/        # REST + WebSocket
      src/db/         # schema + migrations
    dashboard/     # frontend
  packages/
    shared/        # TypeScript types for API payloads and events
  orchestrator.config.yaml
  .env              # secrets, never committed
```

### Configuration file

All domains read one file. Secrets live in `.env` and are referenced by name.

```yaml
server:
  port: 4000
  dashboardOrigin: http://localhost:5173
claude:
  defaultModel: claude-opus-5-5
  permissionMode: default      # default | acceptEdits | auto
  maxConcurrentSessions: 3
projects:
  rootDir: ~/workspace
telegram:
  botTokenEnv: TELEGRAM_BOT_TOKEN
  chatId: 123456789
  notify: [task_done, decision_needed, limit_reached, session_error]
mcp:
  codex:
    enabled: false
    command: codex
    args: [mcp-server]
```

The `packages/shared` types are the contract between domains. Change them first, in their own PR, before changing either side.

## Backend (orchestrator core)

**Role:** owns the state and the rules. Every session, task and alert passes through the backend. No other domain talks to Claude Code or Telegram directly.

### Setup steps

1. Scaffold `apps/server` with Fastify, `@fastify/websocket`, Drizzle + `better-sqlite3`, and `zod`.
2. Load `orchestrator.config.yaml` and `.env` at startup. Validate with zod and refuse to start on a bad config.
3. Create the schema below and a migration script (`pnpm db:migrate`).
4. Add an in-process event bus (a typed `EventEmitter`). The AI, Telegram and WebSocket modules subscribe to it.
5. Expose the REST and WebSocket API below.
6. On startup, mark any session left `running` as `interrupted`, so a restart never leaves ghost sessions.

### Data model

| Table | Key columns |
| --- | --- |
| `projects` | id, name, workdir, created\_at |
| `sessions` | id, project\_id, claude\_session\_id, status, model, cost\_usd, started\_at, ended\_at |
| `messages` | id, session\_id, role (user / assistant / tool / system), body\_json, created\_at |
| `decisions` | id, session\_id, kind (permission / question), payload\_json, status, answered\_via (web / telegram), answer\_json |

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects` | Create a project (name + working directory) |
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects/:id/sessions` | Start a session with a first prompt |
| `POST` | `/api/sessions/:id/messages` | Send a follow-up command |
| `POST` | `/api/sessions/:id/interrupt` | Stop the current turn |
| `DELETE` | `/api/sessions/:id` | Terminate the session |
| `POST` | `/api/decisions/:id` | Answer a permission request or question |
| `GET` | `/ws` | Push stream: session output, status changes, decisions |

### Done when

- [ ] `curl` can create a project, start a session, send a follow-up and terminate it.
- [ ] Restarting the server keeps projects and session history.
- [ ] Two sessions in different projects run at the same time without mixing output.

## AI integration (Claude Code sessions)

**Role:** the only code that touches Claude Code. It turns backend calls (start, send, interrupt, stop) into Agent SDK calls. It turns the SDK's message stream into backend events.

Use the TypeScript Agent SDK, not a spawned `claude -p` per command. The SDK gives a live session you can keep feeding, a `canUseTool` callback for permission prompts, `interrupt()`, and session IDs for resume. Those four map directly onto the lifecycle the orchestrator manages.

### Setup steps

1. `pnpm add @anthropic-ai/claude-agent-sdk` in `apps/server`.
2. Write `SessionManager` in `src/sessions/` with `start(projectId, prompt)`, `send(sessionId, text)`, `interrupt(sessionId)` and `stop(sessionId)`.
3. Start each session in streaming-input mode with `cwd` set to the project's workdir and the model and permission mode from config. Store the SDK's `session_id` as `claude_session_id`.
4. Implement `canUseTool`: create a `decisions` row, emit `decision_needed`, then wait until the dashboard or Telegram answers. Do the same for `AskUserQuestion`.
5. Map stream messages to events: assistant text → `session_output`; `result` → `task_done` (with cost and duration); `system/api_retry` with `rate_limit`, or a usage-limit result → `limit_reached`; any failure → `session_error`.
6. Enforce `maxConcurrentSessions`. Queue extra starts instead of refusing them.
7. To continue a terminated session later, start a new one with `resume: claude_session_id`.

### Session states

| State | Entered when | Leaves to |
| --- | --- | --- |
| `queued` | Start requested, concurrency limit reached | `running` |
| `running` | SDK session started or a new message sent | `waiting_decision`, `idle`, `error` |
| `waiting_decision` | `canUseTool` or a question fired | `running` once answered |
| `idle` | A turn finished (`result` received) | `running` on the next message, `terminated` |
| `terminated` | User stopped it | `running` again only via resume |
| `error` / `interrupted` | SDK failure, or server restart mid-turn | `running` via resume |

### MCP tools (Codex and others)

Pass extra MCP servers through the SDK's `mcpServers` option, built from the `mcp` block in config. For Codex, register the Codex CLI's MCP server as a stdio server. Claude can then call it as a tool inside a session, with no new orchestration code. Pre-approve those tools with `allowedTools` only if you trust them unattended.

### Done when

- [ ] A session edits a file in a test project, and the dashboard shows each step.
- [ ] A `Bash` permission request pauses the session until it is approved from the dashboard.
- [ ] Interrupt stops a long turn within a few seconds. Stop ends the SDK process with no orphan `claude` processes (`ps aux | grep claude`).
- [ ] A terminated session resumes with its earlier context.

## Frontend (dashboard)

**Role:** the user's only entry point for creating projects and sending commands. It holds no state of its own. It renders what the backend says and sends what the user types.

### Setup steps

1. `pnpm create vite apps/dashboard --template react-ts`, then add TanStack Query for REST calls and a small WebSocket hook for the push stream.
2. Import request and event types from `packages/shared`. Never redefine them locally.
3. Proxy `/api` and `/ws` to `localhost:4000` in `vite.config.ts` for development.
4. Build the screens below.
5. Reconnect the WebSocket automatically. After a reconnect, refetch the open session's messages so nothing is missed.

### Screens

| Screen | Shows | Actions |
| --- | --- | --- |
| Projects | Name, workdir, active session count, last activity | Create project |
| Project | Sessions with state, model, cost | Start session with a prompt |
| Session console | Live stream of assistant text and tool calls, collapsible tool output | Send message, interrupt, terminate, resume |
| Decisions inbox | Pending permission requests and questions across all sessions | Approve, deny, answer |

Show a pending decision in both the session console and the inbox. When Telegram answers first, remove the card on the `decision_resolved` event.

### Done when

- [ ] A user can do the full flow (create project → start → follow up → approve a tool → terminate) without a terminal.
- [ ] Output appears while the turn runs, not only at the end.
- [ ] A decision answered in Telegram disappears from the dashboard within a second.

## Messaging (Telegram)

**Role:** sends every alert to the configured chat and turns button taps into decision answers. The orchestrator owns one bot for all sessions.

The official Telegram [channel plugin](https://code.claude.com/docs/en/channels) attaches a bot to a single interactive `claude --channels` session. The orchestrator runs many SDK sessions, so it talks to the Bot API itself instead. The pairing and allowlist idea from the plugin still applies: accept updates only from the configured chat.

### Setup steps

1. In Telegram, message `@BotFather`, send `/newbot`, and copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Send any message to the new bot. Open `https://api.telegram.org/bot<token>/getUpdates` and copy `message.chat.id` into `telegram.chatId`.
3. `pnpm add grammy` and write `src/telegram/` to subscribe to the event bus and send the messages below.
4. Use long polling in development. Switch to a webhook only if the server gets a public HTTPS URL.
5. Drop every update whose chat ID is not `telegram.chatId`.

### Events sent

| Event | Message | Buttons |
| --- | --- | --- |
| `task_done` | Project, session, one-line result, cost, dashboard link | Open |
| `decision_needed` | Tool name and input (truncated), or the question and its options | Approve / Deny, or one per option |
| `limit_reached` | Which session hit the limit and when it retries, if known | Open |
| `session_error` | Error text (truncated), session state | Resume / Open |

Put the decision ID in each button's `callback_data` (Telegram caps it at 64 bytes). On a tap, call the same backend function as `POST /api/decisions/:id`, then edit the message to show who answered. A decision already answered on the web returns “already answered”.

### Done when

- [ ] Each of the four events reaches the chat in a test run.
- [ ] Approve in Telegram resumes a paused session.
- [ ] A message to the bot from another account is ignored and logged.

## Infra / DevOps and security

**Role:** makes the orchestrator run unattended on the owner's machine and keeps it from becoming a remote shell for anyone else.

### Setup steps

1. Root `package.json` scripts: `dev` (server + dashboard together), `build`, `start`, `db:migrate`, `test`.
2. Commit `.env.example` with every variable name. Add `.env` and `*.sqlite` to `.gitignore`.
3. Run the server under a supervisor: a `launchd` agent on macOS, or `pm2` elsewhere. The supervisor must send SIGINT before SIGTERM, so in-flight turns end cleanly.
4. Serve the built dashboard from the backend in production, so there is one port to protect.
5. Write structured logs (pino) to a rotating file. Log session ID, event and duration, never prompt bodies or tokens.
6. Back up the SQLite file daily (a copy is enough).

### Security rules

- Bind to `127.0.0.1` by default. For remote access, put it behind Tailscale or an SSH tunnel, not an open port.
- Protect the dashboard and API with a single owner token or passkey, checked on REST and on the WebSocket handshake.
- Restrict project workdirs to `projects.rootDir`. Reject paths outside it.
- Default permission mode is `default`, so risky tools go through a decision. Treat Telegram approval as equal to terminal approval: only the owner's chat may answer.
- Never use `--dangerously-skip-permissions` or `bypassPermissions` in this service.

### Done when

- [ ] After a reboot, the orchestrator is running and reachable without manual steps.
- [ ] A request without the owner token gets `401`.
- [ ] `git status` on a fresh clone shows no secrets or database files.

## Integration order and end-to-end check

Build in this order. Once step 2 is merged, the domains can work in parallel against the shared types.

1. **Infra:** repo skeleton, workspaces, config loader, `.env.example`.
2. **All domains, one PR:** `packages/shared` with the API payloads and these events: `session_output`, `session_status`, `decision_needed`, `decision_resolved`, `task_done`, `limit_reached`, `session_error`.
3. **Backend:** schema, event bus, API, with a fake `SessionManager` that echoes prompts.
4. **In parallel:** AI integration replaces the fake. Frontend builds against the fake. Messaging subscribes to the bus.
5. **Infra:** owner auth, supervisor, logging.

### End-to-end checklist

- [ ] Create project `demo` in the dashboard, pointing at an empty folder.
- [ ] Start a session: “Create hello.txt containing hi, then run `cat hello.txt`.”
- [ ] The `Bash` permission request appears in both the dashboard and Telegram.
- [ ] Approve it in Telegram. The dashboard card disappears and the session continues.
- [ ] Telegram gets `task_done` with cost. `hello.txt` exists.
- [ ] Send a follow-up from the dashboard. The session keeps its context.
- [ ] Terminate the session. No `claude` process remains.
- [ ] Restart the server. Project and history are still there, and the session can resume.
