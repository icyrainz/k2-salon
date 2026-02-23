# Layered Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor k2-salon into three layers (Core / Engine / Interface) so different frontends can drive the same engine.

**Architecture:** Three layers with strict dependency direction: Core ← Engine ← Interface. Core has pure functions with zero I/O. Engine wraps state + EventEmitter. TUI becomes a thin subscriber. See `docs/plans/2026-02-23-layered-architecture-design.md` for full design.

**Tech Stack:** TypeScript, Bun runtime, Ink (React for CLI), `tiny-typed-emitter` (new dep)

**Verification:** Run `npx tsc --noEmit` after each task to verify type-correctness. There are no unit tests; the type checker is the safety net.

---

## Task 1: Install dependency and create directory structure

**Files:**
- Modify: `package.json`
- Create: `src/core/` directory
- Create: `src/engine/` directory
- Create: `src/tui/` directory

**Step 1: Install tiny-typed-emitter**

Run: `bun add tiny-typed-emitter`

**Step 2: Create new directories**

Run: `mkdir -p src/core src/engine src/tui`

**Step 3: Commit**

```bash
git add package.json bun.lockb src/core src/engine src/tui
git commit -m "chore: add tiny-typed-emitter dep and create layer directories"
```

---

## Task 2: Create `src/core/types.ts` — Semantic colors

Copy all types from `src/types.ts` (126 lines) with these changes:

**Files:**
- Create: `src/core/types.ts`

**Step 1: Create the new types file**

Copy the entire contents of `src/types.ts` and make these changes:

1. Add `AgentColor` type union at the top (after the first comment):

```typescript
export type AgentColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "gray" | "redBright" | "greenBright" | "yellowBright" | "blueBright"
  | "magentaBright" | "cyanBright" | "whiteBright";
```

2. Change `Personality.color` from `string` to `AgentColor`. Update the JSDoc:
```typescript
/** Semantic color identifier for this agent */
color: AgentColor;
```

3. Change `RoomMessage.color` from `string` to `AgentColor`.

4. All other types remain identical: `ProviderKind`, `ChatMessage`, `CompletionRequest`, `CompletionResponse`, `AgentConfig`, `RoomConfig`, `ProviderEntry`, `RosterEntry`, `SalonConfig`.

**Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: Errors from files still importing old `src/types.ts` — that's fine, we haven't switched imports yet. The new file itself should have no internal errors.

**Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(core): create types.ts with semantic AgentColor"
```

---

## Task 3: Create `src/core/speaker.ts` — Pure speaker selection

Extract `pickSpeaker` from `src/room/room.ts:296-320` and `shouldSpeak` from `src/agents/personality.ts:81-98` into pure functions.

**Files:**
- Create: `src/core/speaker.ts`

**Step 1: Create the speaker module**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/core/speaker.ts
git commit -m "feat(core): extract speaker selection as pure functions"
```

---

## Task 4: Create `src/core/churn.ts` — Pure churn evaluation

Extract churn logic from `src/room/room.ts:247-292` into a pure function that returns decisions.

**Files:**
- Create: `src/core/churn.ts`

