# Agent context for k2-salon

This file helps AI coding agents pick up context quickly when resuming work.

## Project documentation structure

- **BRAINSTORM.md** -- Ideas, requirements, design decisions, rationale.
  Read this to understand *why* things are built the way they are.
- **TODO.md** -- Pending work only. Completed tasks are removed.
  Each item has problem, solution, and files-to-change sections.
- **AGENTS.md** -- (this file) Project navigation, code style, architecture,
  how to do common tasks. Read this first when starting a session.
- **README.md** -- User-facing documentation (usage, config, setup).

## What this project is

Multi-AI debate room. Different LLM personalities (Sage, Wren, Riko, etc.)
discuss topics in a real-time IRC-style TUI built with ink (React for CLI).
Users can watch, chime in, or just lurk. Agents join/leave dynamically.

## Architecture

```
src/
  main.ts              Entry point. Pre-TUI setup (room resolution, topic
                       prompt via readline), then mounts ink TUI and runs
                       room engine in background. Readline is created lazily
                       per-question and destroyed before ink takes stdin.

  types.ts             All shared types. Key ones:
                       - AgentConfig (personality + provider + model)
                       - RoomMessage (chat/join/leave/system/user + metadata)
                       - RoomConfig, SalonConfig, ProviderEntry, RosterEntry

  cli/tui.tsx          Ink TUI. Components: Header, ChatMessage, WhoTable,
                       StatusBar, InputLine. Communicates with room engine
                       via module-level event queue (emitTuiEvent/eventFlush).
                       Streaming tokens buffered in ref, flushed to state
                       every 50ms. Messages sliced to terminal height.

  cli/models.ts        Standalone `just models` command. Not part of TUI.

  room/room.ts         Conversation engine. Main loop: pick speakers via
                       weighted probability (chattiness + recency), generate
                       responses with streaming, poll for user input
                       (non-blocking). Churn system for agent join/leave.

  room/persist.ts      Transcript writer (markdown with frontmatter), session
                       loader, seed material parser. Room data in rooms/<name>/.

  agents/personality.ts System prompt builder + shouldSpeak() logic.
                       Brevity rules are aggressive (2-4 sentences max).

  agents/roster.ts     8 built-in personality presets. Leave/join excuses.

  config/loader.ts     YAML config loader. Resolves ${ENV_VAR} patterns.
                       resolveRoster() maps roster entries to AgentConfig
                       with provider details (including providerName, temp).

  providers/provider.ts Unified LLM client. Three backends: openrouter,
                       openai-compat, ollama. SSE streaming for first two,
                       NDJSON for ollama. Temperature retry fallback in
                       openai-compat (some models reject non-1 temperature).
```

## Code style

- **Language**: TypeScript, strict mode, ESM (`"type": "module"`)
- **Runtime**: Bun (not Node). Use `bun run` to execute.
- **JSX**: React JSX via `react-jsx` transform (no `React.createElement`)
- **Imports**: Use `.js` extensions in import paths (ESM requirement with
  bundler module resolution). Example: `import { foo } from "./bar.js"`
- **Types**: Prefer interfaces over type aliases. Export types from
  `src/types.ts`. Use `type` imports where possible.
- **No classes** except `TranscriptWriter` in persist.ts. Prefer plain
  functions and interfaces.
- **Error handling**: Throw descriptive `Error` with context. Provider
  errors include status code and response body. The room engine catches
  agent errors and emits them as system messages (no crashes).
- **ANSI colors**: Stored as escape codes in `Personality.color` (e.g.
  `"\x1b[36m"`). Converted to ink color names via `ansiToInk()` in tui.tsx.
- **Config values**: Always have defaults in `DEFAULT_CONFIG` in loader.ts.
  salon.yaml overrides are merged on top.
- **No external test framework** currently. Type-check with `npx tsc --noEmit`.

## Key patterns

- **stdin handoff**: readline is used for pre-TUI prompts only. It's created
  lazily per-question and destroyed immediately. Before ink mounts,
  `process.stdin.removeAllListeners()` + `resume()` ensures clean handoff.
  Never hold a readline instance across the TUI boundary.

- **TUI <-> room engine**: Module-level event queue pattern. Room engine calls
  `tui.handle.pushMessage()` etc., which push to `eventQueue`. React effect
  drains the queue via `eventFlush` callback. Streaming tokens accumulate in
  a ref and flush to state on a 50ms interval to avoid per-token re-renders.

- **Provider temperature**: Some providers (moonshot/kimi-k2.5) only allow
  `temperature: 1`. This is configurable per-provider in salon.yaml and
  flows through AgentConfig. The openai-compat provider also has a retry
  fallback that drops temperature on rejection.

- **Non-blocking input**: Room loop uses `pollUserInput()` callback. Returns
  `undefined` (nothing pending), a string (user message), or `null` (quit).
  TUI's InputLine writes to a shared buffer on Enter.

## How to do common tasks

### Add a new provider kind
1. Add the kind to `ProviderKind` union in `types.ts`
2. Add a `completeXxx()` function in `providers/provider.ts`
3. Add the case to `complete()` and `listModels()` switch statements
4. Document in README.md

### Add a new personality preset
1. Add an entry to `PERSONALITY_PRESETS` in `agents/roster.ts`
2. Pick a unique ANSI color, name, traits, style, bias, chattiness,
   contrarianism
3. Optionally add to default roster in `salon.yaml`

### Add a new room command (e.g. /something)
1. Handle it in `handleSubmit` in `tui.tsx` -- intercept before sending
   to `onUserInput`
2. For display-only commands (like /who), emit via `tui.handle`
3. For commands that affect the room engine, push a sentinel to the
   input buffer and handle in `pollUserInput` in main.ts

### Add a new message kind
1. Add to the `kind` union in `RoomMessage` in `types.ts`
2. Add rendering case in `ChatMessage` component in `tui.tsx`
3. Add formatting case in `formatMessageToMarkdown` in `persist.ts`
4. Add parsing case in `parseSessionMarkdown` in `persist.ts`
5. Handle in `buildMessages` in `personality.ts` (how agents see it)

### Add a new config field
1. Add to the relevant interface in `types.ts`
2. Add default in `DEFAULT_CONFIG` in `loader.ts`
3. Add to `salon.yaml` with a comment
4. Document in README.md

## Current roster

| Agent | Provider | Model | Personality |
|-------|----------|-------|-------------|
| Sage | zen | claude-sonnet-4-6 | Stoic philosopher |
| Wren | openrouter | google/gemini-3.1-pro-preview | Devil's advocate |
| Jules | ollama | qwen3:8b | Retired diplomat (local) |
| Chip | zen | glm-5-free | Jaded GenZ tech worker (free) |
| Sage | zen | claude-sonnet-4-6 | Stoic philosopher |
| Wren | openrouter | google/gemini-3.1-pro-preview | Devil's advocate |
| Riko | moonshot | kimi-k2.5 | Startup founder |
| DocK | fractal | gpt-oss-20b | Research scientist |

## Pending work

See TODO.md. Current item: rolling conversation summary system to prevent
context loss in long sessions.

## Common commands

```bash
just room <name>     # Start or resume a room
just models          # List available models
just check           # Type-check (npx tsc --noEmit)
bun run src/main.ts  # Run directly
```
