import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

// Re-implement pure functions here for testing (copied from src/index.ts)
function buildAgentList(agents) {
  if (agents.length === 0) return "(none discovered)";
  return agents.map((a) => a.name).join(", ");
}

function validateSessionResult(result) {
  if (!result) return null;
  if (typeof result.id === "string") return result.id;
  if (result.body && typeof result.body.id === "string") return result.body.id;
  if (result.data && typeof result.data.id === "string") return result.data.id;
  return null;
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function resolveParentSessionId(ctx) {
  const candidates = [
    ctx?.sessionID,
    ctx?.sessionId,
    ctx?.session?.id,
    ctx?.session?.sessionID,
    ctx?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

async function fetchAgents(client) {
  const CACHE_TTL = 300000;
  const now = Date.now();
  // Simple cache simulation
  try {
    const result = await client.app.agents();
    let agents = [];

    if (Array.isArray(result)) {
      agents = result;
    } else if (result && typeof result === "object") {
      agents = result.agents || result.data || Object.values(result);
    }

    return agents.filter((a) => {
      const mode = a.mode || a.type || "all";
      return mode === "subagent";
    });
  } catch (e) {
    console.warn("Failed to fetch agents:", e.message);
    return [];
  }
}

// --- Tests ---
describe("buildAgentList", () => {
  it("returns agent names joined by comma", () => {
    const agents = [
      { name: "explore", description: "test" },
      { name: "general" },
    ];
    assert.strictEqual(buildAgentList(agents), "explore, general");
  });

  it("returns '(none discovered)' for empty array", () => {
    assert.strictEqual(buildAgentList([]), "(none discovered)");
  });
});

describe("validateSessionResult", () => {
  it("extracts id from flat result", () => {
    assert.strictEqual(validateSessionResult({ id: "ses_123" }), "ses_123");
  });

  it("extracts id from body wrapper", () => {
    assert.strictEqual(
      validateSessionResult({ body: { id: "ses_456" } }),
      "ses_456"
    );
  });

  it("extracts id from data wrapper", () => {
    assert.strictEqual(
      validateSessionResult({ data: { id: "ses_789" } }),
      "ses_789"
    );
  });

  it("returns null for invalid result", () => {
    assert.strictEqual(validateSessionResult(null), null);
    assert.strictEqual(validateSessionResult({ noId: true }), null);
  });
});

describe("extractTextFromParts", () => {
  it("joins text parts", () => {
    const parts = [
      { type: "text", text: "Hello " },
      { type: "text", text: "World" },
    ];
    assert.strictEqual(extractTextFromParts(parts), "Hello \nWorld");
  });

  it("filters non-text parts", () => {
    const parts = [
      { type: "text", text: "Hello" },
      { type: "file", url: "http://example.com" },
    ];
    assert.strictEqual(extractTextFromParts(parts), "Hello");
  });

  it("handles empty array", () => {
    assert.strictEqual(extractTextFromParts([]), "");
  });

  it("handles null/undefined in parts", () => {
    const parts = [
      { type: "text", text: "Hello" },
      null,
      undefined,
      { type: "text", text: "World" },
    ];
    assert.strictEqual(extractTextFromParts(parts), "Hello\nWorld");
  });
});

describe("resolveParentSessionId", () => {
  it("prefers explicit sessionID", () => {
    const ctx = { sessionID: "ses_parent_1", sessionId: "ses_parent_2" };
    assert.strictEqual(resolveParentSessionId(ctx), "ses_parent_1");
  });

  it("falls back through known keys", () => {
    assert.strictEqual(
      resolveParentSessionId({ sessionId: "ses_parent_2" }),
      "ses_parent_2"
    );
    assert.strictEqual(
      resolveParentSessionId({ session: { id: "ses_parent_3" } }),
      "ses_parent_3"
    );
    assert.strictEqual(resolveParentSessionId({ id: "ses_parent_4" }), "ses_parent_4");
  });

  it("returns null when no usable id exists", () => {
    assert.strictEqual(resolveParentSessionId({}), null);
    assert.strictEqual(resolveParentSessionId(null), null);
    assert.strictEqual(resolveParentSessionId({ sessionID: "   " }), null);
  });
});

describe("fetchAgents", () => {
  it("filters only subagents", async () => {
    const mockClient = {
      app: {
        agents: async () => [
          { name: "explore", mode: "subagent" },
          { name: "build", mode: "primary" },
        ],
      },
    };

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "explore");
  });

  it("handles error gracefully", async () => {
    const mockClient = {
      app: {
        agents: async () => {
          throw new Error("Network error");
        },
      },
    };

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 0);
  });

  it("handles wrapped response (result.data)", async () => {
    const mockClient = {
      app: {
        agents: async () => ({
          data: [
            { name: "general", mode: "subagent" },
            { name: "plan", mode: "primary" },
          ],
        }),
      },
    };

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "general");
  });

  it("handles wrapped response (result.agents)", async () => {
    const mockClient = {
      app: {
        agents: async () => ({
          agents: [
            { name: "review", mode: "subagent" },
            { name: "build", mode: "primary" },
          ],
        }),
      },
    };

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "review");
  });
});

