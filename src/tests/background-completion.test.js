/**
 * Integration test for await_response=false background task completion
 *
 * Tests that:
 * 1. Background child task completes quickly with COMPLETED_OK marker
 * 2. Parent receives completion notification (not timeout fallback)
 * 3. Results are consistent across multiple runs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

// Import production helpers instead of copying TypeScript-in-JS
import {
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,
} from "../../dist/shared/session-lifecycle.js";
import {
  formatParentNotification,
  truncateText,
} from "../../dist/shared/task-formatting.js";

/**
 * @typedef {{
 *   childSessionId: string,
 *   parentSessionId: string,
 *   description: string,
 *   agentName: string,
 *   timeoutMs: number,
 *   startedAt: number,
 *   timeoutNotified: boolean,
 *   timeoutHandle: ReturnType<typeof setTimeout> | null,
 * }} BackgroundTaskState
 */

// Simulate the backgroundTasks map
/** @type {Map<string, BackgroundTaskState>} */
const backgroundTasks = new Map();

// Track notifications
/** @type {Array<{ to: string; message: string }>} */
let notifications = [];
let timeoutFired = false;

function createMockClient() {
  notifications = [];
  timeoutFired = false;

  return {
    session: {
      prompt: async ({ path, body }) => {
        notifications.push({
          to: path.id,
          message: body?.parts?.[0]?.text || "",
        });
        return { ok: true };
      },
      messages: async ({ path }) => {
        return [
          {
            role: "assistant",
            parts: [{ type: "text", text: "COMPLETED_OK" }],
          },
        ];
      },
      get: async ({ path }) => {
        return { status: "idle" };
      },
    },
    app: {
      log: async ({ body }) => {
        // console.log("[LOG]", body.level, body.message);
      },
    },
  };
}

// Re-implement registerBackgroundTask (mirrors src/index.ts)
/**
 * @param {any} client
 * @param {BackgroundTaskState} state
 */
function registerBackgroundTask(client, state) {
  const existing = backgroundTasks.get(state.childSessionId);
  if (existing?.timeoutHandle) clearTimeout(existing.timeoutHandle);

  state.timeoutHandle = setTimeout(async () => {
    const active = backgroundTasks.get(state.childSessionId);
    if (!active || active.timeoutNotified) return;

    active.timeoutNotified = true;
    timeoutFired = true;
    const timeoutMessage = formatParentNotification(active, "timeout");
    await client.session.prompt({
      path: { id: active.parentSessionId },
      body: { parts: [{ type: "text", text: timeoutMessage }] },
    });
    backgroundTasks.delete(state.childSessionId);
  }, state.timeoutMs);

  backgroundTasks.set(state.childSessionId, state);
}

// Re-implement handleChildLifecycleEvent (mirrors src/index.ts)
/**
 * @param {any} client
 * @param {any} event
 */
async function handleChildLifecycleEvent(client, event) {
  if (!isTerminalSessionEvent(event)) return;

  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  const tracked = backgroundTasks.get(childSessionId);
  if (!tracked) return;

  if (tracked.timeoutHandle) {
    clearTimeout(tracked.timeoutHandle);
    tracked.timeoutHandle = null;
  }

  const status = getEventLifecycleStatus(event);
  const eventType = event?.type;

  const eventMessages = Array.isArray(event?.properties?.messages) ? event.properties.messages : [];
  let latestText = "";
  if (!latestText) {
    try {
      const sessionMessages = await client.session.messages({ path: { id: childSessionId } });
      latestText = sessionMessages
        .filter((m) => m?.role === "assistant")
        .map((m) => m?.parts?.filter((p) => p?.type === "text")?.map((p) => p.text)?.join("\n"))
        .filter(Boolean)
        .pop() || "";
    } catch {
      latestText = "";
    }
  }

  let kind = "completed";
  if (eventType === "session.error" || status === "error") {
    kind = "error";
  } else if (tracked.timeoutNotified) {
    kind = "completed_after_timeout";
  }

  const parentMessage = formatParentNotification(tracked, kind, latestText);
  await client.session.prompt({
    path: { id: tracked.parentSessionId },
    body: { parts: [{ type: "text", text: parentMessage }] },
  });
  backgroundTasks.delete(childSessionId);
}

// --- TESTS ---