**Step 1: Create the churn module**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/core/churn.ts
git commit -m "feat(core): extract churn evaluation as pure function"
```

---

## Task 5: Create `src/core/personality.ts` — Move personality logic

Move `src/agents/personality.ts` to `src/core/personality.ts`, updating imports.

**Files:**
- Create: `src/core/personality.ts`

**Step 1: Copy personality.ts and update imports**

Copy the entire file from `src/agents/personality.ts` (99 lines). Change only the import path:

```typescript
// Line 1: change
import type { AgentConfig, ChatMessage, Personality, RoomMessage } from "../types.js";
// to:
import type { AgentConfig, ChatMessage, Personality, RoomMessage } from "./types.js";
```

Remove the `shouldSpeak` function (lines 79-98) — it's now in `src/core/speaker.ts`.

The remaining exports are `buildSystemPrompt` and `buildMessages`.

**Step 2: Commit**

```bash
git add src/core/personality.ts
git commit -m "feat(core): move personality/prompt building to core layer"
```

---

## Task 6: Create `src/core/roster.ts` — Move roster with semantic colors

Move `src/agents/roster.ts` to `src/core/roster.ts`, converting ANSI codes to semantic colors.

**Files:**
- Create: `src/core/roster.ts`

**Step 1: Copy roster.ts and update colors**

Copy `src/agents/roster.ts` (186 lines). Make these changes:

1. Update import: `from "../types.js"` → `from "./types.js"`

2. Convert all ANSI color codes in `PERSONALITY_PRESETS` to semantic `AgentColor` strings:

| Agent | Old (ANSI) | New (semantic) |
|-------|-----------|---------------|
| Sage | `"\x1b[36m"` | `"cyan"` |
| Riko | `"\x1b[33m"` | `"yellow"` |
| Nova | `"\x1b[35m"` | `"magenta"` |
| DocK | `"\x1b[32m"` | `"green"` |
| Wren | `"\x1b[34m"` | `"blue"` |
| Jules | `"\x1b[91m"` | `"redBright"` |
| Chip | `"\x1b[93m"` | `"yellowBright"` |
| Ora | `"\x1b[92m"` | `"greenBright"` |

3. Leave `LEAVE_EXCUSES`, `JOIN_GREETINGS`, `randomLeaveExcuse`, `randomJoinGreeting` unchanged.

**Step 2: Commit**

```bash
git add src/core/roster.ts
git commit -m "feat(core): move roster presets with semantic colors"
```

---

## Task 7: Move `src/providers/provider.ts` → `src/engine/provider.ts`

**Files:**
- Create: `src/engine/provider.ts`

**Step 1: Copy and update imports**

Copy `src/providers/provider.ts` (357 lines). Change only the import:

```typescript
// Line 1: change
import type { CompletionRequest, CompletionResponse, ProviderKind } from "../types.js";
// to:
import type { CompletionRequest, CompletionResponse, ProviderKind } from "../core/types.js";
```

Everything else stays identical.

**Step 2: Commit**

```bash
git add src/engine/provider.ts
git commit -m "refactor(engine): move provider to engine layer"
```

---

## Task 8: Move `src/room/persist.ts` → `src/engine/persist.ts`

**Files:**
- Create: `src/engine/persist.ts`

**Step 1: Copy and update imports + ANSI colors**

Copy `src/room/persist.ts` (355 lines). Make these changes:

1. Update import: `from "../types.js"` → `from "../core/types.js"`

2. In `parseSeedToMessages()` function, change ANSI color strings to semantic `AgentColor`:
   - Line ~293: `color: "\x1b[97m"` → `color: "whiteBright"` (for "YOU" user messages)
   - Line ~309: `color: "\x1b[90m"` → `color: "gray"` (for "PRIOR" assistant messages)
   - Line ~325: `color: "\x1b[90m"` → `color: "gray"` (for SYSTEM heading messages)
   - Line ~337: `color: "\x1b[90m"` → `color: "gray"` (for generic context blocks)

3. In `parseSessionMarkdown()`, the `color: ""` is fine — the engine/TUI will resolve agent colors from the roster. But change `color: ""` to `color: "white" as AgentColor` for type safety. Actually, the simpler approach: since parsed messages will have color resolved by the engine/TUI from the roster, keep `color: "gray"` as a default for parsed messages.

   Change line ~241 and ~254-258: `color: ""` → `color: "gray"`

**Step 2: Commit**

```bash
git add src/engine/persist.ts
git commit -m "refactor(engine): move persist to engine layer with semantic colors"
```

---

## Task 9: Move `src/config/loader.ts` → `src/engine/config.ts`

**Files:**
- Create: `src/engine/config.ts`

**Step 1: Copy and update imports**

Copy `src/config/loader.ts` (171 lines). Change the import:

```typescript
// change
import type { AgentConfig, Personality, ProviderEntry, RosterEntry, SalonConfig } from "../types.js";
// to:
import type { AgentConfig, Personality, ProviderEntry, RosterEntry, SalonConfig } from "../core/types.js";
```

Everything else stays identical.

**Step 2: Commit**

```bash
git add src/engine/config.ts
git commit -m "refactor(engine): move config loader to engine layer"
```

---

## Task 10: Create `src/engine/salon-engine.ts` — The SalonEngine class

This is the core of the refactor. Create the engine class wrapping room logic with EventEmitter.

**Files:**
- Create: `src/engine/salon-engine.ts`

**Step 1: Create the SalonEngine class**

Reference the logic in `src/room/room.ts` and adapt it. The class encapsulates `RoomState` and replaces callbacks with event emission.

```typescript
import { TypedEmitter } from "tiny-typed-emitter";
import type { AgentConfig, RoomConfig, RoomMessage } from "../core/types.js";
import { getSpeakerCandidates, peekNextSpeakerCandidates } from "../core/speaker.js";
import { evaluateChurn, type ChurnDecision } from "../core/churn.js";
import { buildMessages } from "../core/personality.js";
import { randomJoinGreeting, randomLeaveExcuse } from "../core/roster.js";
import { complete } from "./provider.js";

// ── Step options (same as before) ───────────────────────────────────

export interface StepOptions {
  verbose?: boolean;
  churn?: boolean;
  speaker?: AgentConfig;
}

// ── Typed events ────────────────────────────────────────────────────

interface SalonEvents {
  message: (msg: RoomMessage) => void;
  thinking: (agentName: string) => void;
  token: (agentName: string, token: string) => void;
  streamDone: (agentName: string) => void;
  rosterChange: (active: readonly AgentConfig[], benched: readonly AgentConfig[]) => void;
  stopped: () => void;
}

// ── Engine class ────────────────────────────────────────────────────

export class SalonEngine extends TypedEmitter<SalonEvents> {
  private config: RoomConfig;
  private _history: RoomMessage[];
  private _activeAgents: AgentConfig[];
  private _benchedAgents: AgentConfig[];
  private _turnCount: number;
  private _lastSpeaker: string | null;
  private _turnsSinceSpoke: Map<string, number>;
  private _running: boolean;
  private _abortController: AbortController;

