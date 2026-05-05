/**
 * pi-postman — Pi extension that relays messages between agent sessions via AMQ
 *
 * Wraps `amq` (https://github.com/avivsinai/agent-message-queue) so a Pi
 * session can send structured handoffs to other agent sessions on the same
 * machine. The user is the gate on every transmission; inbound messages
 * are not auto-injected into the receiving agent's context.
 *
 * Configuration via env:
 *   AM_ME             — agent handle for this Pi session (default: `pi-<basename(cwd)>`)
 *   AM_ROOT           — AMQ root (default: AMQ resolves via `.amqrc` / `AMQ_GLOBAL_ROOT` / auto-detect)
 *   PI_POSTMAN_HANDLE — overrides AM_ME for this extension specifically
 *   PI_POSTMAN_AUTO_REACT — if "1", true, or yes, the watcher injects a user
 *                          message into the session on each new postman event,
 *                          causing the agent to immediately consider/fetch it.
 *                          Default: off (toast + footer counter only).
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type FSWatcher, readdirSync, readFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function deriveHandle(cwd: string): string {
  const explicit = process.env.PI_POSTMAN_HANDLE ?? process.env.AM_ME;
  if (explicit && /^[a-z0-9_-]+$/.test(explicit)) return explicit;

  // AMQ requires lowercase [a-z0-9_-]. Sanitize the cwd basename.
  const base = basename(cwd) || "pi";
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "pi";
  return sanitized.startsWith("pi-") ? sanitized : `pi-${sanitized}`;
}

interface AmqMessageHeader {
  id?: string;
  from?: string;
  to?: string[] | string;
  subject?: string;
  kind?: string;
  priority?: string;
  thread?: string;
  created?: string;
  reply_to?: string;
}

interface AmqExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  notInstalled: boolean;
}

async function runAmq(pi: ExtensionAPI, args: string[]): Promise<AmqExecResult> {
  try {
    const result = await pi.exec("amq", args, { timeout: 30_000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      notInstalled: false,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const notInstalled = /ENOENT|not found|command not found/i.test(msg);
    return {
      ok: false,
      stdout: "",
      stderr: notInstalled
        ? "amq is not installed. Install with `brew install avivsinai/tap/amq` or see https://github.com/avivsinai/agent-message-queue."
        : msg,
      notInstalled,
    };
  }
}

function toolError(text: string): AgentToolResult<undefined> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

function toolOk(text: string): AgentToolResult<undefined> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────────────

interface InboxState {
  count: number;
  watcher: FSWatcher | undefined;
  // Files we've already announced. Tracked in-memory only — if Pi restarts,
  // we re-announce nothing because we seed `seen` from the directory's
  // current contents at watcher start.
  seen: Set<string>;
}

function renderStatus(handle: string, count: number, suffix?: string): string {
  const counter = count > 0 ? ` · 📬 ${count}` : "";
  const autoReact = autoReactEnabled() ? " · auto" : "";
  const tail = suffix ? ` (${suffix})` : "";
  return `postman: ${handle}${counter}${autoReact}${tail}`;
}

/**
 * Spawn `amq watch --me <handle> --json` as a long-running child process.
 *
 * AMQ uses fsnotify under the hood, so this is event-driven (not polling) and
 * cheap at idle. Each new message produces one line of JSON on stdout. We
 * surface a notification + bump the inbox counter in the footer. Inbound
 * messages are NOT injected into the agent's context — the user still has to
 * explicitly call postman_inbox / postman_read to pull them in.
 */
