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
  /** Tracks how many turns since each agent last spoke */
  turnsSinceSpoke: Map<string, number>;
  running: boolean;
  /** Aborts any in-flight LLM fetch when the room stops */
  abortController: AbortController;
}

export type RoomEventHandler = (msg: RoomMessage) => void;
export type StreamTokenHandler = (agent: string, token: string) => void;
export type StreamDoneHandler = (agent: string) => void;

export interface RoomCallbacks {
  onMessage: RoomEventHandler;
  onStreamToken: StreamTokenHandler;
  onStreamDone: StreamDoneHandler;
  /**
   * Non-blocking: check if user has typed something.
   * Returns the line if available, empty string if nothing pending,
   * or null if user wants to quit.
   */
  pollUserInput: () => string | null | undefined;
}

// ── Create room ─────────────────────────────────────────────────────

export function createRoom(
  config: RoomConfig,
  allAgents: AgentConfig[],
  preloadedHistory?: RoomMessage[],
): RoomState {
  // Pick initial active agents (up to maxAgents)
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
  };
}

// ── Add message to history ──────────────────────────────────────────

function pushMessage(state: RoomState, msg: RoomMessage): void {
  state.history.push(msg);
}

// ── Churn: drop-in / drop-out simulation ────────────────────────────

function evaluateChurn(state: RoomState, cb: RoomCallbacks): void {
  const { activeAgents, benchedAgents, config } = state;

  // Maybe someone leaves
  if (activeAgents.length > config.minAgents) {
    // Pick a random agent, weighted by low chattiness (quiet people leave first)
    const leaveCandidate = activeAgents[Math.floor(Math.random() * activeAgents.length)];
    const leaveProb = 0.25 * (1 - leaveCandidate.personality.chattiness);

    if (Math.random() < leaveProb) {
      // Remove from active
      state.activeAgents = activeAgents.filter(a => a.personality.name !== leaveCandidate.personality.name);
      state.benchedAgents.push(leaveCandidate);

      const excuse = randomLeaveExcuse();
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: leaveCandidate.personality.name,
        content: excuse,
        color: leaveCandidate.personality.color,
        kind: "leave",
      };
      pushMessage(state, msg);
      cb.onMessage(msg);
    }
  }

  // Maybe someone joins
  if (state.activeAgents.length < config.maxAgents && state.benchedAgents.length > 0) {
    const joinProb = 0.3;
    if (Math.random() < joinProb) {
      const idx = Math.floor(Math.random() * state.benchedAgents.length);
      const joiner = state.benchedAgents.splice(idx, 1)[0];
      state.activeAgents.push(joiner);
      state.turnsSinceSpoke.set(joiner.personality.name, 3); // eager to talk

      const greeting = randomJoinGreeting();
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: joiner.personality.name,
        content: `${joiner.personality.tagline} — ${greeting}`,
        color: joiner.personality.color,
        kind: "join",
        providerLabel: joiner.providerName,
        modelLabel: joiner.model,
      };
      pushMessage(state, msg);
      cb.onMessage(msg);
    }
  }
}

// ── Pick next speaker(s) ────────────────────────────────────────────