  constructor(
    config: RoomConfig,
    allAgents: AgentConfig[],
    opts?: {
      preloadedHistory?: RoomMessage[];
      preferredRoster?: string[];
    },
  ) {
    super();
    this.config = config;
    this._history = opts?.preloadedHistory ? [...opts.preloadedHistory] : [];
    this._turnCount = 0;
    this._lastSpeaker = null;
    this._turnsSinceSpoke = new Map();
    this._running = false;
    this._abortController = new AbortController();

    // Partition agents into active/benched
    const preferredRoster = opts?.preferredRoster;
    if (preferredRoster && preferredRoster.length > 0) {
      const nameSet = new Set(preferredRoster);
      this._activeAgents = preferredRoster
        .map(n => allAgents.find(a => a.personality.name === n))
        .filter((a): a is AgentConfig => a !== undefined);
      this._benchedAgents = allAgents.filter(a => !nameSet.has(a.personality.name));
    } else {
      const initialCount = Math.min(
        config.maxAgents,
        Math.max(config.minAgents, Math.floor(allAgents.length * 0.5)),
      );
      const priorityAgents = [...allAgents]
        .filter(a => a.priority !== undefined)
        .sort((a, b) => a.priority! - b.priority!);
      const normalAgents = [...allAgents]
        .filter(a => a.priority === undefined)
        .sort(() => Math.random() - 0.5);
      const ordered = [...priorityAgents, ...normalAgents];
      this._activeAgents = ordered.slice(0, initialCount);
      this._benchedAgents = ordered.slice(initialCount);
    }
  }

  // ── Read-only queries ─────────────────────────────────────────────

  get activeAgents(): readonly AgentConfig[] { return this._activeAgents; }
  get benchedAgents(): readonly AgentConfig[] { return this._benchedAgents; }
  get history(): readonly RoomMessage[] { return this._history; }
  get isRunning(): boolean { return this._running; }
  get turnCount(): number { return this._turnCount; }
  get abortSignal(): AbortSignal { return this._abortController.signal; }

  // ── Lifecycle ─────────────────────────────────────────────────────

  open(): void {
    this._running = true;

    const openMsg: RoomMessage = {
      timestamp: new Date(),
      agent: "SYSTEM",
      content: `Topic: "${this.config.topic}"`,
      color: "gray",
      kind: "system",
    };
    this._history.push(openMsg);
    this.emit("message", openMsg);

    for (const agent of this._activeAgents) {
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: agent.personality.name,
        content: agent.personality.tagline,
        color: agent.personality.color,
        kind: "join",
        providerLabel: agent.providerName,
        modelLabel: agent.model,
      };
      this._history.push(msg);
      this.emit("message", msg);
      this._turnsSinceSpoke.set(agent.personality.name, 2);
    }

