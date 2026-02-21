# k2-salon

Multi-AI debate room -- different LLM personalities discuss topics in a real-time IRC-style TUI.

Drop into a chat room where 3-5 AI agents with distinct personalities debate any topic you choose. You can watch, chime in anytime, or just lurk. Agents join and leave dynamically, creating an organic group chat feel.

## Quick start

```bash
# Install dependencies
bun install

# Start a room (creates new if it doesn't exist)
bun run src/main.ts ai-thoughts

# Or use just (recommended)
just room ai-thoughts
```

You'll be prompted for a topic if the room is new. After that, the TUI launches and agents start talking.

## Requirements

- [Bun](https://bun.sh) runtime
- At least one LLM provider configured (see [Configuration](#configuration))
- [just](https://github.com/casey/just) task runner (optional but recommended)

## Usage

### Commands

```bash
just room <name>     # Start or resume a room
just start           # Start interactively (prompts for room name)
just rooms           # List all rooms and their status
just models          # List available models from all providers
just check           # Type-check the project
just install         # Install dependencies
just fish-setup      # Install fish shell tab completions
```

### In-room controls

| Input | Effect |
|-------|--------|
| Type anything + Enter | Send a message to the room |
| `/who` | Show a table of who's in the room with their provider/model |
| `/quit` or `/exit` | Leave the room gracefully |
| Ctrl+C | Force quit |
| Empty enter | Does nothing (just watch) |

### TUI layout

```
k2-salon -- ai-thoughts  session 1
Topic: Should we fear AGI?
============================================================
09:30 -->> Sage has joined (Stoic philosopher . zen/claude-sonnet-4-6)
09:30 -->> Wren has joined (Devil's advocate . openrouter/google/gemini-3.1-pro-preview)
09:30   * Topic: "Should we fear AGI?"
09:31 <Sage> The real question is whether fear is even the right frame...
09:31 <Wren> But Sage, you're assuming rationality scales...
  In room: Sage, Wren, Riko
------------------------------------------------------------
> type here anytime, or just watch
```

- **Chat pane** scrolls as messages arrive; streaming tokens appear in real-time with a cursor block
- **Input line** at the bottom is always active -- type while agents are talking
- **Status bar** shows who's currently in the room
- `/who` displays a formatted table with provider, model, and tagline for each agent

## Configuration

### salon.yaml

The main config file lives at `salon.yaml` in the project root. It has three sections:

#### Providers

Each provider is a named LLM backend. Agents reference these by key.

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
```

Supported provider kinds:
- `openrouter` -- OpenRouter API
- `openai-compat` -- Any OpenAI-compatible API (vLLM, llama.cpp, etc.)
- `ollama` -- Ollama local models

API keys use `${ENV_VAR}` syntax and are resolved from environment variables at runtime.

#### Room settings

```yaml
room:
  contextWindow: 30       # Max messages sent to LLMs as context
  maxTokens: 512          # Max tokens per agent response
  turnDelayMs: 800        # Base delay between turns (ms)
  minAgents: 3            # Min agents in room at any time
  maxAgents: 5            # Max agents in room at any time
  churnIntervalTurns: 4   # How often to evaluate join/leave
```

#### Roster

Each agent maps a personality to a provider and model:

```yaml
roster:
  - name: Sage
    provider: zen
    model: claude-sonnet-4-6

  - name: Wren
    provider: openrouter
    model: google/gemini-3.1-pro-preview

  - name: Jules
    provider: ollama
    model: qwen3:8b
```

### Built-in personalities

8 presets are available: **Sage**, **Riko**, **Nova**, **DocK**, **Wren**, **Jules**, **Chip**, **Ora**. Each has distinct traits, communication style, and ideological bias. You can override any personality field inline in the roster:

```yaml
roster:
  - name: Sage
    provider: zen
    model: claude-sonnet-4-6
    personality:
      chattiness: 0.9        # Override just this field
```

## Rooms and persistence

Room data is stored in `rooms/<name>/`:

```
rooms/
  ai-thoughts/
    room.yaml          # Topic and metadata
    seed.md            # Optional starting material
    001-session.md     # Session transcript
    002-session.md
```

- **Resuming**: Running `just room ai-thoughts` again loads previous session context and continues the conversation
- **Seed material**: Drop a `.md` file in a room directory before starting it. The content becomes context for the discussion. If the markdown has a `# Heading`, it's used as the topic automatically
- **Transcripts**: Every session is saved as markdown with frontmatter (timestamps, participants)

The `rooms/` directory is gitignored by default.

## Environment variables

Set API keys as environment variables. The config uses `${VAR}` syntax:

```bash
export OPENROUTER_API_KEY="sk-or-..."
export OPENCODE_ZEN_API_KEY="..."
export MOONSHOT_API_KEY="..."
```

## Project structure

```
k2-salon/
  src/
    main.ts                  # Entry point -- room setup then TUI launch
    types.ts                 # Shared types
    providers/
      provider.ts            # Unified LLM client (openrouter, openai-compat, ollama)
    agents/
      personality.ts         # System prompt builder, turn-taking logic
      roster.ts              # 8 built-in personality presets
    config/
      loader.ts              # YAML config loader, env var resolution
    room/
      room.ts                # Conversation engine, turn-taking, churn
      persist.ts             # Transcript writer, session loader, seed parser
    cli/
      tui.tsx                # Ink (React for CLI) TUI -- chat pane, input, status
      models.ts              # `just models` command
  completions/
    k2-salon.fish            # Fish shell completions + salon wrapper
  salon.yaml                 # Provider + roster config
  justfile                   # Task runner
```

## How it works

1. **Room setup**: The entry point resolves the room (new or existing), loads any seed material or previous session context, and sets up the transcript writer.

2. **TUI mount**: An [ink](https://github.com/vadimdemedes/ink) (React for CLI) interface takes over the terminal with a chat pane, status bar, and always-active input line.

3. **Conversation loop**: The room engine runs autonomously in the background. Each turn it:
   - Increments turn counters for all agents
   - Periodically evaluates churn (agents join/leave based on chattiness)
   - Picks 1-2 speakers using weighted probability (chattiness + recency)
   - Streams their response token-by-token to the TUI
   - Polls for user input (non-blocking)

4. **Agent speaking**: Each agent gets a system prompt built from their personality, the room topic, and recent message history. Responses stream in real-time.

5. **Transcript**: Every message is appended to a session markdown file in real-time.

## License

MIT