describe("Background Task Completion Notification", () => {
  beforeEach(() => {
    backgroundTasks.clear();
    notifications = [];
    timeoutFired = false;
  });

  it("Run 1: Child completes before timeout - should notify with COMPLETED_OK", async () => {
    const client = createMockClient();
    const parentSessionId = "parent_001";
    const childSessionId = "child_001";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Quick test task",
      agentName: "general",
      timeoutMs: 30000,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    const completionEvent = {
      type: "session.idle",
      properties: {
        sessionID: childSessionId,
        status: "idle",
      },
    };

    await handleChildLifecycleEvent(client, completionEvent);

    assert.strictEqual(timeoutFired, false, "Timeout should NOT have fired");
    assert.strictEqual(notifications.length, 1, "Should have exactly 1 notification");

    const notification = notifications[0];
    assert.strictEqual(notification.to, parentSessionId, "Should notify parent");
    assert.ok(
      notification.message.includes("COMPLETED_OK"),
      `Notification should contain COMPLETED_OK marker. Got: ${notification.message}`
    );
    assert.ok(
      notification.message.includes("Background task completed successfully"),
      `Notification should say "Background task completed successfully". Got: ${notification.message}`
    );
    assert.ok(
      !notification.message.includes("timed out"),
      `Notification should NOT say "timed out". Got: ${notification.message}`
    );

    console.log("✅ Run 1 PASSED");
    console.log("   Notification:", notification.message.substring(0, 100) + "...");
  });

  it("Run 2: Child completes before timeout - should notify with COMPLETED_OK (repeat)", async () => {
    const client = createMockClient();
    const parentSessionId = "parent_002";
    const childSessionId = "child_002";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Quick test task 2",
      agentName: "general",
      timeoutMs: 30000,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    const completionEvent = {
      type: "session.idle",
      properties: {
        sessionID: childSessionId,
        status: "idle",
      },
    };

    await handleChildLifecycleEvent(client, completionEvent);

    assert.strictEqual(timeoutFired, false, "Timeout should NOT have fired");
    assert.strictEqual(notifications.length, 1, "Should have exactly 1 notification");

    const notification = notifications[0];
    assert.ok(
      notification.message.includes("COMPLETED_OK"),
      `Notification should contain COMPLETED_OK marker. Got: ${notification.message}`
    );

    console.log("✅ Run 2 PASSED");
  });

  it("Run 3: Child completes before timeout - should notify with COMPLETED_OK (repeat)", async () => {
    const client = createMockClient();
    const parentSessionId = "parent_003";
    const childSessionId = "child_003";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Quick test task 3",
      agentName: "general",
      timeoutMs: 30000,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    const completionEvent = {
      type: "session.idle",
      properties: {
        sessionID: childSessionId,
        status: "idle",
      },
    };

    await handleChildLifecycleEvent(client, completionEvent);

    assert.strictEqual(timeoutFired, false, "Timeout should NOT have fired");
    assert.strictEqual(notifications.length, 1, "Should have exactly 1 notification");

    const notification = notifications[0];
    assert.ok(
      notification.message.includes("COMPLETED_OK"),
      `Notification should contain COMPLETED_OK marker. Got: ${notification.message}`
    );

    console.log("✅ Run 3 PASSED");
  });

  it("Baseline: Timeout fallback still works when no event received", async () => {
    const client = createMockClient();
    const parentSessionId = "parent_timeout";
    const childSessionId = "child_timeout";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Timeout test task",
      agentName: "general",
      timeoutMs: 100,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(timeoutFired, true, "Timeout should have fired");
    assert.strictEqual(notifications.length, 1, "Should have timeout notification");

    const notification = notifications[0];
    assert.ok(
      notification.message.includes("did not report completion before timeout"),
      `Notification should say "did not report completion before timeout". Got: ${notification.message}`
    );

    console.log("✅ Timeout fallback PASSED");
  });

  it("Event parsing: session.status with idle status should trigger completion", async () => {
    const client = createMockClient();
    const parentSessionId = "parent_status";
    const childSessionId = "child_status";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Status event test",
      agentName: "general",
      timeoutMs: 30000,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    const completionEvent = {
      type: "session.status",
      properties: {
        sessionID: childSessionId,
        status: "idle",
      },
    };

    await handleChildLifecycleEvent(client, completionEvent);

    assert.strictEqual(timeoutFired, false, "Timeout should NOT have fired");
    assert.ok(
      notifications.length === 1 && notifications[0].message.includes("Background task completed successfully"),
      "Should receive completion notification"
    );

    console.log("✅ session.status event PASSED");
  });

  it("Event parsing: sync session.updated with idle status should trigger completion", async () => {
    const client = createMockClient();
    const parentSessionId = "parent_sync";
    const childSessionId = "child_sync";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Sync event test",
      agentName: "general",
      timeoutMs: 30000,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    const completionEvent = {
      type: "sync",
      name: "session.updated.1",
      data: {
        info: {
          status: "idle",
        },
      },
      properties: {
        sessionID: childSessionId,
      },
    };

    await handleChildLifecycleEvent(client, completionEvent);

    assert.strictEqual(timeoutFired, false, "Timeout should NOT have fired");
    assert.ok(
      notifications.length === 1 && notifications[0].message.includes("Background task completed successfully"),
      "Should receive completion notification"
    );

    console.log("✅ sync session.updated event PASSED");
  });

  it("Multiple rapid completions: should each get their own notification", async () => {
    const client = createMockClient();

    const completions = [
      { parent: "p1", child: "c1" },
      { parent: "p2", child: "c2" },
      { parent: "p3", child: "c3" },
    ];

    for (const { parent, child } of completions) {
      registerBackgroundTask(client, {
        childSessionId: child,
        parentSessionId: parent,
        description: `Task ${child}`,
        agentName: "general",
        timeoutMs: 30000,
        startedAt: Date.now(),
        timeoutNotified: false,
        timeoutHandle: null,
      });
    }

    for (const { parent, child } of completions) {
      await handleChildLifecycleEvent(client, {
        type: "session.idle",
        properties: { sessionID: child, status: "idle" },
      });
    }

    assert.strictEqual(timeoutFired, false, "No timeouts should have fired");
    assert.strictEqual(notifications.length, 3, "Should have 3 notifications");

    for (let i = 0; i < 3; i++) {
      assert.ok(
        notifications[i].message.includes(`c${i + 1}`),
        `Notification ${i + 1} should reference correct child session`
      );
    }

    console.log("✅ Multiple rapid completions PASSED");
  });

  // --- Task 4: Runtime regression tests ---

  it("classifies sync session.updated error as error-kind notification", async () => {
    const client = createMockClient();
    const childSessionId = "sync_error_child";
    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId: "sync_err_parent",
      description: "Sync error test",
      agentName: "general",
      timeoutMs: 30000,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    const event = {
      type: "sync",
      name: "session.updated.1",
      data: { info: { status: { type: "error" } } },
      properties: { sessionID: childSessionId },
    };

    await handleChildLifecycleEvent(client, event);

    assert.strictEqual(notifications.length, 1, "Should notify exactly once");
    assert.match(
      notifications[0].message,
      /ended with an error/i,
      "Should be error-kind notification"
    );
    assert.ok(
      !notifications[0].message.includes("completed successfully"),
      "Must NOT be a success notification"
    );

    console.log("✅ Sync error classification PASSED");
  });

  it("removes timed-out tasks from backgroundTasks after notifying", async () => {
    const client = createMockClient();
    const childSessionId = "cleanup_child";
    const parentSessionId = "cleanup_parent";

    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId,
      description: "Cleanup test",
      agentName: "general",
      timeoutMs: 50,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.strictEqual(
      backgroundTasks.has(childSessionId),
      false,
      "backgroundTasks must delete the entry after timeout fires"
    );

    console.log("✅ Timeout cleanup PASSED");
  });

  it("only one notification sent when lifecycle event fires before timeout", async () => {
    const client = createMockClient();
    const childSessionId = "race_child";
    registerBackgroundTask(client, {
      childSessionId,
      parentSessionId: "race_parent",
      description: "Race test",
      agentName: "general",
      timeoutMs: 999999,
      startedAt: Date.now(),
      timeoutNotified: false,
      timeoutHandle: null,
    });

    await handleChildLifecycleEvent(client, {
      type: "session.idle",
      properties: { sessionID: childSessionId, status: "idle" },
    });

    assert.strictEqual(notifications.length, 1, "Only 1 notification (completion), timeout must not also fire");
    assert.match(notifications[0].message, /completed/i);

    console.log("✅ Race condition guard PASSED");
  });

  it("ignores lifecycle event for untracked session", async () => {
    const client = createMockClient();
    const notificationsBefore = notifications.length;

    await handleChildLifecycleEvent(client, {
      type: "session.idle",
      properties: { sessionID: "nonexistent_session", status: "idle" },
    });

    assert.strictEqual(notifications.length, notificationsBefore, "No notification for untracked session");

    console.log("✅ Untracked session ignored PASSED");
  });
});