    this.emit("rosterChange", this._activeAgents, this._benchedAgents);
  }

  stop(): void {
    this._running = false;
    this._abortController.abort();
    this.emit("stopped");
  }

  // ── Commands ──────────────────────────────────────────────────────

  async step(opts: StepOptions = {}): Promise<AgentConfig | null> {
    if (!this._running) return null;

    const { verbose = false, churn = false, speaker: forcedSpeaker } = opts;

    this._turnCount++;
    for (const agent of this._activeAgents) {
      const name = agent.personality.name;
      this._turnsSinceSpoke.set(name, (this._turnsSinceSpoke.get(name) ?? 0) + 1);
    }

    // Evaluate churn
    if (churn && this._turnCount % this.config.churnIntervalTurns === 0) {
      this.applyChurn();
    }

    // Pick speaker
    const candidates = forcedSpeaker
      ? [forcedSpeaker]
      : getSpeakerCandidates(this._activeAgents, this._lastSpeaker, this._turnsSinceSpoke);

    if (candidates.length === 0) return null;
    const speaker = candidates[Math.floor(Math.random() * candidates.length)];

    await this.agentSpeak(speaker, verbose);

    return this._running ? speaker : null;
  }

  peekNextSpeaker(): AgentConfig | null {
    const candidates = peekNextSpeakerCandidates(
      this._activeAgents,
      this._lastSpeaker,
      this._turnsSinceSpoke,
    );
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  inject(text: string): void {
    const msg: RoomMessage = {
      timestamp: new Date(),
      agent: "YOU",
      content: text.trim(),
      color: "whiteBright",
      kind: "user",
    };
    this._history.push(msg);
    this.emit("message", msg);
  }

  shuffle(): void {
    // Emit leave messages for current agents
    for (const agent of this._activeAgents) {
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: agent.personality.name,
        content: randomLeaveExcuse(),
        color: agent.personality.color,
        kind: "leave",
      };
      this._history.push(msg);
      this.emit("message", msg);
    }

    // Pool everyone and re-pick
    const allAgents = [...this._activeAgents, ...this._benchedAgents];
    const initialCount = Math.min(
      this.config.maxAgents,
      Math.max(this.config.minAgents, Math.floor(allAgents.length * 0.5)),
    );

    const priorityAgents = [...allAgents]
      .filter(a => a.priority !== undefined)
      .sort((a, b) => a.priority! - b.priority!);
    const normalAgents = [...allAgents]
      .filter(a => a.priority === undefined)
      .sort(() => Math.random() - 0.5);

    const ordered = [...priorityAgents, ...normalAgents];
    this._activeAgents = ordered.slice(0, initialCount);
    this._benchedAgents = ordered.slice(initialCount);
    this._lastSpeaker = null;
    this._turnsSinceSpoke.clear();

    // Emit join messages for new agents
    for (const agent of this._activeAgents) {
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: agent.personality.name,
        content: `${agent.personality.tagline} — ${randomJoinGreeting()}`,
        color: agent.personality.color,
        kind: "join",
        providerLabel: agent.providerName,
        modelLabel: agent.model,
      };
      this._history.push(msg);
      this.emit("message", msg);
      this._turnsSinceSpoke.set(agent.personality.name, 2);
    }

    this.emit("rosterChange", this._activeAgents, this._benchedAgents);
  }

  // ── Private helpers ───────────────────────────────────────────────

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
        a => a.personality.name !== agent.personality.name,
      );
      this._benchedAgents.push(agent);

      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: agent.personality.name,
        content: excuse,
        color: agent.personality.color,
        kind: "leave",
      };
      this._history.push(msg);
      this.emit("message", msg);
    }

    if (decision.join) {
      const { agent, greeting } = decision.join;
      this._benchedAgents = this._benchedAgents.filter(
        a => a.personality.name !== agent.personality.name,
      );
      this._activeAgents.push(agent);
      this._turnsSinceSpoke.set(agent.personality.name, 3);

      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: agent.personality.name,
        content: `${agent.personality.tagline} — ${greeting}`,
        color: agent.personality.color,
        kind: "join",
        providerLabel: agent.providerName,
        modelLabel: agent.model,
      };
      this._history.push(msg);
      this.emit("message", msg);
    }

    if (decision.leave || decision.join) {
      this.emit("rosterChange", this._activeAgents, this._benchedAgents);
    }
  }

  private async agentSpeak(agent: AgentConfig, verbose: boolean): Promise<void> {
    const messages = buildMessages(
      agent,
      this.config.topic,
      this._history,
      this.config.contextWindow,
      verbose,
      this.config.language,
    );

    const maxTokens = verbose
      ? Math.max(this.config.maxTokens * 2, 2048)
      : this.config.maxTokens;

    const name = agent.personality.name;
    this.emit("thinking", name);

    try {
      const result = await complete(
        agent.provider,
        { model: agent.model, messages, temperature: agent.temperature ?? 0.9, maxTokens },
        {
          onToken: (token) => this.emit("token", name, token),
          onDone: () => this.emit("streamDone", name),
        },
        { baseUrl: agent.baseUrl, apiKey: agent.apiKey, signal: this._abortController.signal },
      );

      const raw = result.content.trim();
      const selfPrefixRe = new RegExp(`^${name}\\s*[:\\-—]\\s*`, "i");
      const content = raw.replace(selfPrefixRe, "").trim();

      if (!content) {
        const msg: RoomMessage = {
          timestamp: new Date(),
          agent: "SYSTEM",
          content: `[${name} returned an empty response]`,
          color: "gray",
          kind: "system",
        };
        this._history.push(msg);
        this.emit("message", msg);
        return;
      }

      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: name,
        content,
        color: agent.personality.color,
        kind: "chat",
      };
      this._history.push(msg);
      this.emit("message", msg);

      this._lastSpeaker = name;
      this._turnsSinceSpoke.set(name, 0);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      const msg: RoomMessage = {
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `[${name} error: ${err.message}]`,
        color: "gray",
        kind: "system",
      };
      this._history.push(msg);
      this.emit("message", msg);
    }
  }
}

// ── Abort-aware sleep (used by TUI/interface for pacing) ────────────

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
```

**Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: Errors from old files (they haven't been updated yet), but salon-engine.ts and all core/ files should compile cleanly. Check for errors only in `src/core/` and `src/engine/` paths.

**Step 3: Commit**

```bash
git add src/engine/salon-engine.ts
git commit -m "feat(engine): create SalonEngine class with TypedEmitter"
```

---

## Task 11: Create `src/tui/colors.ts` — Color mapping

**Files:**
- Create: `src/tui/colors.ts`

**Step 1: Create the color mapping module**

```typescript
import type { AgentColor } from "../core/types.js";

// ── Semantic color to Ink color mapping ─────────────────────────────
// AgentColor values are already valid Ink color names (by design),
// so this is an identity mapping. We keep it explicit in case
// ink changes or we need overrides.