function pickSpeakers(state: RoomState): AgentConfig[] {
  const candidates: AgentConfig[] = [];

  for (const agent of state.activeAgents) {
    const name = agent.personality.name;
    const turns = state.turnsSinceSpoke.get(name) ?? 2;

    if (shouldSpeak(agent, state.lastSpeaker, turns)) {
      candidates.push(agent);
    }
  }

  // If nobody wants to talk, force the least-recent speaker
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

  // Limit to 1-2 speakers per round to keep pacing natural
  // Shuffle and pick 1 (occasionally 2 for rapid back-and-forth)
  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const count = Math.random() < 0.15 ? Math.min(2, shuffled.length) : 1;
  return shuffled.slice(0, count);
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
  );

  const name = agent.personality.name;

  try {
    const result = await complete(
      agent.provider,
      { model: agent.model, messages, temperature: agent.temperature ?? 0.9, maxTokens: state.config.maxTokens },
      { onToken: (token) => cb.onStreamToken(name, token), onDone: () => cb.onStreamDone(name) },
      { baseUrl: agent.baseUrl, apiKey: agent.apiKey, signal: state.abortController.signal },
    );

    // Strip leading "Name:" or "Name —" self-prefix that some models add
    // despite being told not to. Match "DocK:", "DocK —", "DocK -", etc.
    const raw = result.content.trim();
    const selfPrefixRe = new RegExp(`^${name}\\s*[:\\-—]\\s*`, "i");
    const content = raw.replace(selfPrefixRe, "").trim();
    if (!content) {
      // Surface empty responses so they're visible in the TUI
      const emptyMsg: RoomMessage = {
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `[${name} returned an empty response]`,
        color: "\x1b[90m",
        kind: "system",
      };
      pushMessage(state, emptyMsg);
      cb.onMessage(emptyMsg);
      return;
    }

    const msg: RoomMessage = {
      timestamp: new Date(),
      agent: name,
      content,
      color: agent.personality.color,
      kind: "chat",
    };
    pushMessage(state, msg);
    cb.onMessage(msg);

    state.lastSpeaker = name;
    state.turnsSinceSpoke.set(name, 0);
  } catch (err: any) {
    // AbortError = room was stopped intentionally, not a real error
    if (err?.name === "AbortError") return;
    const msg: RoomMessage = {
      timestamp: new Date(),
      agent: "SYSTEM",
      content: `[${name} encountered an error: ${err.message}]`,
      color: "\x1b[90m",
      kind: "system",
    };
    pushMessage(state, msg);
    cb.onMessage(msg);
  }
}

// ── Main conversation loop ──────────────────────────────────────────

export async function runRoom(
  state: RoomState,
  cb: RoomCallbacks,
): Promise<void> {
  state.running = true;

  // Opening system message
  const openMsg: RoomMessage = {
    timestamp: new Date(),
    agent: "SYSTEM",
    content: `Topic: "${state.config.topic}"`,
    color: "\x1b[90m",
    kind: "system",
  };
  pushMessage(state, openMsg);
  cb.onMessage(openMsg);

  // Announce initial agents
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
    pushMessage(state, msg);
    cb.onMessage(msg);
    state.turnsSinceSpoke.set(agent.personality.name, 2);
  }

  // Main loop
  while (state.running) {
    state.turnCount++;

    // Increment turn counters for all active agents
    for (const agent of state.activeAgents) {
      const name = agent.personality.name;
      state.turnsSinceSpoke.set(name, (state.turnsSinceSpoke.get(name) ?? 0) + 1);
    }

    // Every N turns, check for churn
    if (state.turnCount % state.config.churnIntervalTurns === 0) {
      evaluateChurn(state, cb);
    }

    // Pick who speaks this turn
    const speakers = pickSpeakers(state);

    // Generate responses (sequential for natural feel)
    for (const speaker of speakers) {
      if (!state.running) break;
      await agentSpeak(state, speaker, cb);

      // Natural pacing delay — base + wide random jitter so turns feel organic.
      // Abortable so /quit exits immediately instead of waiting out the delay.
      const jitter = Math.random() * 3000;
      await sleepAbortable(state.config.turnDelayMs + jitter, state.abortController.signal);
    }

    // Check for user input (non-blocking)
    const userInput = cb.pollUserInput();
    if (userInput === null) {
      // null = user wants to quit
      state.running = false;
      break;
    }
    if (userInput && userInput.trim()) {
      const userMsg: RoomMessage = {
        timestamp: new Date(),
        agent: "YOU",
        content: userInput.trim(),
        color: "\x1b[97m", // bright white
        kind: "user",
      };
      pushMessage(state, userMsg);
      cb.onMessage(userMsg);
    }
  }
}

export function stopRoom(state: RoomState): void {
  state.running = false;
  state.abortController.abort();
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
