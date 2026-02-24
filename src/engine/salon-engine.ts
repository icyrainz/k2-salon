import { TypedEmitter } from "tiny-typed-emitter";
import type { AgentConfig, RoomConfig, RoomMessage } from "../core/types.js";
import { buildMessages } from "../core/personality.js";
import {
  getSpeakerCandidates,
  peekNextSpeakerCandidates,
} from "../core/speaker.js";
import { evaluateChurn } from "../core/churn.js";
import { randomJoinGreeting, randomLeaveExcuse } from "../core/roster.js";
import { complete } from "./provider.js";

// ── Events emitted by SalonEngine ───────────────────────────────────

interface SalonEvents {
  message: (msg: RoomMessage) => void;
  thinking: (agent: string, msgId: number) => void;
  streamToken: (agent: string, token: string) => void;
  streamDone: (agent: string) => void;
}

// ── Step options ────────────────────────────────────────────────────

export interface StepOptions {
  verbose?: boolean;
  churn?: boolean;
  speaker?: AgentConfig;
}

// ── SalonEngine — orchestrates a salon room ─────────────────────────

export class SalonEngine extends TypedEmitter<SalonEvents> {
  readonly config: RoomConfig;

  private history: RoomMessage[] = [];
  private _activeAgents: AgentConfig[] = [];
  private _benchedAgents: AgentConfig[] = [];
  private turnCount = 0;
  private lastSpeaker: string | null = null;
  private turnsSinceSpoke = new Map<string, number>();
  private _running = false;
  private abortController = new AbortController();
  private nextMsgId = 0;

  get activeAgents(): readonly AgentConfig[] {
    return this._activeAgents;
  }
  get benchedAgents(): readonly AgentConfig[] {
    return this._benchedAgents;
  }
  get running(): boolean {
    return this._running;
  }
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  constructor(
    config: RoomConfig,
    allAgents: AgentConfig[],
    preloadedHistory?: RoomMessage[],
    preferredRoster?: string[],
  ) {
    super();
    this.config = config;

    if (preloadedHistory) {
      // Preserve existing IDs from transcripts (for TTS cache consistency).
      // For legacy messages without IDs, use their index as a stable fallback.
      this.history = preloadedHistory.map((msg, i) => ({
        ...msg,
        id: msg.id ?? i,
      }));
      // Start new IDs above the highest existing one to avoid collisions
      const maxId = this.history.reduce(
        (max, m) => Math.max(max, m.id ?? 0),
        0,
      );
      this.nextMsgId = maxId + 1;
    }

    // Determine initial active vs benched agents
    if (preferredRoster && preferredRoster.length > 0) {
      const nameSet = new Set(preferredRoster);
      this._activeAgents = preferredRoster
        .map((n) => allAgents.find((a) => a.personality.name === n))
        .filter((a): a is AgentConfig => a !== undefined);
      this._benchedAgents = allAgents.filter(
        (a) => !nameSet.has(a.personality.name),
      );
    } else {
      const initialCount = Math.min(
        config.maxAgents,
        Math.max(config.minAgents, Math.floor(allAgents.length * 0.5)),
      );

      const priorityAgents = [...allAgents]
        .filter((a) => a.priority !== undefined)
        .sort((a, b) => a.priority! - b.priority!);
      const normalAgents = [...allAgents]
        .filter((a) => a.priority === undefined)
        .sort(() => Math.random() - 0.5);

      const ordered = [...priorityAgents, ...normalAgents];
      this._activeAgents = ordered.slice(0, initialCount);
      this._benchedAgents = ordered.slice(initialCount);
    }
  }

  // ── Open room: emit topic + join messages ───────────────────────

  open(): void {
    this._running = true;

    this.pushMessage({
      timestamp: new Date(),
      agent: "SYSTEM",
      content: `Topic: "${this.config.topic}"`,
      color: "gray",
      kind: "system",
    });

    for (const agent of this._activeAgents) {
      this.pushMessage({
        timestamp: new Date(),
        agent: agent.personality.name,
        content: agent.personality.tagline,
        color: agent.personality.color,
        kind: "join",
        providerLabel: agent.providerName,
        modelLabel: agent.model,
      });
      this.turnsSinceSpoke.set(agent.personality.name, 2);
    }
  }

  // ── Stop room ──────────────────────────────────────────────────

  stop(): void {
    this._running = false;
    this.abortController.abort();
  }

  // ── Step: run exactly one speaker turn ─────────────────────────

  async step(opts: StepOptions = {}): Promise<AgentConfig | null> {
    if (!this._running) return null;

    const { verbose = false, churn = false, speaker: forcedSpeaker } = opts;

    this.turnCount++;

    for (const agent of this._activeAgents) {
      const name = agent.personality.name;
      this.turnsSinceSpoke.set(name, (this.turnsSinceSpoke.get(name) ?? 0) + 1);
    }

    if (churn && this.turnCount % this.config.churnIntervalTurns === 0) {
      this.applyChurn();
    }

    const speaker = forcedSpeaker ?? this.pickSpeaker();
    if (!speaker) return null;

    await this.agentSpeak(speaker, verbose);

    return this._running ? speaker : null;
  }

  // ── Shuffle: replace active agents with a fresh random selection

