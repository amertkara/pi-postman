/**
 * pi-postman — Pi extension that relays messages between agent sessions via AMQ
 *
 * Wraps `amq` (https://github.com/avivsinai/agent-message-queue) so a Pi
 * session can send structured handoffs to other agent sessions on the same
 * machine. The user is the gate on every transmission; inbound messages
 * are not auto-injected into the receiving agent's context.
 *
 * Configuration via env:
 *   AM_ME           — agent handle for this Pi session (default: `pi-<basename(cwd)>`)
 *   AM_ROOT         — AMQ root (default: AMQ resolves via `.amqrc` / `AMQ_GLOBAL_ROOT` / auto-detect)
 *   PI_POSTMAN_HANDLE — overrides AM_ME for this extension specifically
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { basename } from "node:path";

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

export default function (pi: ExtensionAPI) {
  // Stable handle, derived once per session.
  const handle = deriveHandle(process.cwd());

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
      ctx.ui.setStatus("pi-postman", `postman: ${handle} (degraded)`);
      return;
    }
    ctx.ui.setStatus("pi-postman", `postman: ${handle}`);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    // AMQ has no per-session register/unregister — handles are passed per-command.
    // Just clear our footer status.
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
    async execute(_id, params) {
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
      // Try to format the JSON; fall back to raw output.
      try {
        const msg = JSON.parse(stdout) as {
          id?: string;
          from?: string;
          to?: string[] | string;
          subject?: string;
          kind?: string;
          priority?: string;
          thread?: string;
          created?: string;
          body?: string;
        };
        const headerLines = [
          `id:       ${msg.id ?? params.id}`,
          `from:     ${msg.from ?? "?"}`,
          `to:       ${Array.isArray(msg.to) ? msg.to.join(", ") : (msg.to ?? "?")}`,
          `kind:     ${msg.kind ?? "?"}`,
          msg.priority ? `priority: ${msg.priority}` : "",
          msg.thread ? `thread:   ${msg.thread}` : "",
          msg.created ? `created:  ${msg.created}` : "",
          `subject:  ${msg.subject ?? "(no subject)"}`,
        ].filter(Boolean);
        return toolOk(`${headerLines.join("\n")}\n\n${msg.body ?? ""}`.trimEnd());
      } catch {
        return toolOk(stdout);
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
      const args = [
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
      if (params.priority) args.push("--priority", params.priority);

      const result = await runAmq(pi, args);
      if (!result.ok) {
        return toolError(`postman_reply failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      const detail = result.stdout.trim();
      return toolOk(detail || `Replied to ${params.id} with kind=${params.kind}.`);
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
