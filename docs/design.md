# pi-postman — Design

## Goals

- Allow a Pi session to send a structured handoff to another agent session on the same machine
- Keep each session's full context isolated; transmit only what the recipient needs to act
- Work across agents: Pi ↔ Pi, Pi ↔ Claude Code, Pi ↔ Codex, all on the same bus
- Keep the user in the loop on every transmission
- No daemon, no server, no network

## Non-goals

- Shared memory or context across sessions
- Auto-orchestration (parent dispatching subtasks — `subagent` covers that)
- Real-time streaming or live cursor sharing
- Cross-machine messaging
- Replacing the user's judgment on what gets handed off

## Architecture

Pi extension on top of [AMQ](https://github.com/avivsinai/agent-message-queue).

AMQ owns:
- Maildir-style queue (atomic delivery via `tmp → new → cur`)
- Cross-tool handle/identity (`pi-foo`, `claude-bar`, `codex-baz`)
- Threading, priorities, message kinds
- Cross-project federation (out of scope for v0.1, but available)
- Terminal notifications via `amq wake`

pi-postman owns:
- Pi extension wiring: `session_start`, `session_shutdown`, tool registration, status widgets
- A skill that teaches Pi *when* to use the postman tools and *how* to compose messages
- The user-approval gate on outbound transmission
- Mapping Pi session ids to AMQ handles

## Threat model

The reason this isn't just "give every agent root over each other's context": a poorly-prompted or compromised agent could try to inject prompts into a peer session. Mitigations:

1. **Outbound approval**: every `postman_send` shows the full message body to the user and waits for explicit approval before transmitting. The skill enforces this; the extension does not auto-send.
2. **Inbound non-injection**: messages land in the inbox but are NOT auto-injected into the receiving agent's context. The receiving agent (and its user) explicitly fetches via `postman_inbox` / `postman_read` when ready.
3. **Local-only**: AMQ is single-machine, files only. There is no network surface. An attacker would need filesystem access — at which point they have larger problems.
4. **No automatic actions**: messages are text. They cannot directly invoke tools, modify files, or run shell commands. Any action the recipient takes is mediated by the recipient's agent and the recipient's user.

## Why AMQ over agent-event-bus

[Pi RFC #2715](https://github.com/badlogic/pi-mono/issues/2715) proposes an extension over the Python `agent-event-bus` (FastMCP server). We chose AMQ instead:

| Property | AMQ | agent-event-bus |
|---|---|---|
| Transport | Filesystem (Maildir) | HTTP/MCP |
| Daemon required | No | Yes |
| Crash safety | Atomic file rename | Process-dependent |
| Debuggability | `cat`, `grep`, `git` | Server logs, MCP traces |
| Cross-tool today | Claude Code, Codex | Claude Code only |
| Federation | Cross-repo via peers | Single bus |
| Setup cost | `brew install amq` | Run a Python service |

For the workflow this extension targets — discrete handoffs between local agent sessions — file-based wins on simplicity, debuggability, and lifecycle (sessions can die without leaking server state).

## Design decisions

### Push, pull, or hybrid for context handoff?

**Hybrid.** Postman messages are short pointers; full artifacts (review docs, design docs, draft files) live on disk and are referenced by path. This keeps notifications cheap and inboxes scannable, while preserving the full context for whoever pulls it in.

### Does the recipient auto-fetch?

No. Inbox is checked on user demand. This is the "no rogue agent injection" guarantee.

### Handle naming

Default to `pi-<short-cwd>` (e.g. `pi-pi-postman`, `pi-world-trees-typ-osp-flags`). User can override via `PI_POSTMAN_HANDLE`. Stable across `/resume`.

### Threading

Use AMQ's native thread support. A `postman_send` with no `thread:` starts a new thread; `postman_reply` continues the parent's thread.

### Errors

If AMQ isn't installed or the bus isn't running, tools return a clear error message and a one-line install hint. Pi sessions still run; they just can't relay until AMQ is available.

## Open questions

- How does pi-postman interact with multiple worktrees of the same repo? Is the AMQ root per-worktree or per-repo? (Default: per-worktree for now; revisit when federation lands.)
- Should the inbox be auto-checked on `session_start` and offered as a notification? (Probably yes, but inbox-read still requires user action.)
- Should `postman_send` support attaching a file directly (vs referencing a path)? Pro: simpler for the user. Con: re-creates the "dump everything" anti-pattern. Leaning no.
- How do we handle a recipient that doesn't exist? Bounce back to the sender, queue for later, or hard error? (Probably hard error with a list of known sessions in the response.)
