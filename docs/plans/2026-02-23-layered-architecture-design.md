# Layered Architecture: Separate TUI from Engine

**Date:** 2026-02-23
**Goal:** Refactor k2-salon into three layers (Core / Engine / Interface) so that different frontends (TUI, web app, Tauri) can drive the same engine.
**Primary target:** Web app frontend via SSE/WebSocket.

---

## Architecture Overview

Three layers with strict dependency direction: **Core <- Engine <- Interface**

```
Interface layer (tui/, cli/)
  depends on ↓
Engine layer (engine/)
  depends on ↓
Core layer (core/)
  depends on nothing
```

---

## Directory Structure

```
src/
  core/                          # Layer 1: Pure logic, no I/O, no state, no side effects
    types.ts                     # All shared types (semantic colors, no ANSI)
    speaker.ts                   # pickSpeaker, shouldSpeak — pure functions
    churn.ts                     # evaluateChurn — returns decisions, doesn't execute
    personality.ts               # buildMessages, buildSystemPrompt
    roster.ts                    # Personality presets + join/leave phrases

  engine/                        # Layer 2: State + orchestration + EventEmitter
    salon-engine.ts              # SalonEngine class extends TypedEmitter
    provider.ts                  # LLM provider abstraction (OpenRouter, OpenAI-compat, Ollama)
    persist.ts                   # Filesystem persistence (rooms, transcripts)
    config.ts                    # YAML config loading + roster resolution

  tui/                           # Layer 3: Terminal interface
    app.tsx                      # Ink React component (subscribes to engine events)
    main.ts                      # TUI entry point — thin shell
    colors.ts                    # AgentColor -> ink color mapping

  cli/                           # Layer 3: Other CLI entry points
    simulate.ts                  # Headless simulation (uses SalonEngine)
    podcast.ts                   # TTS pipeline (reads transcripts only)
    models.ts                    # Model listing
    shuffle-personas.ts          # Roster shuffling
```

---

## Layer 1: Core (Pure Functions)

Zero dependencies on Node.js, I/O, or external packages.

### types.ts — Semantic colors

Colors become semantic identifiers, not ANSI escape codes:

```typescript
export type AgentColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "gray" | "redBright" | "greenBright" | "yellowBright" | "blueBright"
  | "magentaBright" | "cyanBright" | "whiteBright";

export interface Personality {
  name: string;
  color: AgentColor;          // was "\x1b[36m", now "cyan"
  tagline: string;
  traits: string[];
  style: string[];
  bias: string;
  chattiness: number;
  contrarianism: number;
}

export interface RoomMessage {
  timestamp: Date;
  agent: string;
  content: string;
  color: AgentColor;          // semantic, not ANSI
  kind: "chat" | "join" | "leave" | "system" | "user";
  providerLabel?: string;
  modelLabel?: string;
}
```

All other types (ChatMessage, CompletionRequest, CompletionResponse, AgentConfig, RoomConfig, ProviderEntry, RosterEntry, SalonConfig) stay the same except Personality.color and RoomMessage.color become `AgentColor`.

### speaker.ts

Extracted from room.ts. Pure functions that return data, don't mutate state.

```typescript
/** Return candidate speakers (does NOT pick randomly — engine does that) */
export function getSpeakerCandidates(
  activeAgents: readonly AgentConfig[],
  lastSpeaker: string | null,
  turnsSinceSpoke: ReadonlyMap<string, number>,
): AgentConfig[]

/** Probability check: should this agent speak given recency? */
export function shouldSpeak(
  agent: AgentConfig,
  lastSpeaker: string | null,
  turnsSinceLast: number,
): boolean
```

### churn.ts

```typescript
export interface ChurnDecision {
  leave?: { agent: AgentConfig; excuse: string };
  join?: { agent: AgentConfig; greeting: string };
}

/** Evaluate churn probabilities. Returns what SHOULD happen — engine executes it. */
export function evaluateChurn(
  activeAgents: readonly AgentConfig[],
  benchedAgents: readonly AgentConfig[],
  config: Pick<RoomConfig, "minAgents" | "maxAgents">,
): ChurnDecision
```

### personality.ts

Moved from `agents/personality.ts`. Functions unchanged:
- `buildSystemPrompt(personality, topic, verbose, language)`
- `buildMessages(agent, topic, history, contextWindow, verbose, language)`

### roster.ts

Moved from `agents/roster.ts`. Data unchanged except colors become semantic:
- `PERSONALITY_PRESETS` — 8 agent presets with `AgentColor` values
- `randomJoinGreeting()` / `randomLeaveExcuse()` — random phrase generators