function autoReactEnabled(): boolean {
  const raw = process.env.PI_POSTMAN_AUTO_REACT;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Resolve the AMQ root for the current process. Mirrors AMQ's resolution
 * order: AM_ROOT env > AMQ_GLOBAL_ROOT env > ~/.agent-mail.
 */
function resolveAmqRoot(): string {
  return (
    process.env.AM_ROOT ?? process.env.AMQ_GLOBAL_ROOT ?? join(homedir(), ".agent-mail")
  );
}

/**
 * Parse a maildir message file. Files have the shape:
 *   ---json
 *   { ...header }
 *   ---
 *   body...
 * If parsing fails (file partially written, mid-flight), returns undefined
 * and the caller should retry on the next event.
 */
function parseMaildirFile(path: string): AmqMessageHeader | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const match = text.match(/^---json\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match || !match[1]) return undefined;
  try {
    return JSON.parse(match[1]) as AmqMessageHeader;
  } catch {
    return undefined;
  }
}

/**
 * Watch the maildir `new/` directory directly via fs.watch. We previously
 * tried to subprocess `amq watch --json`, but its real behavior is to dump
 * existing messages once and exit — not a long-running event stream. Watching
 * the directory ourselves is more reliable, has no buffering or version-skew
 * problems, and avoids spawning an extra process per session.
 */
function startWatcher(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  handle: string,
  state: InboxState,
): void {
  if (state.watcher) return;
  const autoReact = autoReactEnabled();
  const root = resolveAmqRoot();
  const newDir = join(root, "agents", handle, "inbox", "new");

  // Seed `seen` with whatever's already in `new/` so we don't notify on
  // historical mail at startup. Future arrivals are everything not in `seen`.
  try {
    for (const entry of readdirSync(newDir)) {
      if (entry.endsWith(".md")) state.seen.add(entry);
    }
  } catch (err) {
    // newDir doesn't exist yet — amq creates it on first send/list. We can
    // still set up the watcher on the parent, but for simplicity just bail
    // and ask the user to send/receive once to materialize the dir.
    ctx.ui.notify(
      `pi-postman: inbox dir ${newDir} not found yet (${(err as Error).message}). Notifications will start once amq creates it.`,
      "info",
    );
    return;
  }

  let watcher: FSWatcher;
  try {
    watcher = fsWatch(newDir, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      if (!filename.endsWith(".md")) return;
      // 'rename' fires for both create and delete on macOS; check existence.
      if (state.seen.has(filename)) return;
      const fullPath = join(newDir, filename);
      const header = parseMaildirFile(fullPath);
      if (!header) {
        // File may not be fully written yet. Retry once after a tick.
        setTimeout(() => {
          if (state.seen.has(filename)) return;
          const retry = parseMaildirFile(fullPath);
          if (retry) handleNewMessage(pi, ctx, handle, state, autoReact, filename, retry);
        }, 50);
        return;
      }
      handleNewMessage(pi, ctx, handle, state, autoReact, filename, header);
    });
  } catch (err) {
    ctx.ui.notify(
      `pi-postman: failed to watch ${newDir}: ${(err as Error).message}`,
      "warning",
    );
    return;
  }

  watcher.on("error", (err: Error) => {
    ctx.ui.notify(`pi-postman watcher error: ${err.message}`, "warning");
  });

  state.watcher = watcher;
}

function handleNewMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  handle: string,
  state: InboxState,
  autoReact: boolean,
  filename: string,
  header: AmqMessageHeader,
): void {
  state.seen.add(filename);

  const from = header.from ?? "unknown";
  const kind = header.kind ?? "message";
  const subject = header.subject ?? "(no subject)";
  const priority = header.priority ?? "normal";
  state.count += 1;
  ctx.ui.setStatus("pi-postman", renderStatus(handle, state.count));
  const notifyType: "info" | "warning" = priority === "urgent" ? "warning" : "info";
  ctx.ui.notify(`📬 ${from} (${kind}): ${subject}`, notifyType);

  if (!autoReact) return;

  // Optional auto-react: feed the agent a user-message describing the arrival
  // so it triggers a turn and can decide to call postman_read.
  const msgId = header.id ?? "(unknown id)";
  const priorityNote = priority === "urgent" ? " [URGENT]" : "";
  const prompt = [
    `📬 New postman message arrived${priorityNote}.`,
    `  from:    ${from}`,
    `  kind:    ${kind}`,
    `  subject: ${subject}`,
    `  id:      ${msgId}`,
    "",
    `Read it with \`postman_read id="${msgId}"\`, then decide whether/how to respond. Auto-react is on; if you reply, preview the body to the user before calling postman_reply.`,
  ].join("\n");
  try {
    // pi.sendUserMessage triggers a turn. deliverAs:"followUp" queues cleanly
    // if a turn is already streaming. The .d.ts declares void; runtime impls
    // sometimes return a Promise. Cast through unknown so we can catch async
    // rejections without a failed inject taking the watcher down.
    const result = pi.sendUserMessage(prompt, {
      deliverAs: "followUp",
    }) as unknown as Promise<void> | void;
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err: Error) => {
        ctx.ui.notify(
          `pi-postman auto-react failed: ${err.message}`,
          "warning",
        );
      });
    }
  } catch (err) {
    ctx.ui.notify(`pi-postman auto-react failed: ${(err as Error).message}`, "warning");
  }
}

