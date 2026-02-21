# k2-salon — TODO

## Uncommitted changes in progress

The following files have been modified since the last commit (`7b57b6c`) but are
not yet committed. These changes are **partial** — they compile but the TUI work
they were preparing for is not complete:

- **`src/types.ts`** — Added `providerLabel?` and `modelLabel?` to `RoomMessage`.
  Added `maxTokens` to `RoomConfig`.
- **`src/room/room.ts`** — Changed `RoomCallbacks` from blocking `onUserTurn`
  to non-blocking `pollUserInput`. Room loop now polls between turns instead of
  blocking. Uses `state.config.maxTokens` instead of hardcoded 300.
- **`src/main.ts`** — Added non-blocking `inputBuffer` + `startInputListener()`.
  Replaced `onUserTurn` callback with `pollUserInput`. Removed `renderUserPrompt`
  import (no longer needed). The `/who` sentinel (`\x00WHO`) is handled in the
  poll function.
- **`salon.yaml`** — Added `maxTokens: 1024` to room settings. Added `moonshot`
  provider with `${MOONSHOT_API_KEY}`.
- **`src/config/loader.ts`** — Added `maxTokens: 1024` to `DEFAULT_CONFIG`.
- **`package.json`** — Added `ink`, `react`, `ink-text-input`, `@types/react`
  as dependencies (installed but not yet used).
- **`tsconfig.json`** — Added `"jsx": "react-jsx"` and `"@types/react"` to types.
- **`.gitignore`** — Added `rooms/` exclusion.

---

## Task 1: Replace CLI renderer with ink TUI

### Problem
The current `src/cli/renderer.ts` writes directly to stdout with ANSI codes.
Agent output and user input share the same stdout stream, so you can't type
while agents are talking. It doesn't feel like a real chat room.

### Solution
Replace the renderer with an **ink** (React for CLI) TUI that has:
- A **scrollable chat pane** at the top that auto-scrolls as messages arrive
- A **fixed input line** at the bottom that's always visible and always accepts
  keystrokes, even while agents are streaming
- A **header bar** showing room name, session number, topic
- A **status bar** showing who's in the room

### Layout
```
╔══════════════════════════════════════════════════════════╗
║  k2-salon — ai-thoughts  session 1                      ║
╠══════════════════════════════════════════════════════════╣
│ 09:30 -->> Sage has joined (Stoic philosopher ·          │
│            zen/claude-sonnet-4-6)                         │
│ 09:30 -->> Wren has joined (Devil's advocate ·            │
│            openrouter/gemini-3.1-pro)                     │
│                                                          │
│ <Sage> The real question is whether...                    │  ← scrolls
│ <Wren> But Sage, you're assuming...                       │
│                                                          │
│  In room: Sage, Wren, Riko, DocK                         │
├──────────────────────────────────────────────────────────┤
│ > type here anytime, or just watch_                      │  ← always visible
╚══════════════════════════════════════════════════════════╝
```

### Implementation plan
1. Create `src/cli/tui.tsx` — ink component tree:
   - `<App>` — top-level, holds all state (messages array, streaming state,
     active agents list)
   - `<Header>` — room name, session, topic
   - `<ChatPane>` — scrollable area rendering messages. Needs to handle:
     - System messages (dim, with *)
     - Join/leave messages (-->> / <<--, with provider/model info)
     - Chat messages (colored `<Name>` prefix + content)
     - User messages (`<YOU>` prefix)
     - Streaming: the last message may be "in progress" (tokens appending)
   - `<StatusBar>` — "In room: Sage, Wren, ..." (updates on join/leave)
   - `<InputLine>` — uses `ink-text-input`, always focused. Enter submits.
2. Rewrite `src/main.ts`:
   - Room resolution logic (room name, topic, seed, resume) stays the same
     but must happen **before** `render(<App />)` since ink takes over stdin.
   - Use `ink`'s `render()` to mount the TUI.
   - The room engine runs in the background. Callbacks push messages into
     React state (via a ref or event emitter).
   - The `pollUserInput` callback reads from a shared buffer that the
     `<InputLine>` component writes to on Enter.
3. Delete `src/cli/renderer.ts` — replaced entirely by the TUI.

### Dependencies already installed
- `ink@6.8.0`, `react@19.2.4`, `ink-text-input@6.0.0`, `@types/react`
- `tsconfig.json` already has `"jsx": "react-jsx"`

### Key considerations
- **Streaming**: agent tokens arrive one-by-one via `onStreamToken`. The TUI
  needs to append tokens to the last message in the chat pane in real-time
  without causing full re-renders on every token. Use a ref for the streaming
  buffer, flush to state periodically (e.g. every 50ms or on newline).
- **Input during streaming**: ink's `useInput` or `ink-text-input` captures
  keystrokes independently from stdout. This is the whole point — you can type
  while agents are talking.
- **Auto-scroll**: the chat pane should auto-scroll to bottom when new messages
  arrive. If using `ink-scroll-view`, call `scrollToEnd()` on new messages.
  Alternatively, just render the last N lines that fit the terminal height.
- **Terminal resize**: ink handles this via Yoga layout. The chat pane should
  use `flexGrow: 1` to fill available space.

---

## Task 2: Show provider/model on join + enhance /who

### Problem
When agents join, you only see their personality name and tagline. You can't
tell which model is behind which personality without checking `salon.yaml`.

