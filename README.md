# pi-bridge

A Pi extension that lets your Pi sessions talk to each other (and to Claude Code, Codex, and any other agent on the same machine) via a local file-based message queue.

Two Pi tabs, each running an agent, each working on a different slice of the same problem. One does a code review. It distills the relevant context. It hands off to the other tab. The other tab picks it up and addresses the feedback. No copy-paste, no shared context, no daemons.

## Why

Pi sessions are isolated by design. That's mostly the right call — context drift across tabs would be worse than context isolation. But there's a real workflow gap: when you have several Pi tabs working in parallel, occasionally one needs to *hand off* a discrete piece of work to another. Today that means you, the human, copy-paste the relevant context yourself.

`pi-bridge` adds the missing primitive: a structured handoff between agent sessions, with the user always in the loop on what's transmitted.

## How it works

`pi-bridge` is a thin Pi extension on top of [Agent Message Queue (AMQ)](https://github.com/avivsinai/agent-message-queue), a battle-tested file-based message queue for local agent-to-agent communication. AMQ does the hard parts (atomic delivery, threading, priorities, terminal notifications, federation across repos). `pi-bridge` is the Pi-shaped surface on top: extension hooks, tools, and a skill that teaches Pi when and how to use them.

Architecture:

```
┌─────────────┐                      ┌─────────────┐
│  Pi tab A   │                      │  Pi tab B   │
│ (review)    │                      │ (author)    │
└──────┬──────┘                      └──────┬──────┘
       │                                    │
       │  pi-bridge extension               │  pi-bridge extension
       │  (registers tools, hooks lifecycle)│
       │                                    │
       └────────┐                  ┌────────┘
                ▼                  ▼
         ┌──────────────────────────────┐
         │   AMQ (single Go binary)     │
         │   ~/.agent-mail/             │
         │   ├─ inbox/{tmp,new,cur}/    │  ← maildir, atomic delivery
         │   ├─ sessions/               │
         │   └─ extensions/pi-bridge/   │  ← our session registry
         └──────────────────────────────┘
                ▲                  ▲
                │                  │
       ┌────────┘                  └────────┐
       │                                    │
┌──────┴──────┐                      ┌──────┴──────┐
│ Claude Code │                      │   Codex     │
│ (via amc)   │                      │ (via amx)   │
└─────────────┘                      └─────────────┘
```

A Pi tab opens, registers itself with AMQ, polls its inbox occasionally, and exposes a few tools (`bridge_send`, `bridge_inbox`, `bridge_read`, `bridge_reply`). When a tab sends a message, it's atomically delivered to the recipient's mailbox. The recipient's `pi-bridge` notices on the next poll, surfaces a notification, and lets the user pull the message into the agent's context on their next turn.

## What's in scope, what isn't

**In scope:**
- Sending discrete handoff messages between Pi sessions
- Receiving messages with terminal notifications
- Per-session inbox with priority and message kinds (review, question, decision, broadcast)
- Cross-tool: Pi can talk to Claude Code or Codex sessions on the same box (because they all use AMQ)
- Skill that teaches Pi *when* to bridge (review handoff, follow-up question, blocker) and *how* (what to include, what to omit)
- Human-in-the-loop on every transmission — the user sees what's being sent before it's sent

**Out of scope:**
- Shared context or memory across sessions (that's a different product)
- Auto-orchestration (parent agent dispatching subtasks — Pi already has `subagent` for that)
- Real-time streaming or live cursor sharing
- Network-distributed agents (AMQ is single-machine-only by design)
- Replacing the user's judgment on what gets handed off

## Install

> ⚠️ Pre-release. The skeleton is in this repo; the working bits are not yet wired up.

```bash
# 1. Install AMQ (the underlying queue)
brew install avivsinai/tap/amq      # macOS
# or:
curl -fsSL https://raw.githubusercontent.com/avivsinai/agent-message-queue/main/scripts/install.sh | bash

# 2. Install pi-bridge as a Pi package
pi install github:amertkara/pi-bridge

# 3. Initialize the AMQ root in your project (or globally via ~/.amqrc)
amq coop init

# 4. Open Pi tabs as usual; pi-bridge registers each session automatically
pi
```

## Example workflow

Two Pi tabs, both attached to the same world checkout. Tab A is doing a code review; tab B was the author.

**In tab A (review):**

> "I'm done reviewing PR #662657. Hand off the high-priority feedback to the author session."

Pi (with `pi-bridge` skill loaded):

```
I'll send a structured review handoff to the author session.

Recipient: pi-author@world          [other Pi sessions discovered via amq sessions]
Subject: PR #662657 — must-fix items
Body:
  3 must-fix issues identified:
  1. def perform(shop_id:, changeset_id:) diverges from sibling pattern
  2. not_nil! on rollout_treatment silently strands rollout
  3. StatsD.increment misses 3 of 5 exit paths
  Full review at: /tmp/pr-662657-review.md

[Approve & send] / [Edit before sending] / [Cancel]
```

User approves. The message is delivered to tab B's inbox.

**In tab B (author):** A terminal notification appears (via `amq wake`):

> 📬 New message from pi-review (kind: review_handoff, priority: normal)

User in tab B types:

> "Pull the latest from the bridge inbox."

Pi reads the message, the referenced file, and starts working on the fixes. The review-context lives in tab A; the author-context lives in tab B; the bridge transferred just the distilled handoff.

## Repository layout

```
pi-bridge/
├── README.md
├── package.json                 # Pi package manifest
├── extension/
│   └── pi-bridge.ts             # Pi extension entry point (registers tools, hooks lifecycle)
├── skills/
│   └── pi-bridge/
│       └── SKILL.md             # Teaches Pi when and how to bridge
├── docs/
│   ├── design.md                # Architecture decisions, threat model, alternatives considered
│   └── workflows.md              # Patterns: review handoff, question, broadcast, decision thread
└── examples/
    └── two-tab-review.md        # End-to-end walkthrough
```

## Roadmap

### v0.1 — Single-machine Pi-to-Pi
- [ ] Extension scaffold; registers tools, hooks `session_start` / `session_shutdown`
- [ ] Wraps `amq send`, `amq list`, `amq read`, `amq reply` as Pi tools
- [ ] Skill markdown teaches the review-handoff pattern
- [ ] Terminal notifications via `amq wake`
- [ ] Human approval gate before any outbound message

### v0.2 — Cross-tool
- [ ] Verify Pi ↔ Claude Code handoff (via `amc`) works end-to-end
- [ ] Verify Pi ↔ Codex (via `amx`) works end-to-end
- [ ] Document the cross-tool patterns in `workflows.md`

### v0.3 — Quality of life
- [ ] Footer status widget showing inbox count
- [ ] Custom message renderer for inbound bridge messages
- [ ] More message kinds (decision, question, blocker, ack)
- [ ] Optional auto-fetch on session start (off by default)

### v0.4 — Workflows
- [ ] `bridge handoff <pr-number>` skill that distills a review into a structured handoff
- [ ] `bridge ask <session> <question>` skill for cross-tab questions with thread continuity
- [ ] `bridge decide <topic>` skill for multi-session decision threads

## Security model

The user is the gate. Every outbound message is shown to the user before it leaves the tab; nothing is sent automatically. Inbound messages land in the inbox but are not auto-injected into the agent's context — the user has to explicitly pull them in. This eliminates the rogue-agent transmission vector at the cost of one approval click per send.

The transport (AMQ) is local-filesystem-only. There's no network, no daemon, no external service. Messages are plain text Markdown with a JSON header — readable with `cat`, debuggable with `grep`, version-controllable with `git`.

## Related work

- [Pi RFC #2715](https://github.com/badlogic/pi-mono/issues/2715) — proposes a similar extension over the Python `agent-event-bus` MCP server. `pi-bridge` is the AMQ-flavored alternative: file-based, no daemon, simpler.
- [agent-message-queue](https://github.com/avivsinai/agent-message-queue) — the queue this repo wraps.
- [agent-event-bus](https://github.com/avivsinai/agent-event-bus) — the alternative MCP-based bus.
- [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — a Pi extension shape this repo learns from.

## License

MIT

## Author

[Mert Kara](https://github.com/amertkara)
