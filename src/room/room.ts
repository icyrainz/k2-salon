import type { AgentConfig, RoomConfig, RoomMessage } from "../types.js";
import { complete } from "../providers/provider.js";
import { buildMessages, shouldSpeak } from "../agents/personality.js";
import { randomJoinGreeting, randomLeaveExcuse } from "../agents/roster.js";

// ── Room state ──────────────────────────────────────────────────────

export interface RoomState {
  config: RoomConfig;
  history: RoomMessage[];
  activeAgents: AgentConfig[];
  benchedAgents: AgentConfig[];
  turnCount: number;
  lastSpeaker: string | null;
  turnsSinceSpoke: Map<string, number>;
  running: boolean;
  abortController: AbortController;
  governed: boolean;
}

// ── Callbacks (streaming only — no polling) ─────────────────────────

export interface RoomCallbacks {
  onMessage: (msg: RoomMessage) => void;
  onStreamToken: (agent: string, token: string) => void;
  onStreamDone: (agent: string) => void;
}

// ── Create room ─────────────────────────────────────────────────────

export function createRoom(
  config: RoomConfig,
  allAgents: AgentConfig[],
  preloadedHistory?: RoomMessage[],
): RoomState {
  const shuffled = [...allAgents].sort(() => Math.random() - 0.5);
  const initialCount = Math.min(
    config.maxAgents,
    Math.max(config.minAgents, Math.floor(allAgents.length * 0.5)),
  );
  const active = shuffled.slice(0, initialCount);
  const benched = shuffled.slice(initialCount);

  return {
    config,
    history: preloadedHistory ? [...preloadedHistory] : [],
    activeAgents: active,
    benchedAgents: benched,
    turnCount: 0,
    lastSpeaker: null,
    turnsSinceSpoke: new Map(),
    running: false,
    abortController: new AbortController(),
    governed: true,
  };
}

// ── Stop room ───────────────────────────────────────────────────────

export function stopRoom(state: RoomState): void {
  state.running = false;
  state.abortController.abort();
}

// ── Open room: emit topic + join messages ───────────────────────────
// Call once before the first stepRoom(). Returns the messages emitted.

export function openRoom(state: RoomState, cb: RoomCallbacks): void {
  state.running = true;

  const openMsg: RoomMessage = {
    timestamp: new Date(),
    agent: "SYSTEM",
    content: `Topic: "${state.config.topic}"`,
    color: "\x1b[90m",
    kind: "system",
  };
  state.history.push(openMsg);
  cb.onMessage(openMsg);

  for (const agent of state.activeAgents) {
    const msg: RoomMessage = {
      timestamp: new Date(),
      agent: agent.personality.name,
      content: agent.personality.tagline,
      color: agent.personality.color,
      kind: "join",
      providerLabel: agent.providerName,
      modelLabel: agent.model,
    };
    state.history.push(msg);
    cb.onMessage(msg);
    state.turnsSinceSpoke.set(agent.personality.name, 2);
  }
}

// ── Step: run exactly one speaker turn ─────────────────────────────
// Returns the agent who spoke, or null if the room has stopped.
// Churn (join/leave) is evaluated internally on the appropriate interval.

export async function stepRoom(
  state: RoomState,
  cb: RoomCallbacks,
): Promise<AgentConfig | null> {
  if (!state.running) return null;

  state.turnCount++;

  // Increment silence counters for all active agents
  for (const agent of state.activeAgents) {
    const name = agent.personality.name;
    state.turnsSinceSpoke.set(name, (state.turnsSinceSpoke.get(name) ?? 0) + 1);
  }

  // Churn (only in free/auto mode)
  if (!state.governed && state.turnCount % state.config.churnIntervalTurns === 0) {
    evaluateChurn(state, cb);
  }

  // Pick a speaker (always exactly one per step)
  const speaker = pickSpeaker(state);
  if (!speaker) return null;

  await agentSpeak(state, speaker, cb);

  return state.running ? speaker : null;
}

// ── Inject a user message into history ─────────────────────────────

export function injectUserMessage(
  state: RoomState,
  content: string,
  cb: RoomCallbacks,
): void {
  const msg: RoomMessage = {
    timestamp: new Date(),
    agent: "YOU",
    content: content.trim(),
    color: "\x1b[97m",
    kind: "user",
  };
  state.history.push(msg);
  cb.onMessage(msg);
}

