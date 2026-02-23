import type { AgentConfig } from "./types.js";

// ── Should this agent speak this turn? ──────────────────────────────
// Extracted from agents/personality.ts — pure probability check.

export function shouldSpeak(
  agent: AgentConfig,
  lastSpeaker: string | null,
  turnsSinceLast: number,
): boolean {
  const p = agent.personality;

  // Never speak twice in a row
  if (lastSpeaker === p.name) return false;

  // Higher chance if haven't spoken in a while
  const recencyBoost = Math.min(turnsSinceLast * 0.15, 0.4);

  // Base probability from chattiness
  const prob = p.chattiness + recencyBoost;

  return Math.random() < prob;
}

// ── Get candidate speakers ──────────────────────────────────────────
// Extracted from room/room.ts pickSpeaker — returns candidates without
// random selection (the engine picks randomly from the result).

export function getSpeakerCandidates(
  activeAgents: readonly AgentConfig[],
  lastSpeaker: string | null,
  turnsSinceSpoke: ReadonlyMap<string, number>,
): AgentConfig[] {
  const candidates: AgentConfig[] = [];

  for (const agent of activeAgents) {
    const name = agent.personality.name;
    const turns = turnsSinceSpoke.get(name) ?? 2;
    if (shouldSpeak(agent, lastSpeaker, turns)) {
      candidates.push(agent);
    }
  }

  // If nobody volunteered, force the longest-silent agent
  if (candidates.length === 0 && activeAgents.length > 0) {
    const sorted = [...activeAgents]
      .filter(a => a.personality.name !== lastSpeaker)
      .sort((a, b) => {
        const ta = turnsSinceSpoke.get(a.personality.name) ?? 99;
        const tb = turnsSinceSpoke.get(b.personality.name) ?? 99;
        return tb - ta;
      });
    if (sorted.length > 0) candidates.push(sorted[0]);
  }

  return candidates;
}

// ── Peek next speaker (for governed mode preview) ───────────────────
// Mirrors getSpeakerCandidates but uses a simpler heuristic
// (no probability roll — just turns-since-spoke filter).

export function peekNextSpeakerCandidates(
  activeAgents: readonly AgentConfig[],
  lastSpeaker: string | null,
  turnsSinceSpoke: ReadonlyMap<string, number>,
): AgentConfig[] {
  const candidates = activeAgents.filter(a => {
    const turns = turnsSinceSpoke.get(a.personality.name) ?? 2;
    return a.personality.name !== lastSpeaker && turns >= 1;
  });
  if (candidates.length === 0) {
    const fallback = activeAgents.find(a => a.personality.name !== lastSpeaker);
    return fallback ? [fallback] : [];
  }
  return [...candidates];
}
