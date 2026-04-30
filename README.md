# pi-bridge

A Pi extension that lets your Pi sessions talk to each other (and to Claude Code, Codex, and any other agent on the same machine) via a local file-based message queue.

Two Pi tabs, each running an agent, each working on a different slice of the same problem. One does a code review. It distills the relevant context. It hands off to the other tab. The other tab picks it up and addresses the feedback. No copy-paste, no shared context, no daemons.

## Why

Pi sessions are isolated by design. That's mostly the right call — context drift across tabs would be worse than context isolation. But there's a real workflow gap: when you have several Pi tabs working in parallel, occasionally one needs to *hand off* a discrete piece of work to another. Today that means you, the human, copy-paste the relevant context yourself.

`pi-bridge` adds the missing primitive: a structured handoff between agent sessions, with the user always in the loop on what's transmitted.

## How it works

`pi-bridge` is a thin Pi extension on top of [Agent Message Queue (AMQ)](https://github.com/avivsinai/agent-message-queue), a file-based message queue for local agent-to-agent communication. AMQ does the hard parts (atomic delivery, threading, priorities, terminal notifications). `pi-bridge` is the Pi surface on top: extension hooks, tools, and a skill that teaches Pi when and how to use them.

```
┌─────────────┐         ┌─────────────┐
│  Pi tab A   │         │  Pi tab B   │
└──────┬──────┘         └──────┬──────┘
       │                       │
       └───────────┬───────────┘
                   ▼
         ┌──────────────────┐
         │  amq (Go binary) │
         │  ~/.agent-mail/  │
         └──────────────────┘
                   ▲
       ┌───────────┴───────────┐
       │                       │
┌──────┴──────┐         ┌──────┴──────┐
│ Claude Code │         │   Codex     │
└─────────────┘         └─────────────┘
```

## Tools

| Tool | What it does |
|---|---|
| `bridge_send` | Send a structured message to another agent session |
| `bridge_inbox` | List unread messages for this session |
| `bridge_read` | Read a message by id (moves it from `new` to `cur`) |
| `bridge_reply` | Reply to a message preserving thread continuity |
| `bridge_sessions` | List active agent sessions known to AMQ |
| `bridge_thread` | Show all messages in a thread |

The skill at [`skills/pi-bridge/SKILL.md`](./skills/pi-bridge/SKILL.md) teaches Pi *when* to use these tools and *how* to compose distilled handoffs. Every outbound message goes through an explicit user-approval step.

## Install

```bash
# Install AMQ (the underlying queue)
brew install avivsinai/tap/amq      # macOS
# or:
curl -fsSL https://raw.githubusercontent.com/avivsinai/agent-message-queue/main/scripts/install.sh | bash

# Clone for local development
git clone git@github.com:amertkara/pi-bridge.git
cd pi-bridge && pnpm install

# Wire it into Pi (point to the absolute path)
pi --extension /path/to/pi-bridge/extension/pi-bridge.ts

# Initialize an AMQ root in your project (or globally via ~/.amqrc)
amq coop init
```

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `AM_ME` | derived from `cwd` (`pi-<basename>`) | Handle this Pi session uses for sending and receiving |
| `PI_BRIDGE_HANDLE` | — | Overrides `AM_ME` for pi-bridge specifically |
| `AM_ROOT` | resolved by `amq` (`.amqrc` / `AMQ_GLOBAL_ROOT` / auto-detect) | AMQ queue root |

Handles must match `[a-z0-9_-]+` (AMQ requirement). pi-bridge sanitizes derived handles automatically.

## Security model

The user is the gate. The skill instructs Pi to preview every outbound message and wait for explicit approval before calling `bridge_send`. Inbound messages land in the inbox but are not auto-injected into the receiving agent's context — the user explicitly fetches them via `bridge_inbox` / `bridge_read`. Transport is local-filesystem-only via AMQ; no network, no daemon. Messages are plain Markdown with a JSON header — readable with `cat`, debuggable with `grep`, version-controllable with `git`.

## Status

Early. The extension typechecks and loads, with all six tools wired up. End-to-end testing across two Pi tabs and across Pi ↔ Claude Code is still pending. Treat this as a usable scaffold, not a battle-tested package.

## Related work

- [Pi RFC #2715](https://github.com/badlogic/pi-mono/issues/2715) — proposes a similar extension over the Python `agent-event-bus` MCP server. `pi-bridge` is the AMQ-flavored alternative: file-based, no daemon, simpler.
- [agent-message-queue](https://github.com/avivsinai/agent-message-queue) — the queue this repo wraps.
- [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — a Pi extension shape this repo learns from.

## License

MIT

## Author

[Mert Kara](https://github.com/amertkara)
