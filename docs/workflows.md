# pi-bridge — Workflows

Concrete patterns for using `pi-bridge` between agent sessions on the same machine.

---

## 1. Code review handoff (Pi → Pi)

The canonical example. Tab A is doing a review; tab B was the author.

**Tab A (review):**

User: *"I'm done with the review of PR #662657. Hand off the must-fix items to the author session."*

Pi:
1. `bridge_sessions()` → finds `pi-author` (or whatever tab B's handle is).
2. Distills must-fix items from the just-completed review.
3. Saves the full review to `/tmp/pr-662657-review.md` if not already on disk.
4. Composes:
   ```
   To:       pi-author
   Kind:     review_handoff
   Priority: normal
   Subject:  PR #662657 — 3 must-fix items
   Body:
     1. def perform(shop_id:, changeset_id:) diverges from sibling pattern (kwargs-vs-params)
     2. not_nil! on rollout_treatment silently strands rollout
     3. StatsD.increment misses 3 of 5 exit paths

     Full review with context: /tmp/pr-662657-review.md
   ```
5. Shows preview to user. User approves.
6. Calls `bridge_send(...)`. Returns the message id.

**Tab B (author):** A terminal notification appears via `amq wake`.

User: *"Pull the latest from the bridge."*

Pi:
1. `bridge_inbox()` → shows the new message.
2. User picks it. `bridge_read(id)`.
3. Pi reads the body, opens `/tmp/pr-662657-review.md`, and starts on the fixes.

---

## 2. Cross-session question

Tab A is exploring a refactor; tab B is running tests in a worktree.

**Tab A:**

User: *"Ask the test tab if the merge-orchestration suite is green on main."*

Pi:
1. `bridge_sessions()` → identifies the test tab (`pi-test-runner`).
2. Composes:
   ```
   To:       pi-test-runner
   Kind:     question
   Subject:  Is merge-orchestration suite green on main?
   Body:
     I'm about to refactor the changeset registry. Before I start —
     what's the current state of components/optimization/test/services/?
     Specifically merge_orchestration_service_test.rb.
   ```
3. Preview, approve, send. Returns message id.
4. Tells the user to check back later.

**Tab B:** Notification arrives. User runs the test, gets a result, asks Pi to reply.

Pi: `bridge_reply(id, kind: "ack", body: "Suite green at <sha>. 247 examples, 0 failures.")`

**Tab A:** User: *"Any reply?"* → `bridge_inbox(from: 'pi-test-runner', kind: 'ack')` → reads the answer.

---

## 3. Pi ↔ Claude Code

The cross-tool flow is identical to Pi ↔ Pi because both attach to the same AMQ bus.

User in Pi tab A: *"Send the architecture decision to my Claude Code session in /Users/me/src/foo."*

Pi:
1. `bridge_sessions()` → returns Pi sessions and Claude Code sessions (Claude attaches via `amc` or `amq coop exec claude`).
2. Identifies `claude-foo` from the list.
3. Composes a `decision` kind with the body and sends after approval.

In the Claude Code tab: the `agent-message-queue` integration on Claude Code's side surfaces the inbound message. Same primitives, different agent.

---

## 4. Decision thread across multiple sessions

User has three Pi tabs (frontend, backend, infra) and wants a quick consensus on a config change.

**Tab A (frontend):**

User: *"Broadcast to backend and infra: should we move the timeout to 30s?"*

Pi:
1. `bridge_sessions()` → finds `pi-backend`, `pi-infra`.
2. Sends two messages with `kind: decision`, same `subject`, same fresh `thread` id.
3. Tracks the thread id.

**Tabs B and C** independently receive, reply with `bridge_reply` (which uses the same thread). Replies land in tab A's inbox under the same thread.

**Tab A:** User: *"Check the thread."* → Pi reads all messages with that thread id and summarizes the consensus.

> Note: this is an opinionated AMQ pattern — see [AMQ COOP.md](https://github.com/avivsinai/agent-message-queue/blob/main/COOP.md) for the full thread vocabulary.

---

## 5. Blocker handoff

Tab A is stuck on something tab B is mid-flight on.

User in tab A: *"I'm blocked on the migration tab. Tell them I need the new column live before I can finish."*

Pi:
1. Sends `kind: blocker, priority: urgent` to `pi-migration`.
2. Body: one-sentence description of what's blocked + how the recipient unblocks it.
3. The `urgent` priority makes the receiving tab's notification more prominent.

In tab B: the user sees the urgent notification, asks Pi to read it, addresses the blocker, replies with `kind: ack`.

---

## Anti-patterns

### Don't dump full context

Bad:

> Body: [full 8000-line conversation transcript pasted in]

Good:

> Body: "See discussion at /tmp/discussion-2026-04-29.md, decision was Option B."

### Don't bridge what you can do yourself

Bad: tab A asks tab B to run `bin/rails test` because it's "easier".

Good: tab A runs its own tests. Bridge messages are for things the recipient is uniquely positioned to handle.

### Don't auto-poll

Bad: a skill that fetches `bridge_inbox` on every turn.

Good: the user asks "anything in the inbox?" and you fetch.

### Don't use `urgent` for everything

If everything is urgent, nothing is. Reserve for blockers where the recipient should drop their current work.

### Don't reply with a fresh `bridge_send`

Bad: `bridge_send(to: original_sender, ...)` — loses thread continuity.

Good: `bridge_reply(id: original_id, ...)`.