  shuffle(): void {
    for (const agent of this._activeAgents) {
      this.pushMessage({
        timestamp: new Date(),
        agent: agent.personality.name,
        content: randomLeaveExcuse(),
        color: agent.personality.color,
        kind: "leave",
      });
    }

    const allAgents = [...this._activeAgents, ...this._benchedAgents];
    const initialCount = Math.min(
      this.config.maxAgents,
      Math.max(this.config.minAgents, Math.floor(allAgents.length * 0.5)),
    );

    const priorityAgents = [...allAgents]
      .filter((a) => a.priority !== undefined)
      .sort((a, b) => a.priority! - b.priority!);
    const normalAgents = [...allAgents]
      .filter((a) => a.priority === undefined)
      .sort(() => Math.random() - 0.5);

    const ordered = [...priorityAgents, ...normalAgents];
    this._activeAgents = ordered.slice(0, initialCount);
    this._benchedAgents = ordered.slice(initialCount);
    this.lastSpeaker = null;
    this.turnsSinceSpoke.clear();

    for (const agent of this._activeAgents) {
      this.pushMessage({
        timestamp: new Date(),
        agent: agent.personality.name,
        content: `${agent.personality.tagline} — ${randomJoinGreeting()}`,
        color: agent.personality.color,
        kind: "join",
        providerLabel: agent.providerName,
        modelLabel: agent.model,
      });
      this.turnsSinceSpoke.set(agent.personality.name, 2);
    }
  }

  // ── Inject a user message into history ─────────────────────────

  injectUserMessage(content: string): void {
    this.pushMessage({
      timestamp: new Date(),
      agent: "YOU",
      content: content.trim(),
      color: "whiteBright",
      kind: "user",
    });
  }

  // ── Peek next speaker (for governed mode preview) ──────────────

  peekNextSpeaker(): AgentConfig | null {
    const candidates = peekNextSpeakerCandidates(
      this._activeAgents,
      this.lastSpeaker,
      this.turnsSinceSpoke,
    );
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── Abort-aware sleep ─────────────────────────────────────────

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // ── Internal: push a message to history and emit ───────────────

  private pushMessage(msg: RoomMessage): void {
    // Use pre-allocated ID if present (from agentSpeak), otherwise assign next
    if (msg.id === undefined) {
      msg.id = this.nextMsgId++;
    }
    this.history.push(msg);
    this.emit("message", msg);
  }

  // ── Internal: pick one speaker ─────────────────────────────────

  private pickSpeaker(): AgentConfig | null {
    const candidates = getSpeakerCandidates(
      this._activeAgents,
      this.lastSpeaker,
      this.turnsSinceSpoke,
    );
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── Internal: apply churn decision ────────────────────────────

  private applyChurn(): void {
    const decision = evaluateChurn(
      this._activeAgents,
      this._benchedAgents,
      this.config,
      { randomLeaveExcuse, randomJoinGreeting },
    );

    if (decision.leave) {
      const { agent, excuse } = decision.leave;
      this._activeAgents = this._activeAgents.filter(
        (a) => a.personality.name !== agent.personality.name,
      );
      this._benchedAgents.push(agent);

      this.pushMessage({
        timestamp: new Date(),
        agent: agent.personality.name,
        content: excuse,
        color: agent.personality.color,
        kind: "leave",
      });
    }

    if (decision.join) {
      const { agent, greeting } = decision.join;
      this._benchedAgents = this._benchedAgents.filter(
        (a) => a.personality.name !== agent.personality.name,
      );
      this._activeAgents.push(agent);
      this.turnsSinceSpoke.set(agent.personality.name, 3);

      this.pushMessage({
        timestamp: new Date(),
        agent: agent.personality.name,
        content: `${agent.personality.tagline} — ${greeting}`,
        color: agent.personality.color,
        kind: "join",
        providerLabel: agent.providerName,
        modelLabel: agent.model,
      });
    }
  }

  // ── Internal: generate a single agent response ────────────────

  private async agentSpeak(
    agent: AgentConfig,
    verbose: boolean,
  ): Promise<void> {
    const messages = buildMessages(
      agent,
      this.config.topic,
      this.history,
      this.config.contextWindow,
      verbose,
      this.config.language,
    );

    const maxTokens = verbose
      ? Math.max(this.config.maxTokens * 2, 2048)
      : this.config.maxTokens;

    const name = agent.personality.name;
    // Pre-allocate the message ID so the TUI can associate streaming
    // content with the final persisted message from the start.
    const preallocId = this.nextMsgId++;
    this.emit("thinking", name, preallocId);

    try {
      const result = await complete(
        agent.provider,
        {
          model: agent.model,
          messages,
          temperature: agent.temperature ?? 0.9,
          maxTokens,
        },
        {
          onToken: (token) => this.emit("streamToken", name, token),
          onDone: () => this.emit("streamDone", name),
        },
        {
          baseUrl: agent.baseUrl,
          apiKey: agent.apiKey,
          signal: this.abortController.signal,
        },
      );

      const raw = result.content.trim();
      const selfPrefixRe = new RegExp(`^${name}\\s*[:\\-—]\\s*`, "i");
      const content = raw.replace(selfPrefixRe, "").trim();

      if (!content) {
        this.pushMessage({
          timestamp: new Date(),
          agent: "SYSTEM",
          content: `[${name} returned an empty response]`,
          color: "gray",
          kind: "system",
        });
        return;
      }

      this.pushMessage({
        timestamp: new Date(),
        agent: name,
        content,
        color: agent.personality.color,
        kind: "chat",
        id: preallocId,
      });

      this.lastSpeaker = name;
      this.turnsSinceSpoke.set(name, 0);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      this.pushMessage({
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `[${name} error: ${err.message}]`,
        color: "gray",
        kind: "system",
      });
    }
  }
}
