# k2-salon — Multi-AI Debate Room
# Run `just` to see all available commands.

# default: list available commands
default:
    @just --list

# ── Room commands ────────────────────────────────────────────────────

# Start or resume a room (creates new if doesn't exist)
room name:
    bun run src/main.ts {{name}}

# Start interactively (prompts for room name)
start:
    bun run src/main.ts

# List all rooms and their status
rooms:
    @echo "k2-salon — Rooms"
    @echo ""
    @for dir in rooms/*/; do \
        name=$(basename "$dir"); \
        if [ -f "$dir/room.yaml" ]; then \
            topic=$(grep '^topic:' "$dir/room.yaml" | sed 's/topic: *//'); \
            sessions=$(ls "$dir"/*-session.md 2>/dev/null | wc -l | tr -d ' '); \
            seeds=$(ls "$dir"/*.md 2>/dev/null | grep -v session | wc -l | tr -d ' '); \
            echo "  $name  topic=$topic  sessions=$sessions  seeds=$seeds"; \
        else \
            seeds=$(ls "$dir"/*.md 2>/dev/null | wc -l | tr -d ' '); \
            echo "  $name  (no topic yet)  seeds=$seeds"; \
        fi; \
    done

# ── Provider commands ────────────────────────────────────────────────

# List available models from all configured providers
models:
    bun run src/cli/models.ts

# Run a headless simulation and print a markdown report to stdout
# Usage: just simulate "your topic" [-- --messages 20]
simulate topic *args:
    bun run src/cli/simulate.ts "{{topic}}" {{args}}

# Convert a simulation report to a podcast MP3 (reads stdin or a file)
# Usage: just podcast report.md
#        just podcast report.md -- --out episode.mp3 --model tts-1-hd
podcast *args:
    env -u OPENAI_API_KEY bun run src/cli/podcast.ts {{args}}

# One-shot: simulate and produce a podcast in one command
# Saves the report to reports/<slug>.md and audio to <slug>.mp3
# Usage: just salon-podcast "your topic here"
salon-podcast topic *args:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p reports
    slug=$(echo "{{topic}}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/-*$//')
    report="reports/${slug}.md"
    bun run src/cli/simulate.ts "{{topic}}" {{args}} > "$report"
    echo "Report saved to $report"
    env -u OPENAI_API_KEY bun run src/cli/podcast.ts "$report" --out "reports/${slug}.mp3"

# ── Persona management ───────────────────────────────────────────────

# Shuffle personas: pick a random subset from personas.yaml and write into salon.yaml
# Usage: just shuffle          (picks 6)
#        just shuffle 4        (picks 4)
shuffle count="6":
    bun run src/cli/shuffle-personas.ts --count {{count}}

# ── Setup ────────────────────────────────────────────────────────────

# Install dependencies
install:
    bun install

# Type-check the project
check:
    npx tsc --noEmit

# Install fish shell completions (tab-complete room names)
fish-setup:
    @mkdir -p ~/.config/fish/conf.d
    @ln -sf "{{justfile_directory()}}/completions/k2-salon.fish" ~/.config/fish/conf.d/k2-salon.fish
    @echo "Fish completions installed. Restart your shell or run:"
    @echo "  source ~/.config/fish/conf.d/k2-salon.fish"

# ── Examples ─────────────────────────────────────────────────────────
# just room ai-thoughts          Resume the ai-thoughts room
# just room climate-policy        Create or resume climate-policy room
# just rooms                      See all rooms at a glance
# just models                     See what models are available

# just simulate "AI ethics"        Run a headless 10-message simulation
# just simulate "AI ethics" -- --messages 20
# just fish-setup                 Install tab completion for fish