---

## Layer 2: Engine (SalonEngine)

### salon-engine.ts

```typescript
import { TypedEmitter } from "tiny-typed-emitter";

interface SalonEvents {
  message:      (msg: RoomMessage) => void;
  thinking:     (agentName: string) => void;
  token:        (agentName: string, token: string) => void;
  streamDone:   (agentName: string) => void;
  rosterChange: (active: readonly AgentConfig[], benched: readonly AgentConfig[]) => void;
  stopped:      () => void;
}

export class SalonEngine extends TypedEmitter<SalonEvents> {
  // ── Private state (replaces RoomState interface) ───────────
  private config: RoomConfig;
  private _history: RoomMessage[];
  private _activeAgents: AgentConfig[];
  private _benchedAgents: AgentConfig[];
  private _turnCount: number;
  private _lastSpeaker: string | null;
  private _turnsSinceSpoke: Map<string, number>;
  private _running: boolean;
  private _abortController: AbortController;

  constructor(config: RoomConfig, allAgents: AgentConfig[], opts?: {
    preloadedHistory?: RoomMessage[];
    preferredRoster?: string[];
  })

  // ── Lifecycle ──────────────────────────────────────────────
  open(): void                    // emit topic + join messages + rosterChange
  stop(): void                    // abort + emit stopped

  // ── Commands ───────────────────────────────────────────────
  step(opts?: StepOptions): Promise<AgentConfig | null>   // one turn
  peekNextSpeaker(): AgentConfig | null                    // preview
  inject(text: string): void                               // user message
  shuffle(): void                                          // new roster

  // ── Read-only queries ──────────────────────────────────────
  get activeAgents(): readonly AgentConfig[]
  get benchedAgents(): readonly AgentConfig[]
  get history(): readonly RoomMessage[]
  get isRunning(): boolean
  get turnCount(): number
  get abortSignal(): AbortSignal
}
```

### Internal flow of `step()`:

1. Increment turn count + turnsSinceSpoke for all agents
2. If `opts.churn` and interval is due: call `evaluateChurn()` from core, execute decisions, emit events
3. Pick speaker: call `getSpeakerCandidates()` from core, random-select one (or use `opts.speaker`)
4. Build messages via `buildMessages()` from core
5. Call `complete()` from provider, emit `thinking` → `token` → `streamDone` → `message`
6. Update lastSpeaker + turnsSinceSpoke

### provider.ts, persist.ts, config.ts

Moved from their current locations. Code unchanged. Only import paths update.

---

## Layer 3: Interface (TUI)

### tui/main.ts — Thin shell

```typescript
async function main() {
  // 1. Parse args, load config, resolve roster
  const { salonConfig, roster } = await loadAndResolveConfig();
  const { roomName, topic, language, history, savedRoster, isResumed, session } =
    await setupRoom(salonConfig);

  // 2. Create engine
  const engine = new SalonEngine(
    { ...salonConfig.room, topic, language },
    roster,
    { preloadedHistory: history, preferredRoster: savedRoster },
  );

  // 3. Wire persistence
  const transcript = new TranscriptWriter(roomName, session, topic);
  await transcript.init(roster.map(a => a.personality.name));
  engine.on("message", (msg) => transcript.append(msg));
  engine.on("rosterChange", (active) => {
    // Save active roster names to room.yaml
    saveActiveRoster(roomName, active.map(a => a.personality.name));
  });

  // 4. Mount TUI (subscribes to engine events internally)
  const tui = renderTui({
    roomName, session, topic, resumed: isResumed,
    contextCount: history.length, engine,
  });

  // 5. Show resume history in TUI
  if (isResumed) showResumeHistory(engine, tui, history);

  // 6. Open room
  engine.open();

  // 7. Run governed/free mode loop (TUI concern)
  await runModeLoop(engine, tui);

  // 8. Cleanup
  await transcript.finalize();
}
```

### tui/app.tsx — Engine event subscriber

The React component receives the SalonEngine and subscribes to events in useEffect.

Key changes from current tui.tsx:
- **Remove** module-level `eventQueue`, `eventFlush`, `emitTuiEvent`
- **Remove** `TuiHandle` interface (no more imperative handle)
- **Add** `engine` prop to `App` component
- **Subscribe** to engine events in `useEffect(() => { engine.on(...) }, [engine])`
- Keep the 50ms streaming buffer flush (terminal performance optimization)
- Keep all rendering components (Header, ChatMessage, WhoTable, StatusBar, InputLine) unchanged

### tui/colors.ts — Mapping

