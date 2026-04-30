# Example: Two-tab code review handoff

A walkthrough of the canonical pi-bridge flow.

## Setup

You have two Pi tabs open in iTerm. Both are attached to the same Shopify world worktree (or two worktrees in the same repo).

```bash
# Tab A: review session, opened in the worktree
$ cd ~/world/trees/typ-osp-flags/src
$ pi
# Pi-bridge registers this session as `pi-typ-osp-flags-review` (or similar)

# Tab B: author session, also in the worktree (or a sibling worktree)
$ cd ~/world/trees/typ-osp-flags/src
$ pi
# Registers as `pi-typ-osp-flags-author`
```

## Tab A — produce the review

You run the PR review skill. It produces a long, detailed review document. Pi saves it to `/tmp/pr-656409-review.md` and gives you a summary.

You: *"Save the must-fix items to a structured handoff and send to the author session."*

Pi-bridge skill activates:

1. Calls `bridge_sessions()` → returns:
   ```
   pi-typ-osp-flags-review (this)
   pi-typ-osp-flags-author
   ```
2. Distills must-fix items from the review.
3. Drafts the message:
   ```
   To:       pi-typ-osp-flags-author
   Kind:     review_handoff
   Priority: normal
   Subject:  PR #656409 — 3 must-fix items
   Body:
     1. Flag-gate divergence between code (BaseConfigurationSwaps.enabled?) and PR body
        (merchant_rollouts?). redirect_service.rb:467
     2. No alert rule on thank_you_redirect_buyer_flags_error event.
        redirect_service.rb:486-492
     3. Nil chain on @input.receipt.purchase_order.artifacts[...] collapses cancellation
        paths into NoMethodError events. redirect_service.rb:468-469

     Full review at /tmp/pr-656409-review.md
   ```
4. Shows you the preview:
   ```
   ────────────────────────────────────────
   About to send via pi-bridge:

     To:       pi-typ-osp-flags-author
     Kind:     review_handoff
     Priority: normal
     Subject:  PR #656409 — 3 must-fix items
     Body:
       [as above]

   [Approve & send] / [Edit] / [Cancel]
   ────────────────────────────────────────
   ```
5. You type "send it" → Pi calls `bridge_send(...)` → returns `msg_id: 01h7zk2...`.

## Tab B — receive and act

A terminal notification appears (via `amq wake`):

```
📬 pi-bridge: New message from pi-typ-osp-flags-review
   Kind: review_handoff · Priority: normal
   Subject: PR #656409 — 3 must-fix items
```

You switch to tab B.

You: *"What's in the bridge inbox?"*

Pi-bridge:
1. `bridge_inbox(limit: 10)` → shows one new message.
2. You: *"Read it."* → `bridge_read(msg_id)`.
3. Pi reads `/tmp/pr-656409-review.md` for full context.
4. Starts addressing the three must-fix items.

When you finish the fixes, you can `bridge_reply(msg_id, kind: 'ack', body: '3 must-fix items addressed in commit <sha>')` to close the loop.

## What the user did vs what pi-bridge did

| Step | User | pi-bridge |
|---|---|---|
| Compose review | runs review skill | — |
| Distill handoff | tells Pi what to send | drafts the structured message |
| Approve outbound | approves the preview | shows the preview, blocks until approved |
| Transmit | — | calls AMQ via `amq send` |
| Receive notification | sees terminal notification | (delivered via `amq wake`) |
| Read inbound | asks "what's in the inbox?" | calls `amq list` and `amq read` |
| Act on it | works on the fixes | provides the message and the referenced file |

The user is the gate. pi-bridge is the courier.
