---
name: pi-bridge
description: "Send structured handoffs between agent sessions on the same machine. Use when the user asks to 'hand off', 'send to the other tab', 'bridge', 'message the author session', or wants to transfer distilled context (e.g. a code review) to another open Pi session."
---

# pi-bridge

You are bridging context between agent sessions. Your job is to take the relevant slice of the current session's work and send it as a structured message to another agent session, so the recipient can act on it without inheriting the sender's full context.

## When to use this skill

Trigger when the user asks for any of:

- "Hand off this review to the author session"
- "Send this to the other tab"
- "Bridge the findings to <name>"
- "Tell the other agent that …"
- "Forward this PR review summary"
- Any phrasing that implies one open session should pass discrete context to another

Do NOT use this skill for:

- Sharing full session context (out of scope; pi-bridge is for distilled handoffs)
- Spawning a new agent (use `subagent` instead)
- Asking the same agent in this tab to do something (just do it directly)

## Discovery

Before sending, list active sessions so you know who can receive:

```
bridge_sessions()
```

If the user names a recipient, match against the returned list. If no match, ask the user to disambiguate.

## Authoring the handoff

A good bridge message is **distilled, not dumped**. The recipient is a fresh agent context — it does not have your conversation, your file reads, or your reasoning chain. Include only:

1. **Subject** — one line, scannable in the recipient's inbox.
2. **What to do** — concrete, actionable. Imperative voice.
3. **Why it matters** — one or two sentences of context. Skip if the subject is self-explanatory.
4. **Where the full context lives** — file path, PR url, or message id of the underlying artifact. Don't paste the artifact into the body; reference it.
5. **Anything blocking** — if the recipient needs something from the user before they can act, say so.

Use message kinds to signal intent:

| Kind | Use for |
|---|---|
| `review_handoff` | Code-review findings being handed to the author session |
| `question` | Cross-session question with optional thread continuation |
| `decision` | A choice that affects multiple sessions; expect replies |
| `ack` | Confirming receipt or completion of a prior handoff |
| `blocker` | "I'm stuck and you can unblock me" |
| `broadcast` | One-to-many announcement (rarely needed) |

## Approval gate

**Always** preview the full outbound message and ask the user to approve before calling `bridge_send`. Format:

```
About to send via pi-bridge:

  To:       <recipient handle>
  Kind:     <kind>
  Priority: <urgent|normal|low>
  Subject:  <subject>
  Body:
    <body>

[Approve & send] / [Edit] / [Cancel]
```

If the user says "send it", "go", or "yes", proceed. If they edit, take their edits and re-preview. If they cancel, stop.

Never send without approval. Never send a message the user hasn't seen.

## Receiving

When the user asks to "check the bridge inbox", "see new messages", or similar:

1. Call `bridge_inbox()` first. Show the list with id, sender, subject, kind, priority.
2. For each message the user wants to read, call `bridge_read(id)`. Show the body.
3. If the message references a file path or PR, follow it.
4. If the message is a `question`, `blocker`, or `decision`, ask the user how they want to respond and use `bridge_reply(id, kind, body)`.

Do NOT auto-pull inbox messages on every turn. Only when the user asks. The user is the gate on inbound context, same as outbound.

## Patterns

### Pattern 1 — Code review handoff

User in tab A (review session): *"Hand off the must-fix items to the author session."*

You:
1. Discover sessions with `bridge_sessions()`. Identify the author session (likely named something like `pi-author` or matching the worktree).
2. Compile a tight summary of must-fix items from the review you just produced. Reference the full review file rather than pasting it.
3. Preview to user. Approve. Send with `kind: review_handoff`.
4. If the review file isn't already on disk, save it first (e.g. `/tmp/<pr-id>-review.md`) and reference the path in the body.

### Pattern 2 — Cross-session question

User in tab A: *"Ask the other tab whether the staging deploy completed."*

You:
1. `bridge_sessions()` to find the recipient.
2. Compose a one-sentence question.
3. Preview, approve, send with `kind: question` and `priority: normal`.
4. Tell the user the message id so they can check for the reply later.

### Pattern 3 — Inbox triage

User in tab B: *"Anything in the bridge inbox?"*

You:
1. `bridge_inbox(limit: 10)`.
2. If empty, say so and stop.
3. If non-empty, list with sender, kind, subject. Ask which to read.
4. For chosen messages, `bridge_read(id)`, show the body, follow any file references.

## Rules

1. **Approve every outbound message.** No exceptions.
2. **Distill, don't dump.** A bridge message that includes the entire conversation defeats the point.
3. **Reference, don't paste.** Big artifacts go in files; messages contain pointers.
4. **Match the recipient's session shape.** If the recipient is a Codex session, their inbox is the same AMQ mailbox; the message format is identical.
5. **Don't poll.** Only read inbox when the user asks.
6. **No `priority: urgent` without a real reason.** Reserve urgent for "the recipient is blocking on this right now."
7. **Threads are conversations.** If you're replying to a previous message, use `bridge_reply` (which preserves threading), not a fresh `bridge_send`.