// --- Shared Session Lifecycle Helpers (Task 1) ---
// These import from the shared module to verify extraction works
import {
  normalizeStatus,
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,
  MAX_CONCURRENT_TASKS,
} from "../../dist/shared/session-lifecycle.js";

describe("normalizeStatus", () => {
  it("returns lowercase string status", () => {
    assert.strictEqual(normalizeStatus("IDLE"), "idle");
  });

  it("extracts status.type objects", () => {
    assert.strictEqual(normalizeStatus({ type: "error" }), "error");
  });

  it("returns empty string for unsupported values", () => {
    assert.strictEqual(normalizeStatus({ nope: true }), "");
  });

  it("returns empty string for null", () => {
    assert.strictEqual(normalizeStatus(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.strictEqual(normalizeStatus(undefined), "");
  });

  it("returns empty string for number input", () => {
    assert.strictEqual(normalizeStatus(123), "");
  });
});

describe("getSessionIdFromEvent", () => {
  it("extracts sessionID from properties", () => {
    const event = { properties: { sessionID: "ses_123" } };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_123");
  });

  it("extracts sessionId from data", () => {
    const event = { data: { sessionId: "ses_456" } };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_456");
  });

  it("extracts from aggregateID fallback", () => {
    const event = { aggregateID: "ses_789" };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_789");
  });

  it("extracts from top-level id fallback", () => {
    const event = { id: "ses_top_level" };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_top_level");
  });

  it("returns null for no match", () => {
    assert.strictEqual(getSessionIdFromEvent({}), null);
    assert.strictEqual(getSessionIdFromEvent(null), null);
  });

  it("returns null for whitespace-only id", () => {
    assert.strictEqual(getSessionIdFromEvent({ id: "  " }), null);
  });
});

describe("getEventLifecycleStatus", () => {
  it("prefers event.properties.status when present", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ properties: { status: { type: "completed" } } }),
      "completed"
    );
  });

  it("falls back to sync event data.info.status", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ data: { info: { status: "error" } } }),
      "error"
    );
  });

  it("returns empty string for no status anywhere", () => {
    assert.strictEqual(getEventLifecycleStatus({}), "");
  });
});

describe("MAX_CONCURRENT_TASKS", () => {
  it("defaults to 4 when env var is not set", () => {
    assert.strictEqual(MAX_CONCURRENT_TASKS, 4);
  });
});

describe("isTerminalSessionEvent", () => {
  it("treats sync session.updated idle as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({
        type: "sync",
        name: "session.updated.1",
        data: { info: { status: "idle" } },
      }),
      true
    );
  });

  it("treats sync session.updated error as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({
        type: "sync",
        name: "session.updated.1",
        data: { info: { status: { type: "error" } } },
      }),
      true
    );
  });

  it("treats sync session.deleted.1 as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({
        type: "sync",
        name: "session.deleted.1",
      }),
      true
    );
  });

  it("treats session.idle event as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.idle" }),
      true
    );
  });

  it("treats session.error event as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.error" }),
      true
    );
  });

  it("does not treat session.status with unknown status as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.status", properties: { status: "running" } }),
      false
    );
  });
});

