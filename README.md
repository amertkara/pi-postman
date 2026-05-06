<p align="center">
  <img src="assets/logo.svg" alt="pi-postman logo" width="160" height="160" />
</p>

# pi-postman

A Pi extension that lets Pi sessions on the same machine talk to each other (and to Claude Code, Codex, or any other agent that speaks the same queue) without copy-paste, without shared context, and without a daemon.

Two Pi tabs, each running an agent, each working on a different slice of the same problem. One does a code review. It distills the relevant context. It hands off to the other tab. The other tab gets a notification, picks it up, and addresses the feedback.

## Why

Pi sessions are isolated by design — context drift across tabs would be worse than context isolation. But there's a real workflow gap: when several Pi tabs work in parallel, occasionally one needs to *hand off* a discrete piece of work to another. Today that means you, the human, copy-paste relevant context yourself.

`pi-postman` adds the missing primitive: structured handoffs between agent sessions, with the user always in the loop on what's transmitted.

## How it works

`pi-postman` is a thin Pi extension on top of [Agent Message Queue (AMQ)](https://github.com/avivsinai/agent-message-queue), a file-based message queue for local agent-to-agent communication. AMQ does the hard parts (atomic delivery, threading, priorities). `pi-postman` is the Pi surface on top: lifecycle hooks, six tools, a maildir watcher, and a skill that teaches Pi when and how to use them.

```
┌─────────────┐         ┌─────────────┐
│  Pi tab A   │         │  Pi tab B   │
│ (pi-tab-a)  │         │ (pi-tab-b)  │
└──────┬──────┘         └──────┬──────┘
       │                       │
       │  postman_send         │  fs.watch fires
       │  amq write            │  toast + counter
       └──────────┬────────────┘  (+ auto-react)
                  ▼
        ┌──────────────────────┐
        │   ~/.agent-mail/     │
        │   maildir tree       │
        └──────────────────────┘
                  ▲
        ┌─────────┴─────────┐
        │                   │
   ┌────┴────┐         ┌────┴────┐
   │ Claude  │         │  Codex  │
   │  Code   │         │         │
   └─────────┘         └─────────┘
```

Messages are plain Markdown files with a JSON header block. You can `cat` them, `grep` them, version-control them.

## Install

### 1. Install AMQ (the queue)

```bash
brew install avivsinai/tap/amq        # macOS
# or:
curl -fsSL https://raw.githubusercontent.com/avivsinai/agent-message-queue/main/scripts/install.sh | bash
```

Verify:

```bash
amq --version
```

### 2. Clone and build pi-postman

```bash
git clone git@github.com:amertkara/pi-postman.git ~/src/github.com/amertkara/pi-postman
cd ~/src/github.com/amertkara/pi-postman
pnpm install
pnpm typecheck
```

The extension is plain TypeScript loaded directly by Pi via `--experimental-strip-types`; no build step needed.

### 3. Initialize the maildir

`amq` resolves its root via `.amqrc` (per-project), `AMQ_GLOBAL_ROOT`, or `~/.agent-mail` as the fallback. Easiest path:

```bash
# Global root at ~/.agent-mail (used by all sessions unless overridden)
amq coop init
```

This creates `~/.agent-mail/` and the per-handle directories on first send.

### 4. Wire into Pi

Pass the extension path to `pi`. You can do this per-session or in your shell config.

**Per-session (simplest):**

```bash
AM_ME=pi-foo pi --extension /Users/you/src/github.com/amertkara/pi-postman/extension/pi-postman.ts
```

**Permanent (every Pi session):**

```bash
# In ~/.zshrc or ~/.bashrc
alias pi='pi --extension /Users/you/src/github.com/amertkara/pi-postman/extension/pi-postman.ts'
```

Or symlink the extension into your global Pi extensions directory if your Pi version supports auto-loading.

When the extension loads, the footer shows `postman: <handle>`.

## Quickstart: two-tab walkthrough

The canonical workflow. Two Pi tabs, one sends, the other receives, replies come back.

### Setup

Open two terminal tabs.

**Tab A:**

```bash
AM_ME=pi-tab-a pi --extension /Users/you/src/github.com/amertkara/pi-postman/extension/pi-postman.ts
```

**Tab B (with auto-react on so the agent reacts to incoming messages):**

```bash
AM_ME=pi-tab-b PI_POSTMAN_AUTO_REACT=1 pi --extension /Users/you/src/github.com/amertkara/pi-postman/extension/pi-postman.ts
```

Tab A's footer reads: `postman: pi-tab-a`
Tab B's footer reads: `postman: pi-tab-b · auto`

### Send

In tab A, ask Pi:

> Send a postman message to pi-tab-b asking it to summarize the README of this repo.

Pi will preview the message and ask for approval before calling `postman_send`. Approve.

### Receive (tab B)

Within ~1 second:

1. **Toast** in tab B: `📬 pi-tab-a (question): <subject>`
2. **Footer counter** ticks: `postman: pi-tab-b · 📬 1 · auto`
3. **A new agent turn kicks off in tab B** (auto-react). Pi sees the arrival, calls `postman_read`, and offers a reply.

### Reply (tab B → tab A)

In tab B, Pi will draft the response and ask for approval before calling `postman_reply`. Approve.

Tab A's watcher fires. Toast + counter tick up there. The thread now exists across both inboxes; either side can call `postman_thread <thread-id>` to see the whole exchange.

## Tools

All six tools are namespaced `postman_*` and registered via the Pi extension API.

| Tool | What it does |
|---|---|
| `postman_send` | Send a structured message to another agent session. Always preview + approve. |
| `postman_inbox` | List unread messages for this session. Resets the live counter to 0. |
| `postman_read` | Read a message by id. Moves it from `inbox/new/` to `inbox/cur/`. |
| `postman_reply` | Reply to a message, preserving thread continuity. Falls back to `send` with the original thread id if AMQ's `reply_to` parsing hits a known upstream bug. |
| `postman_sessions` | List active agent sessions known to AMQ. Use before `postman_send` to pick a recipient. |
| `postman_thread` | Show all messages in a thread. |

The skill at [`skills/pi-postman/SKILL.md`](./skills/pi-postman/SKILL.md) teaches Pi *when* to call these and *how* to compose distilled handoffs. Every outbound message goes through an explicit user-approval step.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `AM_ME` | derived from `cwd` (`pi-<basename>`) | Handle this Pi session uses for sending and receiving |
| `PI_POSTMAN_HANDLE` | — | Overrides `AM_ME` for pi-postman specifically |
| `AM_ROOT` | resolved by `amq` (`.amqrc` → `AMQ_GLOBAL_ROOT` → `~/.agent-mail`) | AMQ queue root |
| `PI_POSTMAN_AUTO_REACT` | off | When set to `1`/`true`/`yes`/`on`, every new inbound message triggers a turn in the receiving agent so it can decide whether to read/reply. Off = toast + counter only. |

Handles must match `[a-z0-9_-]+` (AMQ requirement). pi-postman sanitizes derived handles automatically.

## Live notifications

On `session_start`, pi-postman watches the maildir directly via Node's `fs.watch`:

```
~/.agent-mail/agents/<handle>/inbox/new/
```

Each newly-arrived `.md` file produces:

- A **toast** (`📬 from (kind): subject`). `urgent` priority renders as a warning toast.
- A **footer counter** that ticks up: `postman: pi-tab-b · 📬 2`. Resets to 0 when you call `postman_inbox`.
- **(Auto-react mode only)** A user-message injection via `pi.sendUserMessage` that triggers a new turn in the receiving agent.

`fs.watch` is event-driven (fsnotify under the hood on macOS/Linux) — no polling, cheap at idle. The watcher is closed cleanly on `session_shutdown`.

> **Note:** an earlier version of this extension shelled out to `amq watch --json` for live updates. It turns out `amq watch` is not a long-running event stream — it dumps existing messages once and exits. The fs-based watcher is more robust, doesn't depend on AMQ subprocess behavior, and works regardless of which AMQ release introduced what JSON shape.

## Security model

The user is the gate.

- **Outbound**: the skill instructs Pi to preview every outbound message and wait for explicit approval before calling `postman_send` or `postman_reply`. The same approval step applies in auto-react mode.
- **Inbound (default)**: messages land in the inbox but are not auto-injected into the receiving agent's context. You see a toast; the agent doesn't see anything until you say "check the inbox."
- **Inbound (auto-react)**: when `PI_POSTMAN_AUTO_REACT=1`, the watcher injects an arrival notice into the agent's session, triggering a turn. The agent reads, decides, and drafts a response — but outbound replies still go through preview-and-approve before `postman_reply` fires.

Transport is local-filesystem-only via AMQ. No network, no daemon, no shared cloud state. Messages are plain Markdown — readable, debuggable, version-controllable.

## Troubleshooting

**Footer shows `amq missing`.** Install AMQ (`brew install avivsinai/tap/amq`).

**Footer shows `pi-postman: inbox dir … not found yet`.** AMQ creates the per-handle inbox on first send/receive. Send any test message (`amq send --me pi-tab-a --to pi-tab-b --subject test --body hi`) and restart Pi.

**Toasts don't fire when a message arrives.** Check that the maildir path in your toast warning matches your `AM_ROOT`. If you've set `AM_ROOT` or `AMQ_GLOBAL_ROOT`, pi-postman picks them up automatically; otherwise it defaults to `~/.agent-mail`.

**`postman_reply` says "via send-fallback".** This is the `pi-postman` workaround for an upstream AMQ bug where `reply_to` headers get corrupted with the root directory name. Replies still work and threading is preserved — the message is sent via `amq send` with the original thread id rather than `amq reply`. No action needed.

**Auto-react isn't firing.** Confirm the footer reads `· auto`. If it doesn't, restart Pi with `PI_POSTMAN_AUTO_REACT=1` set in the same shell. Note that some Pi versions implement `sendUserMessage` differently — if you see `auto-react failed: …` toasts, please file an issue.

## Status

End-to-end working between two Pi tabs: send, receive, watcher notifications, auto-react, threaded replies (with send-fallback for the upstream AMQ `reply_to` bug). Cross-agent (Pi ↔ Claude Code, Pi ↔ Codex) hasn't been validated yet but should work since AMQ is the shared protocol — file an issue if it doesn't.

## Related work

- [Pi RFC #2715](https://github.com/badlogic/pi-mono/issues/2715) — proposes a similar extension over the Python `agent-event-bus` MCP server. `pi-postman` is the AMQ-flavored alternative: file-based, no daemon, simpler.
- [agent-message-queue](https://github.com/avivsinai/agent-message-queue) — the queue this repo wraps.
- [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — a Pi extension shape this repo learns from.

## License

MIT

## Author

[Mert Kara](https://github.com/amertkara)
