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
    event?.data?.sessionID,
    event?.data?.sessionId,
    event?.aggregateID,
    event?.sessionID,
    event?.sessionId,
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

export function isTerminalSessionEvent(event: any): boolean {
  const eventType = event?.type;
  const status = getEventLifecycleStatus(event);

  if (
    eventType === "sync" &&
    (event?.name === "session.deleted.1" ||
      (event?.name === "session.updated.1" &&
        ["idle", "completed", "error", "deleted"].includes(status)))
  ) {
    return true;
  }

  if (["session.idle", "session.error", "session.deleted"].includes(eventType)) {
    return true;
  }

  return eventType === "session.status" && ["idle", "completed", "error", "deleted"].includes(status);
}

const raw = process.env.DYNAMIC_TASK_MAX_CONCURRENT;
const parsed = Number(raw);
export const MAX_CONCURRENT_TASKS = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
