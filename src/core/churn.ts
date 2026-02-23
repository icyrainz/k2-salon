import type { AgentConfig, RoomConfig } from "./types.js";

// ── Churn decision (what SHOULD happen — engine executes it) ────────

export interface ChurnDecision {
  leave?: { agent: AgentConfig; excuse: string };
  join?: { agent: AgentConfig; greeting: string };
}

// ── Evaluate churn ──────────────────────────────────────────────────
// Extracted from room/room.ts evaluateChurn — returns a decision
// rather than mutating state or emitting events. The engine applies
// the decision and emits the appropriate events.

export function evaluateChurn(
  activeAgents: readonly AgentConfig[],
  benchedAgents: readonly AgentConfig[],
  config: Pick<RoomConfig, "minAgents" | "maxAgents">,
  phrases: { randomLeaveExcuse: () => string; randomJoinGreeting: () => string },
): ChurnDecision {
  const decision: ChurnDecision = {};

  // Evaluate leave
  if (activeAgents.length > config.minAgents) {
    const evictable = activeAgents.filter(a => a.priority === undefined);
    if (evictable.length > 0) {
      const candidate = evictable[Math.floor(Math.random() * evictable.length)];
      if (Math.random() < 0.25 * (1 - candidate.personality.chattiness)) {
        decision.leave = { agent: candidate, excuse: phrases.randomLeaveExcuse() };
      }
    }
  }

  // Evaluate join (only if no one left, or even after — check remaining count)
  const activeAfterLeave = decision.leave
    ? activeAgents.length - 1
    : activeAgents.length;

  if (activeAfterLeave < config.maxAgents && benchedAgents.length > 0) {
    if (Math.random() < 0.3) {
      // Pick a random benched agent (exclude the one who just left, if any)
      const pool = decision.leave
        ? benchedAgents.filter(a => a.personality.name !== decision.leave!.agent.personality.name)
        : [...benchedAgents];
      if (pool.length > 0) {
        const idx = Math.floor(Math.random() * pool.length);
        decision.join = { agent: pool[idx], greeting: phrases.randomJoinGreeting() };
      }
    }
  }

  return decision;
}
