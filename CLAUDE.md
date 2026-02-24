# Agent context for k2-salon

This file helps AI coding agents pick up context quickly when resuming work.

## Project documentation structure

- **BRAINSTORM.md** -- Ideas, requirements, design decisions, rationale.
  Read this to understand _why_ things are built the way they are.
- **TODO.md** -- Pending work only. Completed tasks are removed.
  Each item has problem, solution, and files-to-change sections.
- **CLAUDE.md** -- (this file) Project navigation, code style, architecture,
  how to do common tasks. Read this first when starting a session.
- **README.md** -- User-facing documentation (usage, config, setup).

## What this project is

Multi-AI debate room. Different LLM personalities (Sage, Wren, Riko, etc.)
discuss topics in a real-time IRC-style TUI built with ink (React for CLI).
Users can watch, chime in, or just lurk. Agents join/leave dynamically.

## Architecture

Three-layer architecture with strict dependency direction: **Core <- Engine <- Interface**.

```
src/
  core/                  Pure functions — no I/O, no side effects
    types.ts             All shared types. Key ones:
                         - AgentColor (semantic color names for ink)
                         - AgentConfig (personality + provider + model)
                         - RoomMessage (chat/join/leave/system/user + metadata)
                         - RoomConfig, SalonConfig, ProviderEntry, RosterEntry
    roster.ts            8 built-in PERSONALITY_PRESETS. Leave/join excuses.
    personality.ts       buildSystemPrompt() + buildMessages() for LLM context.
    speaker.ts           shouldSpeak(), getSpeakerCandidates() — pure probability.
    churn.ts             evaluateChurn() -> ChurnDecision (who joins/leaves).
    voices.ts            TtsVoice type, VOICE_MAP, voiceFor() — shared voice
                         mapping for OpenAI TTS (used by engine/tts + cli/podcast).

  engine/                Stateful orchestration, EventEmitter
    salon-engine.ts      SalonEngine class (TypedEmitter). Owns room state,
                         drives agent turns via step(). Events: message,
                         thinking, streamToken, streamDone.
    provider.ts          Unified LLM client. Three backends: openrouter,
                         openai-compat, ollama. SSE streaming for first two,
                         NDJSON for ollama. Temperature retry fallback in
                         openai-compat (some models reject non-1 temperature).
    config.ts            YAML config loader. Resolves ${ENV_VAR} patterns.
                         resolveRoster() maps roster entries to AgentConfig
                         with provider details. Normalizes ANSI color codes
                         from legacy salon.yaml to semantic AgentColor names.
    persist.ts           Transcript writer (markdown with frontmatter), session
                         loader, seed material parser. Room data in rooms/<name>/.
    tts.ts               TTS synthesis (OpenAI API), caching (rooms/<name>/tts/),
                         and playback (mpv). Used by /tts command in TUI.

  tui/                   Terminal UI (Ink/React)
    main.ts              Entry point. Pre-TUI setup (room resolution, topic
                         prompt via readline), then mounts ink TUI and runs
                         governed/free mode loop.
    app.tsx              Ink TUI. Components: Header, ChatMessage, WhoTable,
                         StatusBar, InputLine, TtsSelectBar. Communicates with
                         SalonEngine via module-level event queue
                         (emitTuiEvent/eventFlush). /tts command enters selection
                         mode with TtsSelectBar for picking messages to play.
                         Streaming tokens buffered in ref, flushed to state
                         every 50ms.
    colors.ts            toInkColor() — AgentColor to ink color mapping.

  cli/                   Other CLI entry points
    simulate.ts          Headless simulation — calls engine.step() in a loop.
    podcast.ts           OpenAI TTS per turn, parallel synthesis, ffmpeg concat.
    models.ts            Standalone `just models` command.
    shuffle-personas.ts  Pick random personas from personas.yaml into salon.yaml.
```

## Code style

- **Language**: TypeScript, strict mode, ESM (`"type": "module"`)
- **Runtime**: Bun (not Node). Use `bun run` to execute.
- **JSX**: React JSX via `react-jsx` transform (no `React.createElement`)
- **Imports**: Use `.js` extensions in import paths (ESM requirement with
  bundler module resolution). Example: `import { foo } from "./bar.js"`
- **Types**: Prefer interfaces over type aliases. Export types from
  `src/core/types.ts`. Use `type` imports where possible.
- **No classes** except `SalonEngine` and `TranscriptWriter`. Prefer plain
  functions and interfaces.
