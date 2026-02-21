# k2-salon -- TODO

## Test coverage

No tests exist. The step-based engine is very testable — `stepRoom()` with
mock providers would be straightforward. Priority areas:

- **Room engine**: `createRoom`, `stepRoom`, `evaluateChurn`, speaker selection
  weights. All pure-ish functions with injectable callbacks.
- **Personality system**: `shouldSpeak` probability math, `buildSystemPrompt`
  output for verbose vs chat mode, contrarianism directives.
- **Provider abstraction**: Mock HTTP responses for each provider kind
  (openrouter, openai-compat, ollama). Test temperature retry fallback.
- **Config loader**: `${ENV_VAR}` resolution, roster binding to providers,
  validation of missing providers.
- **Persistence**: Round-trip test — write a transcript, read it back, verify
  frontmatter and message parsing.

---

## Rolling conversation summary

### Problem
`RoomState.history` grows unbounded. The `contextWindow: 30` setting limits
what's sent to the LLM (last 30 messages), but once older messages fall out
of that window, agents have no memory of what was discussed. New agents
joining mid-conversation have zero context beyond the last 30 messages.

Long sessions become incoherent -- agents repeat themselves, forget earlier
conclusions, and lose the thread of the discussion.

### Solution
Implement a rolling summary system:

1. Add `summaryIntervalMessages` to `RoomConfig` (e.g. 50). After every N
   new messages, trigger a summary generation.
2. Use one of the LLM providers to generate a 3-5 sentence summary of the
   conversation so far. Use a dedicated "cheapest available" provider call
   (not personality-driven).
3. Store the summary as a special `"summary"` kind message at the front of
   history.
4. When building LLM context (`buildMessages` in `personality.ts`), always
   include the latest summary before the recent `contextWindow` messages.
5. Each new summary compounds the previous one (includes prior summary +
   recent messages), so nothing is truly lost.
6. After summarizing, trim `history` to keep only: the summary message +
   the last `contextWindow` messages. This bounds memory usage.

### Files to change
- `src/types.ts` -- Add `"summary"` to `RoomMessage.kind` union. Add
  `summaryIntervalMessages` to `RoomConfig`.
- `src/room/room.ts` -- Add summary trigger logic in the main loop.
  After every N messages, call a summarization function. Replace old
  history with summary + recent messages.
- `src/agents/personality.ts` -- In `buildMessages()`, detect summary
  messages and inject them as system context before recent chat history.
- `src/config/loader.ts` + `salon.yaml` -- New config field with default.
- `src/room/persist.ts` -- Persist summaries in transcripts so resumed
  sessions can load the last summary instead of replaying everything.

### Design decisions to make
- Which provider/model to use for summarization? Options:
  - Always use the first roster agent's provider (simplest)
  - Add a `summaryProvider` config field (most flexible)
  - Pick the cheapest provider from the config
- Should the summary be visible in the chat pane? Probably as a dim system
  message: `* [Summary updated: The group discussed X, Y, Z...]`
- Token budget for the summary itself (200-300 tokens should suffice)

---

## Error recovery mid-stream

If an LLM call fails partway through `agentSpeak()`, that turn is silently
lost. This is non-catastrophic but degrades the experience.

Options:
- **Retry with same agent**: Simple, but risks double-speaking if the partial
  response was already streamed to the UI.
- **Fallback to another provider**: Pick a different agent to speak instead.
  Requires the engine to know which providers are healthy.
- **Exponential backoff + skip**: Retry once or twice, then skip the turn and
  log a system message (`* [Sage couldn't respond, skipping turn]`).

Probably start with retry-once + skip-with-system-message. Keep it simple.

---

## TTS concurrency limit

`src/cli/podcast.ts` parallelizes all TTS synthesis calls with no cap. A long
transcript (50+ segments) could hit OpenAI rate limits.

Fix: Add a simple semaphore/pool (e.g. concurrency of 5-10) around the
`Promise.all(segments.map(...))` in `synthesiseSegments()`. No external
dependency needed — a counting semaphore is ~15 lines.

---

## Split provider.ts into per-provider modules

`src/providers/provider.ts` is 356 lines handling three distinct provider
protocols. As more providers are added, this will get unwieldy.

Proposed structure:
```
src/providers/
  provider.ts        → Unified complete() + listModels() dispatch
  openrouter.ts      → completeOpenRouter()
  openai-compat.ts   → completeOpenAICompat()
  ollama.ts          → completeOllama()
```

Each module exports its `complete*()` and `listModels*()` functions.
The main `provider.ts` becomes a thin dispatcher.

---

## Future ideas

These aren't bugs or debt — just directions the architecture naturally supports:

- **Agent memory**: Per-agent persistent memory across sessions (opinions
  formed, facts learned, relationships with other agents).
- **Topic branching**: Let the conversation fork into sub-topics with
  different agent subsets, then reconverge.
- **Voting / consensus**: Agents vote on propositions; track agreement
  evolution over time.
- **Multi-room**: Multiple concurrent rooms with agents that can move
  between them (the step-based engine already supports multiple instances).
- **Web UI**: The engine is UI-agnostic — a WebSocket bridge to a browser
  client would slot in alongside the TUI with no engine changes.
- **Configurable TTS voices**: Currently hardcoded voice mapping in
  podcast.ts. Could move to roster config (`voice: "nova"`) per agent.
