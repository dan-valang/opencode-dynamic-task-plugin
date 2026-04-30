// src/shared/task-policy.ts
// Pure policy functions for agent validation, lineage tracking, and async-default resolution.
// No OpenCode client calls, no task-map mutation, no environment reads.
// All config is passed in via the DynamicTaskConfig parameter.

import type { DynamicTaskConfig } from "./config.js";

// ─── PolicyResult ──────────────────────────────────────────────────

export type PolicyResult =
  | { ok: true }
  | { ok: false; error: string };

// ─── normalizeAgentName ────────────────────────────────────────────
// Normalizes agent name: lowercases, strips @ prefix, trims whitespace.
// Returns null for invalid/empty values.

export function normalizeAgentName(agentName: unknown): string | null {
  if (typeof agentName !== "string") return null;
  const trimmed = agentName.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Strip leading @
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

// ─── validateAgent ─────────────────────────────────────────────────
// Checks if an agent is in the blocked list. Returns ok:false with message if blocked.

export function validateAgent(agentName: unknown, config: DynamicTaskConfig): PolicyResult {
  const name = normalizeAgentName(agentName);
  if (!name) {
    return { ok: false, error: "Invalid agent name: must be a non-empty string." };
  }

  for (const blocked of config.blockedAgents) {
    const normalizedBlocked = normalizeAgentName(blocked);
    if (normalizedBlocked && normalizedBlocked === name) {
      return {
        ok: false,
        error: `Agent "${agentName}" is blocked by this plugin's configuration. ` +
          `Blocked agents: ${config.blockedAgents.join(", ")}. ` +
          "Use a different subagent or update the blockedAgents config.",
      };
    }
  }

  return { ok: true };
}

// ─── isSameAgent ───────────────────────────────────────────────────
// Checks if parent and child agent names refer to the same agent.
// Normalizes both names before comparison.

export function isSameAgent(parentAgent: unknown, childAgent: unknown): boolean {
  const parentNormalized = normalizeAgentName(parentAgent);
  const childNormalized = normalizeAgentName(childAgent);
  if (!parentNormalized || !childNormalized) return false;
  return parentNormalized === childNormalized;
}

// ─── validateLineage ───────────────────────────────────────────────
// Checks if a new child agent would violate lineage rules:
// 1. Same-agent recursion anywhere in lineage → block (absolute)
// 2. Next depth exceeds maxDepth → block
// Does NOT mutate the lineage array.

export function validateLineage(
  lineage: string[],
  childAgent: string,
  config: DynamicTaskConfig,
): PolicyResult {
  const childName = normalizeAgentName(childAgent);
  if (!childName) {
    return { ok: false, error: "Invalid child agent name." };
  }

  // Rule 1: Same-agent recursion check (absolute — runs before depth check)
  for (const ancestor of lineage) {
    if (isSameAgent(ancestor, childName)) {
      return {
        ok: false,
        error: `Recursive delegation blocked: agent "${childAgent}" ` +
          `is already present in the task lineage. ` +
          "Same-agent delegation is not allowed at any depth.",
      };
    }
  }

  // Rule 2: Depth check (applies to different-agent chains only)
  if (config.maxDepth >= 0 && lineage.length >= config.maxDepth) {
    return {
      ok: false,
      error: `Max delegation depth (${config.maxDepth}) exceeded. ` +
        `Current lineage: [${lineage.join(", ")}]. ` +
        "Increase maxDepth in config or delegate to a shorter chain.",
    };
  }

  return { ok: true };
}

// ─── buildTaskLineage ──────────────────────────────────────────────
// Appends the child agent to the parent's lineage for the new session.
// Returns a NEW array — does not mutate the input.

export function buildTaskLineage(parentLineage: string[], childAgent: string): string[] {
  return [...parentLineage, childAgent];
}

// ─── resolveAwaitResponse ─────────────────────────────────────────
// Determines whether a tool call should await synchronously.
// Falls back to config.defaultAwaitResponse when not explicitly set.

export function resolveAwaitResponse(
  value: unknown,
  config: DynamicTaskConfig,
): boolean {
  if (typeof value === "boolean") return value;
  // value is null, undefined, or non-boolean → use config default
  return config.defaultAwaitResponse;
}
