import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEBUG_DIR = ".dynamic-task-logs";
const DEFAULT_DEBUG_BLOCKLIST = (process.env.DYNAMIC_TASK_DEBUG_BLOCKLIST ?? "prompt,fullPrompt").split(",").slice(0, 4);
const MAX_DEBUG_FIELDS = 4;

export function getDebugLogPath(parentSessionId: string, childSessionId: string): string {
  // Sanitize to prevent path traversal via malicious session IDs
  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DEBUG_DIR, `parent-${sanitize(parentSessionId)}__child-${sanitize(childSessionId)}.log`);
}

export function safeDebugPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const blocklist = DEFAULT_DEBUG_BLOCKLIST;
  const clone: Record<string, unknown> = {};
  const keys = Object.keys(payload).slice(0, MAX_DEBUG_FIELDS);
  for (const key of keys) {
    if (!blocklist.includes(key)) {
      clone[key] = payload[key];
    }
  }
  return clone;
}

export function debugLog(parentSessionId: string, childSessionId: string, eventName: string, payload: Record<string, unknown> = {}): void {
  if (process.env.DYNAMIC_TASK_DEBUG !== "1") return;
  mkdirSync(DEBUG_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    eventName,
    ...safeDebugPayload(payload),
  });
  appendFileSync(getDebugLogPath(parentSessionId, childSessionId), `${line}\n`, "utf8");
}
