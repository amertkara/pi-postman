/**
 * pi-bridge — Pi extension that adapts AMQ for cross-session messaging
 *
 * Status: skeleton. Tools are stubs that show intended shape but do not
 * yet shell out to amq.
 *
 * See ../docs/design.md for architecture decisions.
 */

import { Type } from "@sinclair/typebox";

/**
 * Default extension export. Pi loads this and calls the `register` hook
 * at session start.
 *
 * NOTE: this signature is illustrative and will be aligned with the
 * actual `ExtensionAPI` from packages/coding-agent once we wire it up.
 * The stub avoids importing pi types so this scaffold compiles in
 * isolation.
 */
export default {
  name: "pi-bridge",
  version: "0.0.1",

  async register(api: ExtensionLikeAPI) {
    // TODO: register session with AMQ via `amq coop register` (or equivalent).
    // TODO: kick off a poller that calls `amq list --new` on a configurable
    //       interval and surfaces notifications via api.ui.notify().

    api.registerTool({
      name: "bridge_send",
      description:
        "Send a structured message to another agent session. Always preview the message and ask for user approval before transmitting.",
      parameters: Type.Object({
        to: Type.String({
          description: "Recipient session handle (e.g. 'pi-author', 'codex-review').",
        }),
        kind: Type.String({
          description:
            "Message kind. Conventional values: review_request, review_handoff, question, decision, ack.",
        }),
        subject: Type.String(),
        body: Type.String(),
        priority: Type.Optional(
          Type.Union([Type.Literal("urgent"), Type.Literal("normal"), Type.Literal("low")]),
        ),
        thread: Type.Optional(Type.String({ description: "Thread id for multi-turn handoffs." })),
      }),
      async execute(_toolCallId, _params) {
        // TODO: spawn `amq send --to <to> --kind <kind> --subject <subject> --body <body>`
        return {
          content: [{ type: "text", text: "[stub] bridge_send: not yet wired to amq." }],
        };
      },
    });

    api.registerTool({
      name: "bridge_inbox",
      description:
        "List unread messages for the current session. Use before bridge_read to see what's pending.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number()),
        priority: Type.Optional(Type.String()),
        from: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, _params) {
        return {
          content: [{ type: "text", text: "[stub] bridge_inbox: not yet wired to amq." }],
        };
      },
    });

    api.registerTool({
      name: "bridge_read",
      description:
        "Read a specific message by id and move it from inbox/new to inbox/cur. Use after bridge_inbox.",
      parameters: Type.Object({
        id: Type.String(),
      }),
      async execute(_toolCallId, _params) {
        return {
          content: [{ type: "text", text: "[stub] bridge_read: not yet wired to amq." }],
        };
      },
    });

    api.registerTool({
      name: "bridge_reply",
      description: "Reply to a message in the same thread.",
      parameters: Type.Object({
        id: Type.String({ description: "Message id to reply to." }),
        kind: Type.String(),
        body: Type.String(),
      }),
      async execute(_toolCallId, _params) {
        return {
          content: [{ type: "text", text: "[stub] bridge_reply: not yet wired to amq." }],
        };
      },
    });

    api.registerTool({
      name: "bridge_sessions",
      description: "List active agent sessions known to AMQ on this machine.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        return {
          content: [{ type: "text", text: "[stub] bridge_sessions: not yet wired to amq." }],
        };
      },
    });
  },

  async sessionStart(_ctx: ExtensionLikeContext) {
    // TODO: register with AMQ, derive client_id from Pi session id.
  },

  async sessionShutdown(_ctx: ExtensionLikeContext) {
    // TODO: unregister with AMQ.
  },
};

// ---- Local stand-ins for Pi types (replace with real imports) ----

type ExtensionLikeAPI = {
  registerTool: (tool: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }>;
  }) => void;
};

type ExtensionLikeContext = {
  sessionId: string;
};
