# k2-salon — Brainstorm & Design Decisions

## The Idea

A multi-AI debate room where different LLM models discuss topics in real-time.
Each model has its own personality, opinions, and communication style. The
conversation feels like an IRC chat room — agents join, leave, argue, agree,
and build on each other's points. The human is primarily an observer who can
drop in a comment whenever they want.

The goal: get in-depth, unbiased conversation by having genuinely different
models (not just different prompts on the same model) debate from different
perspectives.

## What Already Exists (and why it's not enough)

- **ChatArena / LMYS Chatbot Arena** — 1v1 comparison, not a group room
- **AutoGen / CrewAI / LangGraph** — multi-agent but task-oriented, not
  conversation/debate-oriented
- **Character.ai group chats** — same underlying model with persona wrappers,
  no real model diversity, no drop-in/drop-out

None of these combine: multiple real LLM backends + personality system +
dynamic participation + observer-first UX.

## Design Decisions

### CLI-first, IRC-style

Chosen over a web UI for speed and simplicity. Terminal with colored agent
names, timestamps, system messages for join/leave. Looks like IRC. Can build
a web frontend later if needed.

### TypeScript + Bun

Chosen for fast async/streaming, good fetch API, and easy API integrations.
No heavy frameworks — just raw fetch + readline.

### Provider architecture: `openrouter | openai-compat | ollama`

Three provider types cover every backend:

- **openrouter** — OpenRouter with its specific headers (HTTP-Referer, X-Title)
- **openai-compat** — any OpenAI-compatible server (llama.cpp, vLLM, OpenCode
  Zen, Moonshot, etc.). Base URL is configurable, API key is optional.
- **ollama** — Ollama's native API format (`/api/chat`, NDJSON streaming)

This means any new provider that speaks OpenAI format just needs a name, URL,
and optional key in `salon.yaml`. No code changes.

### Configuration via `salon.yaml`

Decided against hardcoding the roster in TypeScript. YAML is more readable for
personality config than JSON. The config has three sections:

- **providers** — named LLM backends with kind/baseUrl/apiKey
- **room** — conversation parameters (context window, turn delay, churn rate)
- **roster** — maps personality names to providers and models

API keys use `${ENV_VAR}` syntax, resolved from `.env` at load time.

Built-in personality presets serve as fallback when no `salon.yaml` exists, so
it works out of the box.

### Direct provider naming (no "cloud" alias)

Initially considered an `active_cloud` setting so all cloud agents could be
switched with one line. Rejected — too limiting. You want to mix OpenRouter,
Zen, and Moonshot agents in the same room simultaneously. Each roster entry
just names its provider directly.

### Default roster: 5 agents, 5 different backends

| Agent | Personality | Provider | Model |
|-------|------------|----------|-------|
| Sage | Stoic philosopher, systems thinker | zen | claude-sonnet-4-6 |
| Wren | Devil's advocate, contrarian | openrouter | gemini-3.1-pro |
| Riko | Pragmatic startup founder | moonshot | kimi-k2.5 |
| DocK | Research scientist, dry humor | fractal | gpt-oss-20b (local) |
| Jules | Retired diplomat, bridge-builder | ollama | qwen3:8b (remote) |

Maximum model diversity — every agent runs on a completely different LLM.

### Full personality pool (8 presets)

The remaining 3 presets (Nova, Chip, Ora) are available for the roster but not
in the default config. They serve as drop-in replacements or additions:

- **Nova** — Activist, community organizer, equity-focused
- **Chip** — Jaded GenZ tech worker, sarcastic, meme-literate
- **Ora** — Buddhist-leaning mindfulness teacher, reframes to ethics

Personalities can also be defined inline in `salon.yaml` for custom agents.

### Personality system

Each personality has:
- **traits** — core character attributes
- **style** — communication directives (how they write)
- **bias** — ideological lens / worldview
- **chattiness** (0-1) — how eager to jump in
- **contrarianism** (0-1) — how likely to disagree

The system prompt embeds all of this plus chat room rules (be concise, stay in
character, reference others by name, be opinionated).

### Turn-taking

Not round-robin. Each turn:
1. Every agent rolls against their `chattiness + recency boost`
2. Agents who haven't spoken recently get a boost
3. Nobody speaks twice in a row
4. If nobody volunteers, the longest-silent agent is forced
5. Usually 1 speaker per turn, occasionally 2 for rapid back-and-forth