- **Error handling**: Throw descriptive `Error` with context. Provider
  errors include status code and response body. The engine catches
  agent errors and emits them as system messages (no crashes).
- **Formatting**: The project uses Prettier. If you edit files, ensure the formatting matches the existing codebase (2 spaces, double quotes).
- **Colors**: Stored as semantic `AgentColor` names (e.g. `"cyan"`,
  `"redBright"`) in `Personality.color`. Legacy ANSI codes from older
  salon.yaml files are normalized in `resolveRoster()`.
- **Config values**: Always have defaults in `DEFAULT_CONFIG` in config.ts.
  salon.yaml overrides are merged on top.

## Testing & Linting

- **Test Framework**: Bun's built-in test runner (`bun:test`). Tests are
  co-located next to source files as `*.test.ts`.
- **Run all tests**: `just test` or `bun test`
- **Run a single file**: `bun test src/core/speaker.test.ts`
- **Run with filter**: `bun test --filter "shouldSpeak"`
- **Type-checking**: Run `just check` or `npx tsc --noEmit`. **Always do this before finishing.**
- **Formatting**: `npx prettier --write .`
- **Git commands**: Use plain `git` (not `git -C <path>`) since the working
  directory is already the repo root. The `-C` flag breaks auto-approval flows.
- **Test coverage**: Core layer (roster, personality, speaker, churn) and
  engine layer (config, persist, salon-engine) have tests. TUI layer and
  provider (network I/O) are not tested.

## Key patterns

- **stdin handoff**: readline is used for pre-TUI prompts only. It's created
  lazily per-question and destroyed immediately. Before ink mounts,
  `process.stdin.removeAllListeners()` + `resume()` ensures clean handoff.
  Never hold a readline instance across the TUI boundary.

- **TUI <-> engine**: Module-level event queue pattern. Engine emits events,
  TUI subscribes in useEffect and pushes to `eventQueue`. React effect
  drains the queue via `eventFlush` callback. Streaming tokens accumulate in
  a ref and flush to state on a 50ms interval to avoid per-token re-renders.

- **Provider temperature**: Some providers (moonshot/kimi-k2.5) only allow
  `temperature: 1`. This is configurable per-provider in salon.yaml and
  flows through AgentConfig. The openai-compat provider also has a retry
  fallback that drops temperature on rejection.

- **Mode loop**: The TUI (`tui/main.ts`) owns the governed/free mode loop.
  Governed mode polls an input buffer every 120ms for `/next`. Free mode
  sleeps `turnDelayMs + jitter` between steps. The engine knows nothing
  about modes — it just runs `step()` when told.

## How to do common tasks

### Add a new provider kind

1. Add the kind to `ProviderKind` union in `core/types.ts`
2. Add a `completeXxx()` function in `engine/provider.ts`
3. Add the case to `complete()` and `listModels()` switch statements
4. Document in README.md

### Add a new personality preset

1. Add an entry to `PERSONALITY_PRESETS` in `core/roster.ts`
2. Pick a unique semantic color (AgentColor), name, traits, style, bias,
   chattiness, contrarianism
3. Optionally add to default roster in `salon.yaml`

### Add a new room command (e.g. /something)

1. Handle it in `handleSubmit` in `tui/app.tsx` -- intercept before sending
   to `onUserInput`
2. For display-only commands (like /who), emit via `tui.handle`
3. For commands that affect the engine, push a sentinel to the
   input buffer and handle in `tui/main.ts`

### Add a new message kind

1. Add to the `kind` union in `RoomMessage` in `core/types.ts`
2. Add rendering case in `ChatMessage` component in `tui/app.tsx`
3. Add formatting case in `formatMessageToMarkdown` in `engine/persist.ts`
4. Add parsing case in `parseSessionMarkdown` in `engine/persist.ts`
5. Handle in `buildMessages` in `core/personality.ts` (how agents see it)

### Add a new config field

1. Add to the relevant interface in `core/types.ts`
2. Add default in `DEFAULT_CONFIG` in `engine/config.ts`
3. Add to `salon.yaml` with a comment
4. Document in README.md

## Pending work

See TODO.md. Current item: rolling conversation summary system to prevent
context loss in long sessions.

## README maintenance

**Always check and update README.md on every commit.** If your changes add
commands, config options, visible behaviour, or change the project structure,
update the relevant README sections before committing.

## Common commands

```bash
just room <name>     # Start or resume a room
just models          # List available models
just check           # Type-check (npx tsc --noEmit)
bun run src/tui/main.ts  # Run directly
```