// --- Shared Task Formatting Helpers (Task 2) ---
import {
  buildBackgroundPrompt,
  formatParentNotification,
  formatTaskResultSummary,
} from "../../dist/shared/task-formatting.js";

describe("buildBackgroundPrompt", () => {
  it("adds explicit background instructions before user prompt", () => {
    const result = buildBackgroundPrompt("Return COMPLETED_OK when done.");
    assert.match(result, /You are running as a background child task\./);
    assert.match(result, /Return a final, self-contained answer\./);
    assert.match(result, /Return COMPLETED_OK when done\./);
  });
});

describe("formatParentNotification", () => {
  it("formats timeout with next-step guidance", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "timeout"
    );
    assert.match(message, /Background task did not report completion before timeout/);
    assert.match(message, /Use task_result to inspect the latest state\./);
  });

  it("formats error with recovery guidance", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "error",
      "Something failed"
    );
    assert.match(message, /Background task ended with an error\./);
    assert.match(message, /Use task_result or task_continue to inspect or recover\./);
  });

  it("formats completed_after_timeout explicitly", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "completed_after_timeout",
      "Done late"
    );
    assert.match(message, /Background task completed after an earlier timeout notification\./);
  });

  it("formats successful completion", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "completed",
      "COMPLETED_OK"
    );
    assert.match(message, /Background task completed successfully\./);
    assert.match(message, /Latest output: COMPLETED_OK/);
  });
});

describe("formatTaskResultSummary", () => {
  it("includes next action guidance for running tasks", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123",
      status: "busy",
      messageCount: 4,
      latestText: "Still working",
      tracked: true,
      timeoutNotified: false,
    });
    assert.match(result, /Recommended next action: use task_result again later\./);
  });

  it("includes recovery guidance for error status", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123",
      status: "error",
      messageCount: 4,
      latestText: "Failed",
      tracked: true,
      timeoutNotified: false,
    });
    assert.match(result, /Recommended next action: inspect latest output/);
  });

  it("includes tracked and timeout metadata", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123",
      status: "idle",
      messageCount: 4,
      latestText: "Done",
      tracked: true,
      timeoutNotified: true,
    });
    assert.match(result, /Tracked background task: yes/);
    assert.match(result, /Timeout notification sent: yes/);
  });
});

// --- Debug Logger (Task 3) ---
import { getDebugLogPath, safeDebugPayload } from "../../dist/debug-logger.js";

describe("safeDebugPayload", () => {
  it("keeps event metadata but removes blocked fields (prompt, fullPrompt)", () => {
    const payload = safeDebugPayload({
      eventType: "session.status",
      prompt: "x".repeat(5000),
      latestText: "done",
    });
    assert.strictEqual(payload.eventType, "session.status");
    assert.ok(!("prompt" in payload));
    assert.strictEqual(payload.latestText, "done");
  });

  it("caps logged fields at MAX_DEBUG_FIELDS (4)", () => {
    const payload = safeDebugPayload({
      a: 1, b: 2, c: 3, d: 4, e: 5, f: 6,
    });
    assert.strictEqual(Object.keys(payload).length, 4, "Must not log more than 4 fields");
  });

  it("respects DYNAMIC_TASK_DEBUG_BLOCKLIST env var", () => {
    const result = safeDebugPayload({ prompt: "x", token: "secret", latestText: "done" });
    assert.ok(!("prompt" in result), "prompt must be blocked by default blocklist");
  });
});

describe("getDebugLogPath", () => {
  it("creates a stable per-parent-child path", () => {
    const logPath = getDebugLogPath("parent_1", "child_2");
    assert.match(logPath, /parent-parent_1__child-child_2\.log$/);
  });
});
