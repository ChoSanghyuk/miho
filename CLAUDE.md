# AI ORCHESTRATOR



## Overview

This project is to build an ai orchestrator which manages lifecycle of ai sessions -- creates AI session, relays the commands to it, gets the outcome response from it and terminates the session. This manages cluade code sessions mainly. However, the mcp tools which call other ai session like codex can be added.

This orchestrator is connected to a dashboard webpage which would be a sole entry point from the user (owner of the cluade code account). Through the dashboard, the user makes projects, sends commands and confirms responses.

This orchestrator is connected to a telegram as well. The destination to a telegram chat can be set in a configuration file. All alarms, like task done messages, questions which require decision makings and token limit reached, etc will be all sent to telegram chat.



Refer https://code.claude.com/docs/ko/channels guide and related documents of Cluade Code Docs.

## Development Guide

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.



### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.



### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.



### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.



## RULES

[IMPORTANT] When figuring out the project code, first open the structure.md to get general idea of the project. Then read code files only related to the current job. 

[IMPORTANT] When the new changes are made, always check a update of the structure.md is needed. Keep the structure.md as a core source of project reference. Most importantly, the structure.md should remain concise.