```typescript
const AGENT_COLOR_TO_INK: Record<AgentColor, string> = {
  black: "black", red: "red", green: "green", yellow: "yellow",
  blue: "blue", magenta: "magenta", cyan: "cyan", white: "white",
  gray: "gray", redBright: "redBright", greenBright: "greenBright",
  yellowBright: "yellowBright", blueBright: "blueBright",
  magentaBright: "magentaBright", cyanBright: "cyanBright",
  whiteBright: "whiteBright",
};

export function toInkColor(color: AgentColor): string {
  return AGENT_COLOR_TO_INK[color] ?? "white";
}
```

Replaces the current `ANSI_TO_INK` map and `ansiToInk()` function.

---

## Data Flow Comparison

### User types a message

**Before (6 hops, 4 files, 2 indirection layers):**
```
keystroke → tui.tsx handleSubmit → onUserInput callback
→ main.ts inputBuffer.push → loop polls buffer
→ room.ts injectUserMessage (mutates state, calls cb.onMessage)
→ main.ts callback → tui.handle.pushMessage → emitTuiEvent
→ tui.tsx eventQueue → processEvents → setMessages
```

**After (4 hops, 3 files, 0 indirection layers):**
```
keystroke → app.tsx handleSubmit → mode loop receives input
→ tui/main.ts calls engine.inject(text)
→ salon-engine.ts mutates state, emits "message"
→ app.tsx subscription → setMessages
```

### Agent streams a response

**Before:**
```
room.ts agentSpeak → complete() stream callbacks
→ cb.onStreamToken → main.ts → tui.handle.streamToken → emitTuiEvent
→ tui.tsx eventQueue → streamingRef.buffer += token
→ 50ms flush to React state
```

**After:**
```
salon-engine.ts step → complete() → engine.emit("token")
→ app.tsx subscription → streamingRef.buffer += token
→ 50ms flush to React state
```

---

## What a Future Web Interface Looks Like

```typescript
// web/server.ts
import { SalonEngine } from "../engine/salon-engine.js";

const engine = new SalonEngine(config, roster);

app.get("/api/room/:name/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });

  engine.on("message", (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
  engine.on("token", (agent, tok) => res.write(`data: ${JSON.stringify({ agent, token: tok })}\n\n`));
  engine.on("rosterChange", (active) => res.write(`data: ${JSON.stringify({ roster: active })}\n\n`));
});

app.post("/api/room/:name/step", (req, res) => {
  const speaker = await engine.step(req.body);
  res.json({ speaker: speaker?.personality.name });
});

app.post("/api/room/:name/inject", (req, res) => {
  engine.inject(req.body.text);
  res.sendStatus(200);
});
```

Same engine, different subscriber. The semantic colors map to CSS classes on the frontend.

---

## Migration Phases

### Phase 1: Core layer
- Create `src/core/types.ts` — copy types, change colors to semantic
- Create `src/core/speaker.ts` — extract pickSpeaker + shouldSpeak from room.ts
- Create `src/core/churn.ts` — extract evaluateChurn, return decisions
- Move `agents/personality.ts` → `core/personality.ts`
- Move `agents/roster.ts` → `core/roster.ts`, update colors to semantic

### Phase 2: Engine layer
- Create `src/engine/salon-engine.ts` — class wrapping room.ts logic + EventEmitter
- Move `providers/provider.ts` → `engine/provider.ts`
- Move `room/persist.ts` → `engine/persist.ts`
- Move `config/loader.ts` → `engine/config.ts`
- Add `tiny-typed-emitter` dependency

### Phase 3: Interface layer
- Create `src/tui/colors.ts` — semantic-to-ink mapping
- Move `cli/tui.tsx` → `tui/app.tsx`, refactor to subscribe to engine events
- Create `src/tui/main.ts` — thin shell using SalonEngine
- Update `cli/simulate.ts` to use SalonEngine

### Phase 4: Cleanup
- Delete old files: `src/main.ts`, `src/room/`, `src/agents/`, `src/providers/`, `src/config/`
- Update all import paths
- Update package.json entry points
- Verify all CLI commands work

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Motivation | Multi-frontend support | Concrete plan to build web frontend |
| Target frontend | Web app | SSE/WebSocket for streaming |
| Mode ownership | UI owns modes | Engine stays step-based, interfaces decide pacing |
| API style | Class + EventEmitter | Methods for commands, events for output |
| Persistence | Outside engine | Different interfaces have different persistence needs |
| Architecture | Full 3-layer (Core/Engine/Interface) | Long-term clean architecture investment |
| Color system | Semantic identifiers | Enables web/native frontends |
