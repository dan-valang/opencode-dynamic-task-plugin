// Dynamic Task Plugin - async subagent orchestration with parent notifications
// Location: ~/.config/opencode/plugins/dynamic-task.ts (auto-scanned)
// Docs: https://opencode.ai/docs/plugins

import { tool } from "@opencode-ai/plugin";
import {
  normalizeStatus,
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,
  MAX_CONCURRENT_TASKS,
} from "./shared/session-lifecycle.js";
import {
  buildBackgroundPrompt,
  formatParentNotification,
  formatTaskResultSummary,
} from "./shared/task-formatting.js";
import { debugLog } from "./debug-logger.js";

interface Agent {
  name: string;
  description?: string;
  mode?: string;
  type?: string;
  [key: string]: any;
}

interface BackgroundTaskState {
  childSessionId: string;
  parentSessionId: string;
  description: string;
  agentName: string;
  timeoutMs: number;
  startedAt: number;
  timeoutNotified: boolean;
  completed: boolean;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

let cachedAgents: Agent[] = [];
let lastCacheTime = 0;

const CACHE_TTL = parseInt(process.env.DYNAMIC_TASK_CACHE_TTL || "300000", 10);
const POLL_INTERVAL = 3000;
const DEFAULT_WAIT_MS = parseInt(process.env.DYNAMIC_TASK_TIMEOUT || "120000", 10);
const backgroundTasks = new Map<string, BackgroundTaskState>();

function resolveParentSessionId(ctx: any): string | null {
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

function validateSessionResult(result: any): string | null {
  if (!result) return null;
  if (typeof result.id === "string") return result.id;
  if (result.body && typeof result.body.id === "string") return result.body.id;
  if (result.data && typeof result.data.id === "string") return result.data.id;
  return null;
}

function buildAgentList(agents: Agent[]): string {
  if (agents.length === 0) return "(none discovered)";
  return agents.map((a) => a.name).join(", ");
}

function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

function extractSessionStatus(sessionInfo: any): string {
  const candidates = [
    sessionInfo?.status,
    sessionInfo?.body?.status,
    sessionInfo?.data?.status,
    sessionInfo?.data?.info?.status,
    sessionInfo?.info?.status,
    sessionInfo?.body?.info?.status,
  ];
  for (const c of candidates) {
    const normalized = normalizeStatus(c);
    if (normalized) return normalized;
  }
  // Log full response shape when status can't be determined — helps debug API shape
  if (sessionInfo) {
    const shape = JSON.stringify(sessionInfo, null, 2).slice(0, 500);
    debugLog("status-debug", "status-debug", "unknown-status-shape", { shape });
  }
  return "unknown";
}

function extractMessages(result: any): any[] {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.body?.messages)) return result.body.messages;
  return [];
}

function getLatestAssistantText(messages: any[], startIndex: number = 0): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const from = Math.max(0, startIndex);

  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    const role = msg?.info?.role || msg?.role;
    if (role !== "assistant") continue;

    const text = extractTextFromParts(msg?.parts || []);
    if (text.trim()) return text;
  }

  return "";
}

function truncateText(text: string, maxChars: number = 1200): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

// unused, kept for compatibility with any external callers
async function readSessionMessages(client: any, sessionId: string): Promise<any[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionId } });
  return extractMessages(messagesResult);
}

async function getMessageCount(client: any, sessionId: string): Promise<number> {
  try {
    const messages = await readSessionMessages(client, sessionId);
    return messages.length;
  } catch {
    return 0;
  }
}

async function fetchAgents(client: any): Promise<Agent[]> {
  const now = Date.now();
  if (now - lastCacheTime < CACHE_TTL && cachedAgents.length > 0) {
    return cachedAgents;
  }

  try {
    const result = await client.app.agents();
    let agents: Agent[] = [];

    if (Array.isArray(result)) {
      agents = result;
    } else if (result && typeof result === "object") {
      agents = result.agents || result.data || Object.values(result);
    }

    cachedAgents = agents.filter((a) => {
      const mode = a.mode || a.type || "all";
      return mode === "subagent";
    });

    lastCacheTime = now;
  } catch (e: any) {
    await client.app.log({
      body: {
        service: "dynamic-task",
        level: "warn",
        message: `Failed to fetch agents: ${e.message}`,
      },
    });
  }

  return cachedAgents;
}

