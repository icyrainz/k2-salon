import { createInterface } from "readline";
import { PERSONALITY_PRESETS } from "./agents/roster.js";
import { loadConfig, resolveRoster } from "./config/loader.js";
import { createRoom, runRoom, stopRoom, type RoomCallbacks } from "./room/room.js";
import {
  loadRoomMeta,
  saveRoomMeta,
  loadSeedMaterial,
  loadPreviousSessions,
  nextSessionNumber,
  parseSeedToMessages,
  roomExists,
  createRoomDir,
  TranscriptWriter,
} from "./room/persist.js";
import { renderTui, type TuiHandle } from "./cli/tui.js";
import type { RoomConfig, RoomMessage } from "./types.js";

// ── Readline for pre-TUI user input ────────────────────────────────
// We use readline only for room setup (name, topic) before ink takes
// over stdin. Once the TUI is mounted, readline is closed.

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    rl.once("line", resolve);
  });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv.slice(2).join(" ").trim();

  // Load salon configuration
  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);

  let roomName: string;
  let topic: string;
  let preloadedHistory: RoomMessage[] = [];
  let isResumed = false;

  if (!arg) {
    // Interactive mode: ask for room name
    process.stdout.write("\x1b[1mk2-salon\x1b[0m — Multi-AI Debate Room\n\n");
    roomName = await ask("Room name (creates new if doesn't exist): ");
    roomName = roomName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!roomName) {
      process.stdout.write("No room name provided. Exiting.\n");
      process.exit(0);
    }
  } else {
    roomName = arg.toLowerCase().replace(/\s+/g, "-");
  }

  // ── Resolve room: existing or new ──────────────────────────────────

  if (roomExists(roomName)) {
    const meta = await loadRoomMeta(roomName);

    if (meta) {
      // Existing room with metadata — resume
      topic = meta.topic;
      isResumed = true;

      // Load previous session messages for context
      const prevMessages = await loadPreviousSessions(roomName, salonConfig.room.contextWindow);
      preloadedHistory.push(...prevMessages);

      process.stdout.write(
        `\x1b[2m  Resuming room "${roomName}" — ${prevMessages.length} messages loaded from previous sessions\x1b[0m\n`,
      );
    } else {
      // Room dir exists but no room.yaml — check for seed material
      const seed = await loadSeedMaterial(roomName);

      if (seed) {
        // Parse seed into context messages
        const seedMessages = parseSeedToMessages(seed);
        preloadedHistory.push(...seedMessages);

        // Try to extract topic from seed (first markdown heading)
        const headingMatch = seed.match(/^#\s+(.+)/m);
        if (headingMatch) {
          topic = headingMatch[1].trim();
          process.stdout.write(
            `\x1b[2m  Found seed material in "${roomName}" — topic: ${topic}\x1b[0m\n`,
          );
        } else {
          process.stdout.write(
            `\x1b[2m  Found seed material in "${roomName}"\x1b[0m\n`,
          );
          topic = await ask("Topic for this room: ");
          topic = topic.trim();
          if (!topic) {
            process.stdout.write("No topic provided. Exiting.\n");
            process.exit(0);
          }
        }

        process.stdout.write(
          `\x1b[2m  Loaded ${seedMessages.length} messages from seed material\x1b[0m\n`,
        );
      } else {
        // Empty room dir, no seed — ask for topic
        topic = await ask("Topic for this room: ");
        topic = topic.trim();
        if (!topic) {
          process.stdout.write("No topic provided. Exiting.\n");
          process.exit(0);
        }
      }

      // Save room metadata
      await saveRoomMeta(roomName, {
        topic,
        created: new Date().toISOString(),
        lastSession: 0,
      });
    }
  } else {
    // New room — create directory and ask for topic
    topic = await ask(`Creating new room "${roomName}". Topic: `);
    topic = topic.trim();
    if (!topic) {
      process.stdout.write("No topic provided. Exiting.\n");
      process.exit(0);
    }

    await createRoomDir(roomName);
    await saveRoomMeta(roomName, {
      topic,
      created: new Date().toISOString(),
      lastSession: 0,
    });
  }

  // ── Set up session ─────────────────────────────────────────────────

  const session = await nextSessionNumber(roomName);
  const transcript = new TranscriptWriter(roomName, session, topic);

  // Update room metadata
  const meta = await loadRoomMeta(roomName);
  if (meta) {
    meta.lastSession = session;
    await saveRoomMeta(roomName, meta);
  }

  // Room configuration
  const config: RoomConfig = {
    topic,
    ...salonConfig.room,
  };

  // Create the room with our roster and any preloaded history
  const state = createRoom(config, roster, preloadedHistory);

  // Initialize transcript with participant names
  await transcript.init(roster.map((a) => a.personality.name));

  // ── Close readline before ink takes over stdin ─────────────────────

  rl.close();

  // ── Non-blocking input buffer ──────────────────────────────────────
  // The TUI writes user lines here. The room loop polls this.

  const inputBuffer: string[] = [];
  let wantsQuit = false;

  const handleUserInput = (line: string) => {
    if (line === "\x00WHO") {
      // /who command — show the who table via TUI
      tui.handle.showWho([...state.activeAgents]);
    } else {
      inputBuffer.push(line);
    }
  };

  const handleQuit = () => {
    wantsQuit = true;
  };

  // ── Mount the TUI ──────────────────────────────────────────────────

  const tui = renderTui(
    {
      roomName,
      session,
      topic,
      resumed: isResumed,
      contextCount: preloadedHistory.length,
    },
    handleUserInput,
    handleQuit,
  );

  // Build color map for stream callbacks
  const agentColorMap = new Map<string, string>();
  for (const agent of roster) {
    agentColorMap.set(agent.personality.name, agent.personality.color);
  }

  // ── Wire up room callbacks to TUI ──────────────────────────────────

  const callbacks: RoomCallbacks = {
    onMessage: (msg) => {
      // Write to transcript
      transcript.append(msg);

      // Push to TUI (for join/leave/system/user messages)
      // Chat messages are handled via streaming, but we still need the
      // final message for transcript. Don't push chat messages to TUI
      // since they're already shown via streaming.
      if (msg.kind !== "chat") {
        tui.handle.pushMessage(msg);
      }

      // Update active agents list on join/leave
      if (msg.kind === "join" || msg.kind === "leave") {
        tui.handle.setActiveAgents([...state.activeAgents]);
      }
    },

    onStreamToken: (agent, token) => {
      // If this is a new agent starting to stream, signal stream start
      if (!streamingAgent || streamingAgent !== agent) {
        if (streamingAgent !== null) {
          tui.handle.streamDone(streamingAgent);
        }
        streamingAgent = agent;
        tui.handle.streamStart(agent, agentColorMap.get(agent) ?? "\x1b[37m");
      }
      tui.handle.streamToken(agent, token);
    },

    onStreamDone: (agent) => {
      if (streamingAgent === agent) {
        tui.handle.streamDone(agent);
        streamingAgent = null;
      }
    },

    pollUserInput: () => {
      if (wantsQuit) return null;

      // Drain buffer
      while (inputBuffer.length > 0) {
        const line = inputBuffer.shift()!;
        return line;
      }

      return undefined; // nothing pending
    },
  };

  let streamingAgent: string | null = null;

  // ── Run the room engine ────────────────────────────────────────────

  // Handle SIGINT gracefully
  process.on("SIGINT", async () => {
    stopRoom(state);
    await transcript.finalize();
    wantsQuit = true;
  });

  // Start the conversation
  await runRoom(state, callbacks);

  // Finalize transcript on normal exit
  await transcript.finalize();

  // Wait briefly for TUI to settle, then exit
  setTimeout(() => process.exit(0), 100);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
