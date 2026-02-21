# Agent context for k2-salon

This file helps AI coding agents pick up context quickly when resuming work.

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

## Key patterns

- **stdin handoff**: readline is used for pre-TUI prompts only. It's created
  lazily per-question and destroyed immediately. Before ink mounts,
  `process.stdin.removeAllListeners()` + `resume()` ensures clean handoff.

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

## Config

`salon.yaml` has three sections: providers, room settings, roster.
See README.md for full documentation.

## Current roster

| Agent | Provider | Model | Personality |
|-------|----------|-------|-------------|
| Sage | zen | claude-sonnet-4-6 | Stoic philosopher |
| Wren | openrouter | google/gemini-3.1-pro-preview | Devil's advocate |
| Riko | moonshot | kimi-k2.5 | Startup founder |
| DocK | fractal | gpt-oss-20b | Research scientist |
| Jules | ollama | qwen3:8b | Retired diplomat |

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
