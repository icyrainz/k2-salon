# k2-salon -- TODO

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
