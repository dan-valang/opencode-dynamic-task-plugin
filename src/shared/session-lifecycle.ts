export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.trim().toLowerCase();
  if (raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string") {
    return (raw as { type: string }).type.trim().toLowerCase();
  }
  return "";
}

export function getSessionIdFromEvent(event: any): string | null {
  const candidates = [
    event?.properties?.sessionID,
    event?.properties?.sessionId,
    event?.properties?.id,
    event?.data?.sessionID,
    event?.data?.sessionId,
    event?.data?.id,
    event?.aggregateID,
    event?.sessionID,
    event?.sessionId,
    event?.subject,
    event?.resource?.id,
    event?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  return null;
}

export function getEventLifecycleStatus(event: any): string {
  return (
    normalizeStatus(event?.properties?.status) ||
    normalizeStatus(event?.data?.info?.status) ||
    ""
  );
}

const TERMINAL_STATUSES = ["idle", "completed", "error", "deleted"];

export function isTerminalSessionEvent(event: any): boolean {
  const eventType = event?.type;
  const eventName = event?.name;
  const status = getEventLifecycleStatus(event);

  // Pattern 1: sync events with session.updated/deleted names
  if (eventType === "sync") {
    if (eventName === "session.deleted.1" || eventName === "session.deleted") {
      return true;
    }
    if (
      (eventName === "session.updated.1" || eventName === "session.updated") &&
      TERMINAL_STATUSES.includes(status)
    ) {
      return true;
    }
  }

  // Pattern 2: direct event types (session.idle, session.error, etc.)
  if (TERMINAL_STATUSES.some((s) => eventType === `session.${s}`)) {
    return true;
  }

  // Pattern 3: session.status events with terminal status payload
  if (eventType === "session.status" && TERMINAL_STATUSES.includes(status)) {
    return true;
  }

  // Pattern 4: any event with a terminal status in properties (broad catch-all)
  if (status && TERMINAL_STATUSES.includes(status) && getSessionIdFromEvent(event)) {
    return true;
  }

  return false;
}

const raw = process.env.DYNAMIC_TASK_MAX_CONCURRENT;
const parsed = Number(raw);
export const MAX_CONCURRENT_TASKS = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