export function toInkColor(color: AgentColor): string {
  return color;
}
```

Since `AgentColor` values are identical to Ink color names, the mapping is trivial. But having the function establishes the pattern for other interfaces (web → CSS classes, etc.).

**Step 2: Commit**

```bash
git add src/tui/colors.ts
git commit -m "feat(tui): add semantic-to-ink color mapping"
```

---

## Task 12: Create `src/tui/app.tsx` — Refactored TUI component

Rewrite the TUI to subscribe directly to SalonEngine events. This is the largest single task.

**Files:**
- Create: `src/tui/app.tsx`

**Step 1: Create the refactored TUI**

Start from `src/cli/tui.tsx` (703 lines) and make these changes:

1. **Update imports:**
   - `from "../types.js"` → `from "../core/types.js"`
   - Add: `import type { SalonEngine } from "../engine/salon-engine.js"`
   - Add: `import { toInkColor } from "./colors.js"`

2. **Replace `ansiToInk()` calls** with `toInkColor()`:
   - In `ChatMessage`: `const inkColor = ansiToInk(msg.color)` → `const inkColor = toInkColor(msg.color)`
   - In `WhoTable`: `ansiToInk(a.personality.color)` → `toInkColor(a.personality.color)`
   - In `StatusBar`: `ansiToInk(a.color)` → `toInkColor(a.color)` (but note StatusBar takes `{ name: string; color: string }[]` — update to `AgentColor`)
   - In agent activity indicator: `ansiToInk(agentActivity.color)` → `toInkColor(agentActivity.color)`

3. **Remove the old ANSI_TO_INK map** (lines 25-46) and the `ansiToInk` function entirely.

4. **Remove module-level event queue** (lines 375-383): Delete `eventQueue`, `eventFlush`, `emitTuiEvent`.

5. **Remove `TuiHandle` interface** (lines 346-361) — no longer needed.

6. **Remove `TuiEvent` type** (lines 366-373).

7. **Change App props:** Replace `onUserInput` callback with `engine: SalonEngine` prop and add an `onUserInput` for the mode loop's input buffer:

```typescript
interface AppProps extends TuiProps {
  engine: SalonEngine;
  onUserInput: (line: string) => void;
  onQuit: () => void;
}
```

8. **Replace the event processing `useEffect`** (lines 416-528) with engine subscriptions:

```typescript
useEffect(() => {
  const onMessage = (msg: RoomMessage) => {
    // If this is a chat message matching the streaming agent, skip (handled by streamDone)
    if (
      msg.kind === "chat" &&
      streamingRef.current &&
      streamingRef.current.agent === msg.agent
    ) return;

    const id = nextId.current++;
    setMessages((prev) => [...prev, { id, msg }]);
  };

  const onThinking = (agent: string) => {
    const id = nextId.current++;
    const color = getAgentColor(agent);
    const placeholder: RoomMessage = {
      timestamp: new Date(),
      agent,
      content: "",
      color,
      kind: "chat",
    };
    streamingRef.current = { agent, color, id, buffer: "" };
    setMessages((prev) => [
      ...prev,
      { id, msg: placeholder, streamContent: "", isStreaming: true },
    ]);
    setAgentActivity({ agent, color, phase: "thinking" });
  };

  const onToken = (agent: string, token: string) => {
    const sr = streamingRef.current;
    if (sr && sr.agent === agent) {
      if (sr.buffer.length === 0) {
        setAgentActivity((prev) =>
          prev && prev.agent === agent ? { ...prev, phase: "responding" } : prev,
        );
      }
      sr.buffer += token;
    }
  };

  const onStreamDone = (agent: string) => {
    const sr = streamingRef.current;
    if (sr && sr.agent === agent) {
      const finalContent = sr.buffer;
      const finalId = sr.id;
      streamingRef.current = null;
      setMessages((prev) =>
        prev.map((dm) =>
          dm.id === finalId
            ? { ...dm, msg: { ...dm.msg, content: finalContent }, streamContent: undefined, isStreaming: false }
            : dm,
        ),
      );
      setAgentActivity(null);
    }
  };

  const onRosterChange = (active: readonly AgentConfig[]) => {
    setActiveAgents([...active]);
    mentionColorMap.clear();
    for (const a of active) {
      mentionColorMap.set(a.personality.name, toInkColor(a.personality.color));
    }
  };

  engine.on("message", onMessage);
  engine.on("thinking", onThinking);
  engine.on("token", onToken);
  engine.on("streamDone", onStreamDone);
  engine.on("rosterChange", onRosterChange);

  return () => {
    engine.off("message", onMessage);
    engine.off("thinking", onThinking);
    engine.off("token", onToken);
    engine.off("streamDone", onStreamDone);
    engine.off("rosterChange", onRosterChange);
  };
}, [engine]);
```

9. **Add helper to resolve agent color from the engine's active agents:**

```typescript
const getAgentColor = (agentName: string): AgentColor => {
  const agent = engine.activeAgents.find(a => a.personality.name === agentName);
  return agent?.personality.color ?? "white";
};
```

10. **Keep** the mentionColorMap module-level variable, the renderContent function, the 50ms streaming flush timer, all rendering components (Header, ChatMessage, WhoTable, StatusBar, InputLine), and the handleSubmit callback.

11. **Update `StatusBar` props** to use `AgentColor`:
```typescript
function StatusBar({ agents }: { agents: { name: string; color: AgentColor }[] }) {
```

12. **Update `agentActivity` state type:**
```typescript
const [agentActivity, setAgentActivity] = useState<{
  agent: string;
  color: AgentColor;
  phase: "thinking" | "responding";
} | null>(null);
```

13. **Update `streamingRef` type:**
```typescript
const streamingRef = useRef<{
  agent: string;
  color: AgentColor;
  id: number;
  buffer: string;
} | null>(null);
```

14. **`/who` command:** Instead of calling `onUserInput("\x00WHO")`, directly call:
```typescript
if (trimmed === "/who") {
  setWhoDisplay([...engine.activeAgents]);
  setTimeout(() => setWhoDisplay(null), 8000);
  return;
}
```

15. **Update `renderTui` function:**

```typescript
export interface TuiInstance {
  waitUntilExit: () => Promise<void>;
}

export function renderTui(
  props: TuiProps & { engine: SalonEngine },
  onUserInput: (line: string) => void,
  onQuit: () => void,
): TuiInstance {
  const instance = render(
    <App {...props} engine={props.engine} onUserInput={onUserInput} onQuit={onQuit} />,
  );

  return {
    waitUntilExit: () => instance.waitUntilExit() as Promise<void>,
  };
}
```

No more `handle` — the TUI subscribes to engine events directly.

**Step 2: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): rewrite TUI as engine event subscriber"
```

---

## Task 13: Create `src/tui/main.ts` — Thin TUI entry point

Rewrite the main entry point as a thin shell using SalonEngine.

**Files:**
- Create: `src/tui/main.ts`

**Step 1: Create the thin main**

Port the logic from `src/main.ts` (352 lines). The room setup logic (args, prompts, resume) stays; the engine orchestration is simplified.

Key changes from old main.ts:
- No more `inputBuffer` as a separate variable — use a shared buffer
- No more `RoomCallbacks` wiring — engine emits events
- No more `streamingAgent` tracking — engine handles it
- No more `agentColorMap` — engine has semantic colors
- `saveActiveRoster` subscribes to `rosterChange` event
- Mode loop uses `engine.step()` and `engine.inject()`
- `pickNextSpeakerPreview()` → `engine.peekNextSpeaker()`

The full file is ~280 lines. Structure:

```typescript
import { createInterface } from "readline";
import { PERSONALITY_PRESETS } from "../core/roster.js";
import { loadConfig, resolveRoster } from "../engine/config.js";
import { SalonEngine, sleepAbortable } from "../engine/salon-engine.js";
import type { StepOptions } from "../engine/salon-engine.js";
import {
  loadRoomMeta, saveRoomMeta, loadSeedMaterial, loadPreviousSessions,
  nextSessionNumber, parseSeedToMessages, roomExists, createRoomDir,
  TranscriptWriter,
} from "../engine/persist.js";
import { renderTui } from "./app.js";
import type { RoomConfig, RoomMessage, AgentColor } from "../core/types.js";

function ask(prompt: string): Promise<string> { /* same as before */ }

async function main() {
  // Parse args (same as before, lines 40-51)
  // Load config + roster (same but new import paths)
  // Room setup (same: roomName, topic, language, history, resume logic)
  // Session + transcript setup (same)

  const config: RoomConfig = { ...salonConfig.room, topic, language };
  const engine = new SalonEngine(config, roster, {
    preloadedHistory: preloadedHistory,
    preferredRoster: savedRoster,
  });

  // Wire persistence via events
  const transcript = new TranscriptWriter(roomName, session, topic);
  await transcript.init(roster.map(a => a.personality.name));
  engine.on("message", (msg) => transcript.append(msg));
  engine.on("rosterChange", async (active) => {
    const m = await loadRoomMeta(roomName);
    if (m) {
      m.activeRoster = [...active].map(a => a.personality.name);
      await saveRoomMeta(roomName, m);
    }
  });

  // Clean stdin
  process.stdin.removeAllListeners();
  process.stdin.pause();

  // Input buffer + quit flag
  const inputBuffer: string[] = [];
  let wantsQuit = false;

  const handleUserInput = (line: string) => { inputBuffer.push(line); };
  const handleQuit = () => { wantsQuit = true; engine.stop(); };

  // Mount TUI
  const tui = renderTui(
    { roomName, session, topic, resumed: isResumed, contextCount: preloadedHistory.length, engine },
    handleUserInput,
    handleQuit,
  );

  process.on("SIGINT", async () => {
    engine.stop();
    wantsQuit = true;
    await transcript.finalize();
    process.exit(0);
  });

  // Show resume history (same logic but use engine.activeAgents for colors)
  // ... (port the resume history display logic, using engine events)

  // Open room
  engine.open();

  // Mode loop
  let governed = true;
  // NOTE: The TUI no longer has setGoverned — governed state is managed
  // by the mode loop emitting system messages. The TUI reads governed
  // from a ref or we add a small governed-state event.

  while (engine.isRunning && !wantsQuit) {
    const nextSpeaker = engine.peekNextSpeaker();

    if (governed) {
      // Same governed loop logic as old main.ts but using engine methods
      // engine.inject(), engine.step(), engine.shuffle()
    } else {
      // Same free loop logic
    }
  }

  await transcript.finalize();
  setTimeout(() => process.exit(0), 100);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
```

**Important detail: governed mode display.** The TUI needs to know if we're in governed or free mode to display the status bar. Two options:
- (A) Pass `governed` as a prop that updates via state — requires the TUI to have a way to receive updates. Simplest: add a `setGoverned` event to the engine (even though it's a TUI concept) or pass a ref.
- (B) The TUI subscribes to a system message that indicates mode changes.

Pragmatic choice: **Keep a simple governed state callback in the TUI.** The `renderTui` returns a minimal handle with just `setGoverned` and `pushSystemMessage` for the resume history and mode display. This is a TUI-specific concern, not an engine event.

Updated `renderTui` return type:
```typescript
export interface TuiInstance {
  setGoverned: (governed: boolean) => void;
  pushSystemMessage: (msg: RoomMessage) => void;
  waitUntilExit: () => Promise<void>;
}
```

This keeps the TUI's governed display working without polluting the engine with UI concepts.

**Step 2: Update `src/tui/app.tsx`** to expose `setGoverned` and `pushSystemMessage` via a lightweight event mechanism (a simple callback ref, not the old event queue).

**Step 3: Type check**

Run: `npx tsc --noEmit`

Expected: The new tui/ files should compile. Old files will have errors (they're about to be deleted).

**Step 4: Commit**

```bash
git add src/tui/main.ts
git commit -m "feat(tui): create thin main entry point using SalonEngine"
```

---

## Task 14: Update `src/cli/simulate.ts` — Use SalonEngine

**Files:**
- Modify: `src/cli/simulate.ts`

**Step 1: Rewrite simulate to use SalonEngine**

Change imports and replace manual room function calls with engine usage:

```typescript
import { PERSONALITY_PRESETS } from "../core/roster.js";
import { loadConfig, resolveRoster } from "../engine/config.js";
import { SalonEngine } from "../engine/salon-engine.js";
import type { RoomConfig, RoomMessage } from "../core/types.js";

// ... (arg parsing stays the same)

async function simulate() {
  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);
  const language = langFlag ?? salonConfig.room.language;

  // ... (stderr output stays the same)

  const config: RoomConfig = { ...salonConfig.room, topic, language };
  const engine = new SalonEngine(config, roster);

  const allMessages: RoomMessage[] = [];
  let chatCount = 0;

  engine.on("message", (msg) => { allMessages.push(msg); });

  engine.open();

  while (chatCount < targetMessages) {
    await engine.step({ verbose: true, churn: false });

    const newCount = allMessages.filter(m => m.kind === "chat").length;
    if (newCount > chatCount) {
      chatCount = newCount;
      const last = allMessages.filter(m => m.kind === "chat").at(-1)!;
      process.stderr.write(`  [${chatCount}/${targetMessages}] ${last.agent}\n`);
    }
  }

  // ... (markdown report rendering stays the same)
}
```

**Step 2: Commit**

```bash
git add src/cli/simulate.ts
git commit -m "refactor(cli): update simulate to use SalonEngine"
```

---

## Task 15: Update `src/cli/models.ts` — Update imports

**Files:**
- Modify: `src/cli/models.ts`

**Step 1: Update imports**

```typescript
// change
import { loadConfig } from "../config/loader.js";
import { listModels } from "../providers/provider.js";
// to:
import { loadConfig } from "../engine/config.js";
import { listModels } from "../engine/provider.js";
```

No other changes needed.

**Step 2: Commit**

```bash
git add src/cli/models.ts
git commit -m "refactor(cli): update models.ts imports to engine layer"
```

---

## Task 16: Update `src/cli/shuffle-personas.ts` — Semantic colors

**Files:**
- Modify: `src/cli/shuffle-personas.ts`

**Step 1: Update color resolution**

The `resolveColor` function currently converts color names to ANSI escape codes. After the refactor, it should return semantic `AgentColor` names instead.

Replace the `COLOR_NAME_MAP` and `resolveColor` function:

```typescript
import type { AgentColor } from "../core/types.js";

const COLOR_NAME_MAP: Record<string, AgentColor> = {
  cyan:            "cyan",
  yellow:          "yellow",
  magenta:         "magenta",
  green:           "green",
  blue:            "blue",
  red:             "red",
  "bright-red":    "redBright",
  "bright-yellow": "yellowBright",
  "bright-green":  "greenBright",
  "bright-cyan":   "cyanBright",
  "bright-magenta":"magentaBright",
};

const COLOR_CYCLE: AgentColor[] = [
  "cyan", "yellow", "magenta", "green", "blue",
  "redBright", "yellowBright", "greenBright",
];

function resolveColor(raw: string | undefined, index: number): AgentColor {
  if (!raw) return COLOR_CYCLE[index % COLOR_CYCLE.length];
  // If it's already a valid AgentColor name, use it
  const mapped = COLOR_NAME_MAP[raw.toLowerCase()];
  return mapped ?? COLOR_CYCLE[index % COLOR_CYCLE.length];
}
```

**Step 2: Commit**

```bash
git add src/cli/shuffle-personas.ts
git commit -m "refactor(cli): update shuffle-personas to use semantic colors"
```

---

## Task 17: Update `src/cli/podcast.ts` — Update imports

**Files:**
- Modify: `src/cli/podcast.ts`

**Step 1: Update imports**

Podcast reads transcripts via persist.ts. Update the import path:

```typescript
// Look for any imports from "../room/persist.js" or "../types.js"
// Change to "../engine/persist.js" and "../core/types.js"
```

If podcast.ts doesn't import from those paths (it may only read files directly), no changes needed. Check the file first.

**Step 2: Commit if changed**

```bash
git add src/cli/podcast.ts
git commit -m "refactor(cli): update podcast.ts imports to new layer paths"
```

---

## Task 18: Update entry points and clean up

**Files:**
- Modify: `package.json` — update `scripts.start` and `scripts.dev`
- Modify: `justfile` — update all `bun run src/main.ts` references
- Delete: `src/main.ts` (old entry point)
- Delete: `src/types.ts` (replaced by `src/core/types.ts`)
- Delete: `src/room/room.ts` (replaced by `src/engine/salon-engine.ts`)
- Delete: `src/room/persist.ts` (moved to `src/engine/persist.ts`)
- Delete: `src/agents/personality.ts` (moved to `src/core/personality.ts`)
- Delete: `src/agents/roster.ts` (moved to `src/core/roster.ts`)
- Delete: `src/providers/provider.ts` (moved to `src/engine/provider.ts`)
- Delete: `src/config/loader.ts` (moved to `src/engine/config.ts`)
- Delete: `src/cli/tui.tsx` (replaced by `src/tui/app.tsx`)

**Step 1: Update package.json**

```json
"scripts": {
  "start": "bun run src/tui/main.ts",
  "dev": "bun --watch run src/tui/main.ts",
  "models": "bun run src/cli/models.ts"
}
```

**Step 2: Update justfile**

Change all `bun run src/main.ts` to `bun run src/tui/main.ts`:
- Line 12: `bun run src/tui/main.ts {{name}}`
- Line 16: `bun run src/tui/main.ts`

**Step 3: Delete old files**

```bash
rm src/main.ts
rm src/types.ts
rm -rf src/room/
rm -rf src/agents/
rm -rf src/providers/
rm -rf src/config/
rm src/cli/tui.tsx
```

**Step 4: Type check the entire project**

Run: `npx tsc --noEmit`

Expected: PASS — zero errors. All imports should resolve to new layer paths.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: complete layer migration, delete old files"
```

---

## Task 19: Final verification

**Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 2: Verify directory structure**

Run: `find src -name '*.ts' -o -name '*.tsx' | sort`

Expected:
```
src/cli/models.ts
src/cli/podcast.ts
src/cli/shuffle-personas.ts
src/cli/simulate.ts
src/core/churn.ts
src/core/personality.ts
src/core/roster.ts
src/core/speaker.ts
src/core/types.ts
src/engine/config.ts
src/engine/persist.ts
src/engine/provider.ts
src/engine/salon-engine.ts
src/tui/app.tsx
src/tui/colors.ts
src/tui/main.ts
```

**Step 3: Smoke test**

Run: `bun run src/tui/main.ts --help` or `just start` — verify the app launches without errors.

Run: `just models` — verify models listing works.

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: post-migration cleanup"
```

---

## Summary: File mapping (old → new)

| Old | New | Change |
|-----|-----|--------|
| `src/types.ts` | `src/core/types.ts` | Add `AgentColor`, change `color` fields |
| `src/agents/personality.ts` | `src/core/personality.ts` | Move, remove `shouldSpeak` |
| `src/agents/roster.ts` | `src/core/roster.ts` | Move, semantic colors |
| — | `src/core/speaker.ts` | **New** — extracted pure functions |
| — | `src/core/churn.ts` | **New** — extracted pure function |
| `src/room/room.ts` | `src/engine/salon-engine.ts` | **Rewrite** as SalonEngine class |
| `src/room/persist.ts` | `src/engine/persist.ts` | Move, semantic colors |
| `src/providers/provider.ts` | `src/engine/provider.ts` | Move, update imports |
| `src/config/loader.ts` | `src/engine/config.ts` | Move, update imports |
| `src/main.ts` | `src/tui/main.ts` | **Rewrite** as thin shell |
| `src/cli/tui.tsx` | `src/tui/app.tsx` | **Rewrite** as engine subscriber |
| — | `src/tui/colors.ts` | **New** — color mapping |
| `src/cli/simulate.ts` | `src/cli/simulate.ts` | Update to use SalonEngine |
| `src/cli/models.ts` | `src/cli/models.ts` | Update imports |
| `src/cli/shuffle-personas.ts` | `src/cli/shuffle-personas.ts` | Semantic colors |
| `src/cli/podcast.ts` | `src/cli/podcast.ts` | Update imports (if needed) |