### Solution

**Join messages** should show provider/model:
```
09:30 -->> Sage has joined (Stoic philosopher · zen/claude-sonnet-4-6)
```

**`/who` command** should show a full table:
```
  Sage    zen/claude-sonnet-4-6       Stoic philosopher
  Wren    openrouter/gemini-3.1-pro   Devil's advocate
  Riko    moonshot/kimi-k2.5          Startup founder
  DocK    fractal/gpt-oss-20b         Research scientist
  Jules   ollama/qwen3:8b             Retired diplomat
```

### Implementation

1. **`src/types.ts`** — `RoomMessage` already has `providerLabel?` and
   `modelLabel?` fields (added in uncommitted changes). These are optional
   so existing code doesn't break.

2. **`src/room/room.ts`** — When creating join messages (both in `runRoom`
   initial joins at line 227-238, and in `evaluateChurn` at line 108-117),
   populate `providerLabel` and `modelLabel` from the `AgentConfig`. The
   `AgentConfig` doesn't currently carry the provider *key name* from
   salon.yaml (it only has the `ProviderKind` like "openai-compat"). We
   need to either:
   - Add a `providerName` field to `AgentConfig` (the key from salon.yaml,
     e.g. "zen", "moonshot", "fractal") — **recommended**
   - Or resolve it from baseUrl (fragile)

   So: add `providerName?: string` to `AgentConfig` in types.ts, populate
   it in `resolveRoster()` in loader.ts, then use it in join messages.

3. **TUI `<ChatPane>`** — render join messages with the provider/model suffix.

4. **`/who` handling** — in the TUI, when the user types `/who`, instead of
   injecting into the room history, render a formatted table in the chat
   pane as a local-only system message. The table needs access to the full
   `AgentConfig` for each active agent (not just name/color). Pass the
   roster or active agents list to the TUI component.

### Data flow for /who
The `RoomState.activeAgents` array has full `AgentConfig` objects. The TUI
needs access to this. Either:
- Pass a `getActiveAgents()` callback to the TUI
- Or maintain a parallel list in React state, updated via callbacks

---

## Task 3: Tighten system prompt for natural brevity

### Problem
Some models write multi-paragraph essays. The `maxTokens` limit causes hard
cutoffs mid-sentence ("Wren, you got cut off too"), which feels unnatural.

### Solution
Two-part approach:
1. **Strengthen the system prompt** — make brevity rules much more explicit
2. **Lower `maxTokens` to 512** as a safety net (rarely triggers if prompt
   works)

### Changes to `src/agents/personality.ts`

Replace the current brevity line (line 16):
```
`- Keep responses concise (2-4 sentences typically, occasionally longer for important points).`,
```

With stronger rules:
```
`- LENGTH: 2-4 sentences MAX. This is a fast-moving chat room, not a blog post.`,
`- Write like you're texting in a group chat — short, punchy, conversational.`,
`- NEVER write bullet points, numbered lists, or markdown headers.`,
`- NEVER write more than one short paragraph. If the topic needs depth, you'll get another turn.`,
`- If you catch yourself writing a wall of text, stop and pick your single best point.`,
```

### Changes to `salon.yaml`
Change `maxTokens: 1024` to `maxTokens: 512`.

Also change in `src/config/loader.ts` DEFAULT_CONFIG.

512 tokens is ~380 words, well above 4 sentences (~60-80 words). It serves
as a safety rail for runaway models but should almost never cause a visible
cutoff if the prompt is doing its job.

---

## Task 4: Commit and clean up

After all tasks are complete:
1. Remove `src/cli/renderer.ts` (replaced by TUI)
2. Type-check: `npx tsc --noEmit`
3. Smoke test: `salon room ai-thoughts`
4. Commit all changes

---

## Reference: Current file structure

```
k2-salon/
  src/
    main.ts                  # Entry point — room lifecycle, currently uses old renderer
    types.ts                 # Shared types
    providers/
      provider.ts            # Unified LLM client (openrouter, openai-compat, ollama)
    agents/
      personality.ts         # System prompt builder, turn logic
      roster.ts              # 8 built-in personality presets
    config/
      loader.ts              # YAML config loader, env var resolution
    room/
      room.ts                # Conversation engine, turn-taking, churn
      persist.ts             # Transcript writer, session loader, seed parser
    cli/
      renderer.ts            # OLD IRC-style renderer (to be replaced by tui.tsx)
      models.ts              # `just models` command (keep as-is)
  completions/
    k2-salon.fish            # Fish shell completions + salon wrapper
  salon.yaml                 # Provider + roster config
  justfile                   # Task runner
  BRAINSTORM.md              # Design decisions and architecture
```

## Reference: Current roster (salon.yaml)

| Agent | Provider | Model |
|-------|----------|-------|
| Sage | zen | claude-sonnet-4-6 |
| Wren | openrouter | google/gemini-3.1-pro-preview |
| Riko | moonshot | kimi-k2.5 |
| DocK | fractal | gpt-oss-20b |
| Jules | ollama | qwen3:8b |

## Reference: Available personalities (src/agents/roster.ts)

8 presets: Sage, Riko, Nova, DocK, Wren, Jules, Chip, Ora.
Only Sage, Wren, Riko, DocK, Jules are in the current default roster.