async function pollForResponse(
  client: any,
  sessionId: string,
  maxWaitMs: number,
  startIndex: number = 0,
  checkInterval: number = POLL_INTERVAL
): Promise<string> {
  const started = Date.now();
  let pollErrors = 0;

  while (Date.now() - started < maxWaitMs) {
    try {
      const messages = await readSessionMessages(client, sessionId);
      const latest = getLatestAssistantText(messages, startIndex);
      if (latest.trim()) return latest;

      const sessionInfo = await client.session.get({ path: { id: sessionId } });
      const status = extractSessionStatus(sessionInfo);

      if (status === "idle" || status === "completed" || status === "error") {
        const finalMessages = await readSessionMessages(client, sessionId);
        const finalText = getLatestAssistantText(finalMessages, startIndex);
        if (finalText.trim()) return finalText;
        return "(Subagent completed with no new text output)";
      }
    } catch (e: any) {
      pollErrors += 1;
      if (pollErrors >= 5) {
        return `(Error polling session: ${e.message})`;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  return `(Timed out after ${maxWaitMs / 1000}s. Session: ${sessionId})`;
}



async function notifyParentSession(client: any, parentSessionId: string, message: string): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: parentSessionId },
      body: { parts: [{ type: "text", text: message }] },
    });
  } catch (e: any) {
    await client.app.log({
      body: {
        service: "dynamic-task",
        level: "warn",
        message: `Failed parent notification to ${parentSessionId}: ${e.message}`,
      },
    });
  }
}

function registerBackgroundTask(client: any, state: BackgroundTaskState): void {
  if (backgroundTasks.size >= MAX_CONCURRENT_TASKS) {
    throw new Error(
      `Cannot register more than ${MAX_CONCURRENT_TASKS} concurrent background tasks ` +
      `(current: ${backgroundTasks.size}). Set DYNAMIC_TASK_MAX_CONCURRENT to increase.`
    );
  }

  const existing = backgroundTasks.get(state.childSessionId);
  if (existing?.timeoutHandle) clearTimeout(existing.timeoutHandle);

  state.timeoutHandle = setTimeout(async () => {
    const active = backgroundTasks.get(state.childSessionId);
    if (!active || active.timeoutNotified) return;

    active.timeoutNotified = true;
    const timeoutMessage = formatParentNotification(active, "timeout");
    await notifyParentSession(client, active.parentSessionId, timeoutMessage);
    backgroundTasks.delete(state.childSessionId);

    debugLog(active.parentSessionId, active.childSessionId, "timeout-fired", {
      timeoutMs: active.timeoutMs,
      timeoutNotified: active.timeoutNotified,
    });
  }, state.timeoutMs);

  backgroundTasks.set(state.childSessionId, state);
}

async function handleChildLifecycleEvent(client: any, event: any): Promise<void> {
  if (!isTerminalSessionEvent(event)) return;

  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  const tracked = backgroundTasks.get(childSessionId);
  if (!tracked) return;
  if (tracked.completed) return; // already notified, prevent duplicate
  tracked.completed = true;

  if (tracked.timeoutHandle) {
    clearTimeout(tracked.timeoutHandle);
    tracked.timeoutHandle = null;
  }

  const status = getEventLifecycleStatus(event);
  const eventType = event?.type;

  const eventMessages = Array.isArray(event?.properties?.messages) ? event.properties.messages : [];
  let latestText = getLatestAssistantText(eventMessages, 0);
  if (!latestText) {
    try {
      const sessionMessages = await readSessionMessages(client, childSessionId);
      latestText = getLatestAssistantText(sessionMessages, 0);
    } catch {
      latestText = "";
    }
  }

  let kind: "timeout" | "completed" | "completed_after_timeout" | "error" = "completed";
  if (eventType === "session.error" || status === "error") {
    kind = "error";
  } else if (tracked.timeoutNotified) {
    kind = "completed_after_timeout";
  }

  debugLog(tracked.parentSessionId, childSessionId, "child-lifecycle-event", {
    eventType,
    status,
    kind,
    timeoutNotified: tracked.timeoutNotified,
  });

  const parentMessage = formatParentNotification(tracked, kind, latestText);
  await notifyParentSession(client, tracked.parentSessionId, parentMessage);
  backgroundTasks.delete(childSessionId);
}

