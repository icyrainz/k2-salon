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

# just fish-setup                 Install tab completion for fish
