# k2-salon

Multi-AI debate room — different LLM personalities discuss topics in a real-time IRC-style TUI, or run headless to generate a transcript and podcast.

Drop into a chat room where AI agents with distinct personalities debate any topic you choose. Watch, chime in, or just lurk. Agents join and leave dynamically. Or skip the TUI entirely and pipe a simulation straight to audio.

## Quick start

```bash
bun install

# Start a room interactively
just room ai-thoughts

# Run a headless simulation + podcast in one shot
just salon-podcast "the future of nuclear energy"
```

## Requirements

- [Bun](https://bun.sh) runtime
- [ffmpeg](https://ffmpeg.org) — required for podcast audio concatenation
- [mpv](https://mpv.io) — required for in-room TTS playback
- At least one LLM provider configured (see [Configuration](#configuration))
- `OPENAI_API_KEY` in `.env` — required for TTS (podcast and in-room playback)
- [just](https://github.com/casey/just) task runner (optional but recommended)

---

## TUI mode

### Commands

```bash
just room <name>     # Start or resume a named room
just start           # Start interactively (prompts for room name)
just rooms           # List all rooms and their status
just models          # List available models from all providers
just check           # Type-check (npx tsc --noEmit)
just fish-setup      # Install fish shell tab completions
```

### In-room controls

| Input | Effect |
|-------|--------|
| Type anything + Enter | Send a message to the room |
| `/next` or `/n` | Let the next agent speak (governed mode) |
| `/free` | Switch to free mode — agents speak automatically |
| `/govern` | Switch back to governed mode |
| `/who` | Show a table of agents with provider/model info |
| `/tts` | Listen to a message — opens selection bar to pick which message to play |
| `/shuffle` | Randomise the agent roster |
| `/quit` or `/exit` | Leave gracefully |
| Ctrl+C | Force quit |

### Modes

**Governed mode** (default): agents queue up one at a time. A system message announces who is ready; you press `/next` to let them speak, or type a reply to redirect the conversation. Agents write longer, more developed responses.

**Free mode** (`/free`): agents speak automatically with natural pacing delays and short chat-style responses. Agents join and leave dynamically (churn). Type at any time to interject.

### TTS playback

Type `/tts` to listen to any message in the conversation. A selection bar appears at the bottom — use arrow keys (or Ctrl+N/Ctrl+P) to scroll through messages, then Enter to play. Messages with cached audio show a green `●` indicator.

Audio is synthesised via OpenAI TTS and cached in `rooms/<name>/tts/`. Cached messages play instantly on subsequent listens.

**Playback controls** (while audio is playing):

| Key | Effect |
|-----|--------|
| `←` / `→` | Seek -5s / +5s |
| `Space` | Pause / resume |
| `[` / `]` | Slow down / speed up |
| `Esc` or `q` | Stop playback |

A progress bar shows position, duration, and speed during playback.

### TUI layout

```
k2-salon -- ai-thoughts  session 1  [governed]
Topic: Should we fear AGI?
════════════════════════════════════════════════════
  * Sage has joined (Stoic philosopher · zen/claude-sonnet-4-6)
  * Wren has joined (Devil's advocate · openrouter/gemini-3.1-pro)
  * [Sage is ready — /next to let them speak, or type a reply]
<Sage> The real question is whether fear is even the right frame...
<Wren> But Sage, you're assuming rationality scales...
  In room: Sage, Wren, Jules
────────────────────────────────────────────────────
> type here anytime, or just watch
```

- Chat pane scrolls as messages arrive; streaming tokens appear in real-time
- Input line at the bottom is always active — type while agents are talking
- Status bar shows who's currently in the room and the current mode

### Rooms and persistence

Room data is stored in `rooms/<name>/` (gitignored):

```
rooms/
  ai-thoughts/
    room.yaml          # Topic and metadata
    seed.md            # Optional seed material
    001-session.md     # Session transcripts
    002-session.md
    tts/               # Cached TTS audio (auto-generated)
      0000-m.mp3
      0005-m.mp3
```

- **Resuming**: `just room ai-thoughts` loads the previous session context and continues
- **Seed material**: Drop a `.md` file in a room directory before starting. The content becomes context. A `# Heading` is used as the topic automatically
- **Transcripts**: Every session is appended to a markdown file with frontmatter in real-time

---

## Simulation + podcast mode

Run a fully headless debate — no TUI, no input needed — then convert it to a podcast MP3.

### Commands

```bash
# Simulate a debate and print a markdown report to stdout
just simulate "dog vs cat"
just simulate "dog vs cat" -- --messages 20

# Convert a saved report to a podcast MP3
just podcast reports/dog-vs-cat.md

# One-shot: simulate → report → podcast
just salon-podcast "dog vs cat"
just salon-podcast "dog vs cat" -- --messages 20
```

`salon-podcast` saves both files to `reports/`:

```
reports/
  dog-vs-cat.md      # Transcript + participant profiles
  dog-vs-cat.mp3     # Podcast audio
```

The `reports/` directory is gitignored.

---

## Video generation

Generate a YouTube Short (1080x1920 vertical video) from any room's conversation.

### Commands

```bash
# Generate a video from all messages in a room
just video my-room

# Generate from a specific message range (by sequence number)
just video my-room --from 10 --to 45

# Custom output file
just video my-room --out custom.mp4
```

### Requirements

- [ffmpeg](https://ffmpeg.org) + ffprobe — for audio concat and video rendering
- `OPENAI_API_KEY` in `.env` — for TTS synthesis

### Pipeline

1. Loads all session transcripts from the room
2. Generates TTS audio for each content message (reuses cached audio)
3. Probes audio durations and builds a timeline manifest (`manifest.json`)
4. Concatenates all audio segments with pauses into `audio.mp3`
5. Renders a vertical video with ffmpeg: dark background, audio waveform visualization, speaker names in color, subtitles, and a progress bar

### Output files

```
rooms/<name>/video/
  manifest.json    # Renderer-agnostic timeline (segments, participants, metadata)
  audio.mp3        # Concatenated audio track
  shorts.mp4       # Final video (1080x1920)
```

The manifest is renderer-agnostic — it describes the timeline, participants, and audio files without coupling to ffmpeg. This allows swapping the renderer later.

---

### How simulation works

The engine is purely step-based — `engine.step()` runs exactly one agent turn and returns. The simulation loop calls it until enough chat messages are collected, with no polling, no wait loop, and no UI input required.

Each step uses `verbose: true` so agents write full paragraphs suitable for a report rather than short chat-style messages.

### Podcast generation

Each agent turn is synthesised via OpenAI TTS (`tts-1` by default, `tts-1-hd` with `--model tts-1-hd`). Each agent has a distinct voice matched to their personality. All TTS calls run in parallel, then ffmpeg concatenates the segments into a single MP3 with natural pauses between turns.

**Voice assignments:**

| Agent | Voice | Character |
|-------|-------|-----------|
| Sage | onyx | Deep, calm |
| Nova | nova | Warm, bright |
| Riko | echo | Crisp |
| DocK | alloy | Matter-of-fact |
| Wren | fable | Distinctive |
| Jules | shimmer | Warm |
| Chip | echo | Energetic |
| Ora | nova | Serene |

---

## Configuration

### salon.yaml

#### Providers

```yaml
providers:
  openrouter:
    kind: openrouter
    baseUrl: https://openrouter.ai/api/v1
    apiKey: ${OPENROUTER_API_KEY}

  zen:
    kind: openai-compat
    baseUrl: https://opencode.ai/zen/v1
    apiKey: ${OPENCODE_ZEN_API_KEY}

  ollama:
    kind: ollama
    baseUrl: http://localhost:11434

  moonshot:
    kind: openai-compat
    baseUrl: https://api.moonshot.cn/v1
    apiKey: ${MOONSHOT_API_KEY}
    temperature: 1    # Some providers only allow temperature: 1
```

Supported provider kinds: `openrouter`, `openai-compat`, `ollama`.

API keys use `${ENV_VAR}` syntax resolved from environment at runtime.

#### Room settings

```yaml
room:
  contextWindow: 30       # Max messages sent to LLMs as context
  maxTokens: 512          # Max tokens per response (doubled in governed/verbose mode)
  turnDelayMs: 800        # Base delay between turns in free mode (ms)
  minAgents: 3            # Min agents active at any time
  maxAgents: 5            # Max agents active at any time
  churnIntervalTurns: 4   # How often to evaluate join/leave (free mode only)
```

#### Roster

Each agent maps a personality preset to a provider and model. Use `priority` to guarantee an agent is always in the room:

```yaml
roster:
  - name: Jules                    # local — always present
    provider: ollama
    model: qwen3:8b
    priority: 1                    # joins first, never evicted by churn

  - name: Chip                     # free tier — always present
    provider: zen
    model: glm-5-free
    priority: 2

  - name: Sage                     # paid — joins if slot available
    provider: zen
    model: claude-sonnet-4-6
```

**Priority agents** (those with a `priority` field) always fill the first active slots and are immune to churn eviction. Lower number = higher priority. Agents without a priority are shuffled into remaining slots and can join/leave freely.

This is useful for keeping free/local agents always present during development to avoid unnecessary API costs.

### Built-in personalities

8 presets: **Sage** (stoic philosopher), **Riko** (startup founder), **Nova** (activist), **DocK** (research scientist), **Wren** (devil's advocate), **Jules** (retired diplomat), **Chip** (jaded GenZ tech worker), **Ora** (mindfulness teacher).

Override any personality field inline:

```yaml
roster:
  - name: Sage
    provider: zen
    model: claude-sonnet-4-6
    personality:
      chattiness: 0.9
```

---

## Environment variables

Store keys in `.env` at the project root (loaded automatically by Bun):

```bash
OPENROUTER_API_KEY=sk-or-...
OPENCODE_ZEN_API_KEY=...
MOONSHOT_API_KEY=...
OPENAI_API_KEY=...        # Required for TTS (podcast + in-room /tts)
```

---

## Project structure

The codebase follows a strict three-layer architecture: **Core ← Engine ← Interface**.

```
src/
  core/                Pure functions — no I/O, no side effects
    types.ts           Shared types (AgentColor, Personality, AgentConfig, RoomMessage…)
    roster.ts          8 built-in personality presets, join/leave excuses
    personality.ts     System prompt builder, LLM message formatter
    speaker.ts         shouldSpeak(), getSpeakerCandidates() — pure probability logic
    churn.ts           evaluateChurn() → ChurnDecision (who should join/leave)
    voices.ts          TTS voice map — agent name → OpenAI voice assignment
  engine/              Stateful orchestration, EventEmitter
    salon-engine.ts    SalonEngine class — owns room state, drives agent turns
    provider.ts        Unified LLM client (openrouter, openai-compat, ollama)
    config.ts          YAML config loader, ${ENV_VAR} resolution, roster resolver
    persist.ts         Transcript writer, session loader, seed parser
    tts.ts             OpenAI TTS synthesis, caching, mpv playback with IPC controls
  tui/                 Terminal UI (Ink/React)
    main.ts            Entry point — room setup, governed/free mode loop, TTS wiring
    app.tsx            React component tree — chat pane, streaming, TTS UI, input, status bar
    colors.ts          AgentColor → ink color mapping
  cli/                 Other CLI entry points
    simulate.ts        Headless simulation — calls engine.step() in a loop, no UI
    podcast.ts         OpenAI TTS per turn, parallel synthesis, ffmpeg concat
    video.ts           YouTube Shorts generator — TTS + ffmpeg video pipeline
    models.ts          `just models` command
    shuffle-personas.ts  Pick random personas from personas.yaml into salon.yaml
prompts/                 Externalized system prompt templates
  system.md            Main system prompt with {{variable}} placeholders
  rules-verbose.md     Verbose mode length/tone rules
  rules-concise.md     Concise mode length/tone rules
completions/
  k2-salon.fish        Fish shell completions + salon alias
reports/               Generated simulation transcripts + podcast MP3s (gitignored)
rooms/                 Room data — topics, transcripts, seed material (gitignored)
salon.yaml             Provider + roster config
personas.yaml          Persona pool for /shuffle
justfile               Task runner recipes
```

## How it works

### SalonEngine

The engine (`salon-engine.ts`) extends `TypedEmitter` and is fully decoupled from any UI. It exposes a step-based API:

```ts
const engine = new SalonEngine(config, roster, history);
engine.open();          // emits topic + join messages

// Caller drives the loop
while (collecting) {
  await engine.step({ verbose: true, churn: false });
}
```

`engine.step()` runs exactly one agent turn — picks a speaker, calls the LLM, emits the response via events — and returns. No polling, no wait loops inside the engine.

**Events:** `message`, `thinking(agent, msgId)`, `streamToken`, `streamDone`

Each message gets a string ID in `NNNN-m` (content) or `NNNN-e` (event) format, assigned by the engine. The `thinking` event includes the pre-allocated message ID so the TUI can associate streaming content with the final persisted message from the start. IDs are preserved across sessions for TTS cache consistency.

**`StepOptions`:**
- `verbose` — agents write long paragraphs (governed mode / simulation) vs short chat messages (free mode)
- `churn` — evaluate agent join/leave on this step (free mode only; disabled in simulation for a stable cast)
- `speaker` — force a specific agent to speak (used in governed mode after `/next`)

### TUI loop (tui/main.ts)

The TUI owns the governed wait loop and free-mode pacing. Governed mode polls an input buffer every 120ms waiting for `/next`; free mode sleeps `turnDelayMs + jitter` between steps. Both pass appropriate `StepOptions` to `engine.step()`. The engine knows nothing about either mode.

### Simulation loop (cli/simulate.ts)

A plain `while` loop with no delays, no UI input, no mode flags — just calls `engine.step({ verbose: true })` until enough chat messages are collected.

### Podcast pipeline (cli/podcast.ts)

1. Parse the simulation markdown report into speaker segments
2. Synthesise all segments in parallel via OpenAI TTS
3. Generate silence gaps with ffmpeg
4. Concatenate into a single MP3 with ffmpeg concat demuxer

## License

MIT