// ── Churn ───────────────────────────────────────────────────────────

function evaluateChurn(state: RoomState, cb: RoomCallbacks): void {
  const { activeAgents, benchedAgents, config } = state;

  if (activeAgents.length > config.minAgents) {
    const candidate = activeAgents[Math.floor(Math.random() * activeAgents.length)];
    if (Math.random() < 0.25 * (1 - candidate.personality.chattiness)) {
      state.activeAgents = activeAgents.filter(
        a => a.personality.name !== candidate.personality.name,
      );
      state.benchedAgents.push(candidate);

      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: candidate.personality.name,
        content: randomLeaveExcuse(),
        color: candidate.personality.color,
        kind: "leave",
      };
      state.history.push(msg);
      cb.onMessage(msg);
    }
  }

  if (state.activeAgents.length < config.maxAgents && state.benchedAgents.length > 0) {
    if (Math.random() < 0.3) {
      const idx = Math.floor(Math.random() * state.benchedAgents.length);
      const joiner = state.benchedAgents.splice(idx, 1)[0];
      state.activeAgents.push(joiner);
      state.turnsSinceSpoke.set(joiner.personality.name, 3);

      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: joiner.personality.name,
        content: `${joiner.personality.tagline} — ${randomJoinGreeting()}`,
        color: joiner.personality.color,
        kind: "join",
        providerLabel: joiner.providerName,
        modelLabel: joiner.model,
      };
      state.history.push(msg);
      cb.onMessage(msg);
    }
  }
}

// ── Pick one speaker ────────────────────────────────────────────────

function pickSpeaker(state: RoomState): AgentConfig | null {
  const candidates: AgentConfig[] = [];

  for (const agent of state.activeAgents) {
    const name = agent.personality.name;
    const turns = state.turnsSinceSpoke.get(name) ?? 2;
    if (shouldSpeak(agent, state.lastSpeaker, turns)) {
      candidates.push(agent);
    }
  }

  // Force the most-silent agent if nobody volunteers
  if (candidates.length === 0 && state.activeAgents.length > 0) {
    const sorted = [...state.activeAgents]
      .filter(a => a.personality.name !== state.lastSpeaker)
      .sort((a, b) => {
        const ta = state.turnsSinceSpoke.get(a.personality.name) ?? 99;
        const tb = state.turnsSinceSpoke.get(b.personality.name) ?? 99;
        return tb - ta;
      });
    if (sorted.length > 0) candidates.push(sorted[0]);
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── Generate a single agent response ────────────────────────────────

async function agentSpeak(
  state: RoomState,
  agent: AgentConfig,
  cb: RoomCallbacks,
): Promise<void> {
  const messages = buildMessages(
    agent,
    state.config.topic,
    state.history,
    state.config.contextWindow,
    state.governed,
  );

  const maxTokens = state.governed
    ? Math.max(state.config.maxTokens * 2, 2048)
    : state.config.maxTokens;

  const name = agent.personality.name;

  try {
    const result = await complete(
      agent.provider,
      { model: agent.model, messages, temperature: agent.temperature ?? 0.9, maxTokens },
      { onToken: (token) => cb.onStreamToken(name, token), onDone: () => cb.onStreamDone(name) },
      { baseUrl: agent.baseUrl, apiKey: agent.apiKey, signal: state.abortController.signal },
    );

    const raw = result.content.trim();
    const selfPrefixRe = new RegExp(`^${name}\\s*[:\\-—]\\s*`, "i");
    const content = raw.replace(selfPrefixRe, "").trim();

    if (!content) {
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `[${name} returned an empty response]`,
        color: "\x1b[90m",
        kind: "system",
      };
      state.history.push(msg);
      cb.onMessage(msg);
      return;
    }

    const msg: RoomMessage = {
      timestamp: new Date(),
      agent: name,
      content,
      color: agent.personality.color,
      kind: "chat",
    };
    state.history.push(msg);
    cb.onMessage(msg);

    state.lastSpeaker = name;
    state.turnsSinceSpoke.set(name, 0);
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    const msg: RoomMessage = {
      timestamp: new Date(),
      agent: "SYSTEM",
      content: `[${name} error: ${err.message}]`,
      color: "\x1b[90m",
      kind: "system",
    };
    state.history.push(msg);
    cb.onMessage(msg);
  }
}

// ── Abort-aware sleep (for pacing in free mode) ─────────────────────

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
