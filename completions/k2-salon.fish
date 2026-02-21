# k2-salon fish completions
# Source this file, or symlink it into ~/.config/fish/conf.d/
#
#   ln -sf (pwd)/completions/k2-salon.fish ~/.config/fish/conf.d/k2-salon.fish
#
# Provides:
#   salon <TAB>           →  list recipes (room, rooms, models, etc.)
#   salon room <TAB>      →  list existing rooms (+ free text for new)
#   salon models / rooms  →  no extra args needed

# ── The `salon` wrapper function ─────────────────────────────────────
# Runs `just` from the k2-salon project directory so it works from
# anywhere in your shell, not just inside the project.

function salon -d "k2-salon — Multi-AI Debate Room"
    set -l project_dir (status dirname 2>/dev/null; or echo "")

    # Walk up from cwd to find a justfile with k2-salon marker
    if test -z "$project_dir"
        set project_dir (pwd)
        while test "$project_dir" != "/"
            if test -f "$project_dir/justfile"; and test -d "$project_dir/rooms"
                break
            end
            set project_dir (dirname "$project_dir")
        end
    end

    # Fallback: try to resolve from this script's symlink target
    if not test -f "$project_dir/justfile"
        set -l link_target (realpath (status filename) 2>/dev/null)
        if test -n "$link_target"
            set project_dir (dirname (dirname "$link_target"))
        end
    end

    if not test -f "$project_dir/justfile"
        echo "k2-salon: could not find project directory" >&2
        return 1
    end

    just --justfile "$project_dir/justfile" --working-directory "$project_dir" $argv
end

# ── Helper: list existing room directories ───────────────────────────

function __k2_salon_find_project
    # Try from cwd first
    set -l dir (pwd)
    while test "$dir" != "/"
        if test -d "$dir/rooms"; and test -f "$dir/justfile"
            echo "$dir"
            return
        end
        set dir (dirname "$dir")
    end

    # Fallback: resolve from symlink
    set -l link_target (realpath (status filename) 2>/dev/null)
    if test -n "$link_target"
        set dir (dirname (dirname "$link_target"))
        if test -d "$dir/rooms"
            echo "$dir"
            return
        end
    end
end

function __k2_salon_rooms
    set -l project (__k2_salon_find_project)
    if test -z "$project"
        return
    end

    for dir in $project/rooms/*/
        if test -d "$dir"
            set -l name (basename "$dir")
            if test -f "$dir/room.yaml"
                set -l topic (string match -r 'topic:\s*(.+)' < "$dir/room.yaml" | tail -1 | string trim)
                printf '%s\t%s\n' "$name" "$topic"
            else
                set -l seed_count (count $dir/*.md 2>/dev/null)
                printf '%s\t%s\n' "$name" "new — $seed_count seed files"
            end
        end
    end
end

# ── Completions for `salon` command ──────────────────────────────────

# Disable default file completions
complete -c salon -f

# Top-level recipes (only when no subcommand yet)
complete -c salon -n __fish_use_subcommand -a room    -d "Start or resume a room"
complete -c salon -n __fish_use_subcommand -a rooms   -d "List all rooms and their status"
complete -c salon -n __fish_use_subcommand -a models  -d "List available models from all providers"
complete -c salon -n __fish_use_subcommand -a start   -d "Start interactively"
complete -c salon -n __fish_use_subcommand -a check   -d "Type-check the project"
complete -c salon -n __fish_use_subcommand -a install -d "Install dependencies"

# `salon room <name>` — complete with existing rooms
complete -c salon -n '__fish_seen_subcommand_from room' -a '(__k2_salon_rooms)'