### Drop-in / drop-out simulation

Every N turns (configurable, default 4), the room evaluates churn:
- **Leave**: random agent may leave, weighted by low chattiness (quiet ones
  leave first). Gives an excuse: "gotta run, meeting starting"
- **Join**: a benched agent may join, eager to talk. Gives a greeting:
  "oh this is a spicy topic, had to join"

Room maintains min/max agent counts (default 3-5).

### Observer-first UX

The conversation is fully autonomous — agents talk on their own without any
human intervention. The human is an observer by default:

- **Watch**: agents keep talking, no prompts or pauses
- **Speak**: type a message anytime, it gets injected between agent turns
- **Nudge**: press enter with nothing — just advances, no interruption
- **Commands**: `/who` shows who's in the room, `/quit` exits

No blocking prompts. No "(skipped)" messages. The room flows.

### Streaming responses

Responses stream token-by-token to the terminal. You see agents "typing" in
real-time, which creates a natural chat feel.

### Room persistence (markdown transcripts)

Rooms are directories under `rooms/`. Each room has:

```
rooms/
  ai-thoughts/
    room.yaml           # topic, created date, last session number
    discussions.md       # seed material (any .md that isn't a session)
    001-session.md       # first salon session transcript
    002-session.md       # resumed session
```

**Session transcripts** use markdown with YAML frontmatter:
- Frontmatter: topic, session number, start/end timestamps, participants
- Blockquotes for system events (join/leave)
- Bold agent names + timestamps for chat messages
- Human-readable — works in any markdown viewer or Obsidian

**Seed material**: any `.md` file in the room directory (that isn't a session
transcript) is parsed and injected as context. Agents see the full prior
conversation. The topic is auto-extracted from the first `#` heading.

**Resume**: running `salon room ai-thoughts` again loads previous session
messages into the context window. Agents pick up where they left off.

### `just models` — provider discovery

Queries `/v1/models` (OpenAI-compatible) or `/api/tags` (Ollama) from all
configured providers. Shows a grouped table of available models. Handles
unreachable providers gracefully.

### `salon` fish shell wrapper

A fish function that wraps `just` with proper completions:
- `salon <TAB>` — shows only recipes (room, rooms, models, etc.)
- `salon room <TAB>` — shows existing room names with descriptions
- Works from any directory (resolves project path automatically)

Installed via `just fish-setup` which symlinks into `~/.config/fish/conf.d/`.

## Current providers

| Name | Kind | URL | Auth |
|------|------|-----|------|
| openrouter | openrouter | openrouter.ai/api/v1 | OPENROUTER_API_KEY |
| zen | openai-compat | opencode.ai/zen/v1 | OPENCODE_ZEN_API_KEY |
| moonshot | openai-compat | api.moonshot.ai/v1 | MOONSHOT_API_KEY |
| fractal | openai-compat | akio-fractal:8080/v1 | none (local llama.cpp) |
| ollama | ollama | akio-ollama:11434 | none (remote Ollama) |

## File structure

```
k2-salon/
  src/
    main.ts                  # Entry point, room lifecycle, input handling
    types.ts                 # Shared types (providers, personalities, config)
    providers/
      provider.ts            # Unified LLM client + model listing
    agents/
      personality.ts         # System prompt builder, turn logic
      roster.ts              # 8 built-in personality presets
    config/
      loader.ts              # YAML config loader, env resolution, validation
    room/
      room.ts                # Conversation engine, turn-taking, churn
      persist.ts             # Transcript writer, session loader, seed parser
    cli/
      renderer.ts            # IRC-style terminal renderer
      models.ts              # `just models` command
  completions/
    k2-salon.fish            # Fish shell completions + salon wrapper
  rooms/                     # Persistent room directories
  salon.yaml                 # Provider + roster configuration
  justfile                   # Task runner
```

## Future ideas (not yet built)

- Web UI frontend (WebSocket-backed, keep CLI as primary)
- Per-room roster overrides (different personalities for different topics)
- Agent memory across sessions (not just transcript replay)
- Voting/consensus mechanism (agents vote on conclusions)
- Export to podcast script format
- Model temperature/style per-agent in roster config