function stopWatcher(state: InboxState): void {
  if (state.watcher) state.watcher.close();
  state.watcher = undefined;
  state.seen.clear();
}

export default function (pi: ExtensionAPI) {
  // Stable handle, derived once per session.
  const handle = deriveHandle(process.cwd());
  const inboxState: InboxState = { count: 0, watcher: undefined, seen: new Set() };

  // ----- session lifecycle -----
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const result = await runAmq(pi, ["who", "--json"]);
    if (result.notInstalled) {
      ctx.ui.notify(
        `pi-postman: amq not installed. Tools will return errors until installed.`,
        "warning",
      );
      ctx.ui.setStatus("pi-postman", "amq missing");
      return;
    }
    if (!result.ok) {
      ctx.ui.notify(`pi-postman: amq health check failed (${result.stderr.trim()})`, "warning");
      ctx.ui.setStatus("pi-postman", renderStatus(handle, 0, "degraded"));
      return;
    }
    ctx.ui.setStatus("pi-postman", renderStatus(handle, 0));
    startWatcher(pi, ctx, handle, inboxState);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    stopWatcher(inboxState);
    if (ctx.hasUI) ctx.ui.setStatus("pi-postman", undefined);
  });

  // ----- postman_send -----
  pi.registerTool({
    name: "postman_send",
    label: "Postman: Send",
    description:
      "Send a structured message to another agent session via AMQ. ALWAYS preview the message and ask for explicit user approval before calling this tool. Use for code-review handoffs, cross-session questions, decisions, blockers.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Recipient handle (e.g. 'pi-author', 'codex'). Use postman_sessions to discover available recipients.",
      }),
      kind: Type.Union(
        [
          Type.Literal("review_request"),
          Type.Literal("review_response"),
          Type.Literal("question"),
          Type.Literal("answer"),
          Type.Literal("decision"),
          Type.Literal("status"),
          Type.Literal("todo"),
          Type.Literal("brainstorm"),
        ],
        {
          description:
            "Message kind. Use review_request/review_response for code-review handoffs, question/answer for cross-session questions, decision for choices, status for progress updates, todo for assignments.",
        },
      ),
      subject: Type.String({ description: "One-line scannable subject for the recipient's inbox." }),
      body: Type.String({
        description:
          "Message body in Markdown. Distill the relevant context — do NOT paste the full conversation. Reference files by path rather than embedding their contents.",
      }),
      priority: Type.Optional(
        Type.Union([Type.Literal("urgent"), Type.Literal("normal"), Type.Literal("low")], {
          description:
            "Default: normal. Use 'urgent' only when the recipient should drop their current task. Use 'low' for FYI/status that doesn't need a reply.",
        }),
      ),
      thread: Type.Optional(
        Type.String({
          description:
            "Thread id for multi-turn handoffs. Omit to start a new thread (AMQ auto-generates one for P2P pairs).",
        }),
      ),
      labels: Type.Optional(
        Type.String({
          description: "Comma-separated tags for filtering, e.g. 'pr-review,must-fix'.",
        }),
      ),
    }),
    async execute(_id, params) {
      const args = [
        "send",
        "--me",
        handle,
        "--to",
        params.to,
        "--subject",
        params.subject,
        "--kind",
        params.kind,
        "--body",
        params.body,
      ];
      if (params.priority) args.push("--priority", params.priority);
      if (params.thread) args.push("--thread", params.thread);
      if (params.labels) args.push("--labels", params.labels);

      const result = await runAmq(pi, args);
      if (!result.ok) {
        return toolError(`postman_send failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      const summary = `Sent to ${params.to} (kind=${params.kind}${params.priority ? `, priority=${params.priority}` : ""})`;
      const detail = result.stdout.trim();
      return toolOk(detail ? `${summary}\n${detail}` : summary);
    },
  });

  // ----- postman_inbox -----
  pi.registerTool({
    name: "postman_inbox",
    label: "Postman: Inbox",
    description:
      "List unread postman messages for the current session. Only call when the user explicitly asks (e.g. 'check the inbox', 'any messages?'). Do NOT poll on every turn.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages to return. Default: 20." })),
      from: Type.Optional(Type.String({ description: "Filter by sender handle." })),
      kind: Type.Optional(Type.String({ description: "Filter by message kind." })),
      priority: Type.Optional(
        Type.Union([Type.Literal("urgent"), Type.Literal("normal"), Type.Literal("low")]),
      ),
      include_cur: Type.Optional(
        Type.Boolean({
          description: "If true, also list already-read messages (cur). Default: false (new only).",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = ["list", "--me", handle, "--json"];
      args.push(params.include_cur ? "--cur" : "--new");
      if (params.limit !== undefined) args.push("--limit", String(params.limit));
      if (params.from) args.push("--from", params.from);
      if (params.kind) args.push("--kind", params.kind);
      if (params.priority) args.push("--priority", params.priority);

      const result = await runAmq(pi, args);
      if (!result.ok) {
        return toolError(`postman_inbox failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }

      // Reset the unread counter — the user has now looked at the inbox, so
      // the watcher's "messages arrived since you last looked" tally goes
      // back to zero. Future watcher events will count up from here again.
      if (inboxState.count > 0) {
        inboxState.count = 0;
        if (ctx.hasUI) ctx.ui.setStatus("pi-postman", renderStatus(handle, 0));
      }

      const stdout = result.stdout.trim();
      if (!stdout || stdout === "[]" || stdout === "null") {
        return toolOk("Inbox is empty.");
      }
      // Format JSON list into a scannable summary.
      try {
        const messages = JSON.parse(stdout) as Array<{
          id: string;
          from?: string;
          subject?: string;
          kind?: string;
          priority?: string;
          created?: string;
        }>;
        if (!Array.isArray(messages) || messages.length === 0) return toolOk("Inbox is empty.");
        const lines = messages.map((m) =>
          [
            `• ${m.id}`,
            `  from: ${m.from ?? "?"}`,
            `  subject: ${m.subject ?? "(no subject)"}`,
            `  kind: ${m.kind ?? "?"}` +
              (m.priority ? ` · priority: ${m.priority}` : "") +
              (m.created ? ` · ${m.created}` : ""),
          ].join("\n"),
        );
        return toolOk(`${messages.length} message(s):\n\n${lines.join("\n\n")}`);
      } catch {
        return toolOk(stdout);
      }
    },
  });

  // ----- postman_read -----
  pi.registerTool({
    name: "postman_read",
    label: "Postman: Read",
    description:
      "Read a specific postman message by id. This moves the message from inbox/new to inbox/cur (it's now considered read). Use after postman_inbox surfaces a message id.",
    parameters: Type.Object({
      id: Type.String({ description: "Message id (from postman_inbox)." }),
    }),
    async execute(_id, params) {
      const args = ["read", "--me", handle, "--id", params.id, "--json"];
      const result = await runAmq(pi, args);
      if (!result.ok) {
        return toolError(`postman_read failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      const stdout = result.stdout.trim();
      // `amq read --json` returns { header: {...fields}, body: "..." }.
      // Tolerate the legacy flat shape too in case AMQ ever changes it.
      try {
        const parsed = JSON.parse(stdout) as {
          header?: AmqMessageHeader;
          body?: string;
        } & AmqMessageHeader;
        const header: AmqMessageHeader = parsed.header ?? parsed;
        const body = parsed.body ?? "";
        const headerLines = [
          `id:       ${header.id ?? params.id}`,
          `from:     ${header.from ?? "(unknown)"}`,
          `to:       ${Array.isArray(header.to) ? header.to.join(", ") : (header.to ?? "(unknown)")}`,
          `kind:     ${header.kind ?? "(unknown)"}`,
          header.priority ? `priority: ${header.priority}` : "",
          header.thread ? `thread:   ${header.thread}` : "",
          header.created ? `created:  ${header.created}` : "",
          `subject:  ${header.subject ?? "(no subject)"}`,
        ].filter(Boolean);
        return toolOk(`${headerLines.join("\n")}\n\n${body}`.trimEnd());
      } catch {
        // Show the raw output rather than swallowing — helpful for debugging
        // header-parse failures rather than printing '?' everywhere.
        return toolOk(`(unable to parse amq read JSON; showing raw output)\n\n${stdout}`);
      }
    },
  });

  // ----- postman_reply -----
  pi.registerTool({
    name: "postman_reply",
    label: "Postman: Reply",
    description:
      "Reply to a previously received postman message. Preserves thread continuity. ALWAYS preview the reply and ask for explicit user approval before calling this tool.",
    parameters: Type.Object({
      id: Type.String({ description: "Message id to reply to." }),
      kind: Type.Union([
        Type.Literal("review_response"),
        Type.Literal("answer"),
        Type.Literal("status"),
      ]),
      body: Type.String({ description: "Reply body in Markdown. Be concise; reference files by path." }),
      priority: Type.Optional(
        Type.Union([Type.Literal("urgent"), Type.Literal("normal"), Type.Literal("low")]),
      ),
    }),
    async execute(_id, params) {
      // Try the proper threaded path first.
      const replyArgs = [
        "reply",
        "--me",
        handle,
        "--id",
        params.id,
        "--kind",
        params.kind,
        "--body",
        params.body,
      ];
      if (params.priority) replyArgs.push("--priority", params.priority);

      const replyResult = await runAmq(pi, replyArgs);
      if (replyResult.ok) {
        const detail = replyResult.stdout.trim();
        return toolOk(detail || `Replied to ${params.id} with kind=${params.kind}.`);
      }

      // Detect the known AMQ bug where reply_to is corrupted with the AMQ
      // root directory name (e.g. "pi-tab-a@.agent-mail"). Symptom:
      //   invalid session in reply_to "...@.agent-mail": invalid handle ...
      // When that happens, fall back to a fresh send with the original thread
      // id and 're: ' subject prefix so threading is preserved despite the
      // upstream bug. https://github.com/avivsinai/agent-message-queue
      const stderr = replyResult.stderr.trim();
      const replyToCorrupted =
        /invalid session in reply_to .*: invalid handle/i.test(stderr) ||
        /reply_to/i.test(stderr);
      if (!replyToCorrupted) {
        return toolError(`postman_reply failed: ${stderr || replyResult.stdout.trim()}`);
      }

      // Re-fetch the original to recover from + thread, since reply_to is
      // unusable. amq read --json returns { header: {...}, body: "..." }.
      const fetched = await runAmq(pi, ["read", "--me", handle, "--id", params.id, "--json"]);
      if (!fetched.ok) {
        return toolError(
          `postman_reply: amq reply failed with reply_to bug, and re-fetching the original to fall back also failed: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
        );
      }
      let header: AmqMessageHeader;
      try {
        const parsed = JSON.parse(fetched.stdout.trim()) as {
          header?: AmqMessageHeader;
        } & AmqMessageHeader;
        header = parsed.header ?? parsed;
      } catch {
        return toolError(
          `postman_reply: could not parse original message JSON to fall back. Raw:\n${fetched.stdout.trim()}`,
        );
      }

      const recipient = header.from;
      if (!recipient) {
        return toolError(
          `postman_reply: original message has no \`from\` field; cannot fall back to send.`,
        );
      }
      const subject = header.subject?.toLowerCase().startsWith("re:")
        ? header.subject
        : `re: ${header.subject ?? "(no subject)"}`;

      const sendArgs = [
        "send",
        "--me",
        handle,
        "--to",
        recipient,
        "--subject",
        subject,
        "--kind",
        params.kind,
        "--body",
        params.body,
      ];
      if (header.thread) sendArgs.push("--thread", header.thread);
      if (params.priority) sendArgs.push("--priority", params.priority);

      const sendResult = await runAmq(pi, sendArgs);
      if (!sendResult.ok) {
        return toolError(
          `postman_reply fallback (send) failed after amq reply hit the reply_to bug: ${sendResult.stderr.trim() || sendResult.stdout.trim()}`,
        );
      }
      const detail = sendResult.stdout.trim();
      return toolOk(
        [
          `Replied to ${params.id} via send-fallback (amq reply hit the upstream reply_to handle-parse bug).`,
          header.thread ? `Thread preserved: ${header.thread}` : "No thread on original; reply starts a new one.",
          detail,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  // ----- postman_sessions -----
  pi.registerTool({
    name: "postman_sessions",
    label: "Postman: Sessions",
    description:
      "List active agent sessions known to AMQ on this machine. Call this before postman_send to discover available recipient handles.",
    parameters: Type.Object({}),
    async execute() {
      const result = await runAmq(pi, ["presence", "list", "--json"]);
      if (!result.ok) {
        return toolError(
          `postman_sessions failed: ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const stdout = result.stdout.trim();
      if (!stdout || stdout === "[]" || stdout === "null") {
        return toolOk(
          `No active sessions registered with AMQ.\nThis session: ${handle}\nAsk other agents to set AM_ME and run \`amq presence set --me <handle> --status idle\`.`,
        );
      }
      try {
        const presences = JSON.parse(stdout) as Array<{
          handle?: string;
          agent?: string;
          status?: string;
          note?: string;
          updated?: string;
        }>;
        if (!Array.isArray(presences) || presences.length === 0) {
          return toolOk(`No active sessions. This session: ${handle}`);
        }
        const lines = presences.map((p) => {
          const name = p.handle ?? p.agent ?? "?";
          const isMe = name === handle ? " (this session)" : "";
          const status = p.status ?? "?";
          const note = p.note ? ` — ${p.note}` : "";
          return `• ${name}${isMe}: ${status}${note}`;
        });
        return toolOk(`${presences.length} session(s):\n\n${lines.join("\n")}`);
      } catch {
        return toolOk(stdout);
      }
    },
  });

  // ----- postman_thread -----
  pi.registerTool({
    name: "postman_thread",
    label: "Postman: Thread",
    description:
      "Show all messages in a thread. Useful when following a multi-turn handoff or cross-session decision.",
    parameters: Type.Object({
      id: Type.String({ description: "Thread id (from postman_inbox or postman_read output)." }),
      limit: Type.Optional(Type.Number({ description: "Max messages. Default: 50." })),
      include_body: Type.Optional(
        Type.Boolean({ description: "Include message bodies. Default: true." }),
      ),
    }),
    async execute(_id, params) {
      const args = ["thread", "--id", params.id, "--json"];
      if (params.limit !== undefined) args.push("--limit", String(params.limit));
      if (params.include_body !== false) args.push("--include-body");

      const result = await runAmq(pi, args);
      if (!result.ok) {
        return toolError(`postman_thread failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return toolOk(result.stdout.trim() || "(empty thread)");
    },
  });
}