export default async function dynamicTaskPlugin({
  client,
  directory,
}: {
  client: any;
  directory: string;
}) {
  if (!client?.app?.agents || !client?.session?.create || !client?.session?.prompt) {
    await client.app.log({
      body: {
        service: "dynamic-task",
        level: "warn",
        message: "Missing required client APIs, plugin disabled",
      },
    });
    return {};
  }

  await client.app.log({
    body: {
      service: "dynamic-task",
      level: "info",
      message:
        "Plugin loaded with dynamic_task, task_continue, task_result, and task_interrupt tools",
    },
  });

  return {
    event: async ({ event }: any) => {
      // Always-on diagnostic: log every event via client.app.log
      const eventType = event?.type;
      const eventName = event?.name;
      const evtSessionId = getSessionIdFromEvent(event);
      const evtStatus = getEventLifecycleStatus(event);
      const topKeys = event ? Object.keys(event).slice(0, 8).join(",") : "(null)";

      await client.app.log({
        body: {
          service: "dynamic-task",
          level: "info",
          message: `event: type=${eventType} name=${eventName} sid=${evtSessionId} status=${evtStatus} keys=[${topKeys}]`,
        },
      });

      debugLog("event-handler", "event-handler", "event-received", {
        type: eventType,
        name: eventName,
        sessionId: evtSessionId,
        status: evtStatus,
      });

      try {
        await handleChildLifecycleEvent(client, event);
      } catch (e: any) {
        await client.app.log({
          body: {
            service: "dynamic-task",
            level: "warn",
            message: `event handler error: ${e?.message}`,
          },
        });
        debugLog("event-handler", "event-handler", "event-handler-error", {
          error: e?.message,
        });
      }
    },

    tool: {
      dynamic_task: tool({
        description:
          "Spawn a subagent task. Set await_response=false to run in background with async parent notifications.",
        args: {
          description: tool.schema.string().describe("Brief task description"),
          subagent_type: tool.schema.string().describe("Subagent name to invoke"),
          prompt: tool.schema.string().describe("Instructions for the child session"),
          await_response: tool.schema
            .boolean()
            .optional()
            .describe("If true (default), wait for response. If false, return immediately."),
          timeout_ms: tool.schema
            .number()
            .optional()
            .describe("Max wait in ms for awaiting mode or timeout notification in background mode."),
        },
        async execute(args: any, ctx: any) {
          const agents = await fetchAgents(client);
          const requestedName = args.subagent_type?.toLowerCase()?.trim();

          if (!requestedName) {
            return `ERROR: No subagent_type provided.\n\nAvailable: ${buildAgentList(agents)}`;
          }

          const agent = agents.find((a) => a.name.toLowerCase() === requestedName);
          if (!agent) {
            return `ERROR: Agent "${args.subagent_type}" not found.\n\nAvailable: ${buildAgentList(agents)}`;
          }

          if (!args.prompt || typeof args.prompt !== "string") {
            return "ERROR: Invalid prompt. Must be a non-empty string.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars). Max: 100000.`;
          }

          const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : DEFAULT_WAIT_MS;
          const shouldAwait = args.await_response !== false;

          try {
            const sessionBody: any = {
              title: args.description || `Task: ${agent.name}`,
              agent: agent.name,
            };

            const parentSessionId = resolveParentSessionId(ctx);
            if (parentSessionId) {
              sessionBody.parentID = parentSessionId;
            }

            const sessionResult = await client.session.create({
              body: sessionBody,
              query: { directory: directory || ctx.directory },
            });

            const childSessionId = validateSessionResult(sessionResult);
            if (!childSessionId) {
              return `ERROR: Failed to create session. Response: ${JSON.stringify(sessionResult)}`;
            }

            const baselineCount = await getMessageCount(client, childSessionId);
            const childPrompt = shouldAwait ? args.prompt : buildBackgroundPrompt(args.prompt);
            await client.session.prompt({
              path: { id: childSessionId },
              body: { parts: [{ type: "text", text: childPrompt }] },
            });

            if (!shouldAwait) {
              if (parentSessionId) {
                registerBackgroundTask(client, {
                  childSessionId,
                  parentSessionId,
                  description: args.description || `Task: ${agent.name}`,
                  agentName: agent.name,
                  timeoutMs,
                  startedAt: Date.now(),
                  timeoutNotified: false,
                  completed: false,
                  timeoutHandle: null,
                });

                debugLog(parentSessionId, childSessionId, "background-task-registered", {
                  timeoutMs,
                  description: args.description || `Task: ${agent.name}`,
                  shouldAwait: false,
                });

                return [
                  `Spawned @${agent.name} in background.`,
                  `Session: ${childSessionId}`,
                  `Async notification: enabled (parent ${parentSessionId})`,
                  "Use task_result(session_id=...) to inspect progress while it runs.",
                ].join("\n");
              }

              return [
                `Spawned @${agent.name} in background.`,
                `Session: ${childSessionId}`,
                "Async notification: disabled (parent session ID not available in tool context)",
              ].join("\n");
            }

            const response = await pollForResponse(client, childSessionId, timeoutMs, baselineCount);
            return `## @${agent.name} Response\n\n${response}\n\n---\n*Session: ${childSessionId}*`;
          } catch (error: any) {
            if (error.message?.includes("not found")) {
              return `ERROR: Agent "${agent.name}" not found.`;
            }
            if (error.message?.includes("permission") || error.message?.includes("denied")) {
              return "ERROR: Permission denied.";
            }
            return `ERROR: ${error.message}`;
          }
        },
      }),

      task_continue: tool({
        description: "Send a follow-up prompt to a child session and wait for its new response.",
        args: {
          session_id: tool.schema.string(),
          prompt: tool.schema.string(),
          timeout_ms: tool.schema.number().optional().describe("Default: 120000"),
        },
        async execute(args: any) {
          if (!args.session_id || !args.prompt) {
            return "ERROR: session_id and prompt are required.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars).`;
          }

          const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : DEFAULT_WAIT_MS;

          try {
            const baselineCount = await getMessageCount(client, args.session_id);
            await client.session.prompt({
              path: { id: args.session_id },
              body: { parts: [{ type: "text", text: args.prompt }] },
            });

            const response = await pollForResponse(client, args.session_id, timeoutMs, baselineCount);
            return `## Follow-up Response\n\n${response}\n\n---\n*Session: ${args.session_id}*`;
          } catch (error: any) {
            if (error.message?.includes("not found")) {
              return `ERROR: Session "${args.session_id}" not found.`;
            }
            return `ERROR: ${error.message}`;
          }
        },
      }),

      task_result: tool({
        description: "Fetch latest known child session result/status without sending a new prompt.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args: any) {
          if (!args.session_id) {
            return "ERROR: session_id is required.";
          }

          try {
            const sessionInfo = await client.session.get({ path: { id: args.session_id } });
            const status = extractSessionStatus(sessionInfo);

            // Always-on diagnostic: log raw sessionInfo structure
            const infoKeys = sessionInfo ? Object.keys(sessionInfo).slice(0, 8).join(",") : "(null)";
            const bodyKeys = sessionInfo?.body ? Object.keys(sessionInfo.body).slice(0, 8).join(",") : "(none)";
            await client.app.log({
              body: {
                service: "dynamic-task",
                level: "info",
                message: `task_result: sid=${args.session_id} status=${status} info.keys=[${infoKeys}] body.keys=[${bodyKeys}] raw.status=${JSON.stringify(sessionInfo?.status)} raw.body.status=${JSON.stringify(sessionInfo?.body?.status)}`,
              },
            });
            const messages = await readSessionMessages(client, args.session_id);
            const latest = getLatestAssistantText(messages, 0) || "(No assistant text found)";
            const tracked = backgroundTasks.get(args.session_id);

            // Safety net: if session is done but background task still has a pending timeout,
            // cancel the timeout and clean up. This catches cases where the event handler
            // missed the completion event.
            if (tracked && !tracked.timeoutNotified && !tracked.completed && ["idle", "completed", "error"].includes(status)) {
              if (tracked.timeoutHandle) {
                clearTimeout(tracked.timeoutHandle);
                tracked.timeoutHandle = null;
              }
              tracked.completed = true;
              debugLog(tracked.parentSessionId, args.session_id, "safety-net-cleanup", {
                status,
                source: "task_result",
              });
              backgroundTasks.delete(args.session_id);
            }

            // Fallback safety net: if status is "unknown" but the session has meaningful
            // assistant output and is tracked, cancel the timeout anyway. The task clearly
            // completed — we just can't determine the exact status field.
            if (tracked && !tracked.timeoutNotified && !tracked.completed && status === "unknown" && latest.trim() && latest !== "(No assistant text found)" && messages.length >= 2) {
              if (tracked.timeoutHandle) {
                clearTimeout(tracked.timeoutHandle);
                tracked.timeoutHandle = null;
              }
              tracked.completed = true;
              debugLog(tracked.parentSessionId, args.session_id, "safety-net-fallback", {
                status,
                messageCount: messages.length,
                hasOutput: true,
                source: "task_result",
              });
              backgroundTasks.delete(args.session_id);
            }

            return formatTaskResultSummary({
              sessionId: args.session_id,
              status,
              messageCount: messages.length,
              latestText: latest,
              tracked: Boolean(tracked),
              timeoutNotified: Boolean(tracked?.timeoutNotified),
            });
          } catch (error: any) {
            if (error.message?.includes("not found")) {
              return `ERROR: Session "${args.session_id}" not found.`;
            }
            return `ERROR: ${error.message}`;
          }
        },
      }),

      task_interrupt: tool({
        description: "Interrupt/abort a running child session.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args: any) {
          if (!args.session_id) {
            return "ERROR: session_id is required.";
          }

          try {
            await client.session.abort({ path: { id: args.session_id } });
            return `Session ${args.session_id} interrupted.`;
          } catch (error: any) {
            if (error.message?.includes("not found")) {
              return `ERROR: Session "${args.session_id}" not found.`;
            }
            return `ERROR: ${error.message}`;
          }
        },
      }),
    },
  };
}
