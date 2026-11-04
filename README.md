

```bash
 #Option A: fake sessions (free, no Claude). This is the best way to click through the UI. Sessions just echo your messages back. To see an Approve/Deny prompt, put [decision] anywhere in a message.
ORCH_FAKE_SESSIONS=1 pnpm dev

#Option B: real Claude Code sessions. This costs money. It uses your logged-in Claude Code account, or ANTHROPIC_API_KEY from .env if you set one. The default model is claude-opus-5-5, so you may want to set a cheaper model in orchestrator.config.yaml while testing.
pnpm dev
  ```