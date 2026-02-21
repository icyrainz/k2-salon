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
import {
  renderHeader,
  renderMessage,
  renderPresence,
  renderStreamEnd,
  renderStreamStart,
  renderStreamToken,
} from "./cli/renderer.js";
import type { RoomConfig, RoomMessage } from "./types.js";

// ── Readline for user input ─────────────────────────────────────────

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

// ── Non-blocking input buffer ───────────────────────────────────────
// Lines accumulate here as the user types. The room loop polls this
// between turns. The conversation never blocks waiting for you.

const inputBuffer: string[] = [];
let wantsQuit = false;

function startInputListener(): void {
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "/quit" || trimmed === "/exit") {
      wantsQuit = true;
    } else if (trimmed === "/who") {
      // handled inline — we push a sentinel
      inputBuffer.push("\x00WHO");
    } else if (trimmed) {
      inputBuffer.push(trimmed);
    }
    // empty line = just nudge, nothing added to buffer
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

  // Render the header
  renderHeader(topic, { roomName, session, resumed: isResumed });

  if (preloadedHistory.length > 0) {
    process.stdout.write(
      `\x1b[2m  Context: ${preloadedHistory.length} messages from prior conversations\x1b[0m\n\n`,
    );
  }

  // Track which agent is currently streaming
  const agentColorMap = new Map<string, string>();
  for (const agent of roster) {
    agentColorMap.set(agent.personality.name, agent.personality.color);
  }

  let streamingAgent: string | null = null;

  // Initialize transcript with participant names
  await transcript.init(roster.map(a => a.personality.name));

  // Wire up callbacks
  const callbacks: RoomCallbacks = {
    onMessage: (msg) => {
      // Write to transcript
      transcript.append(msg);

      // Render join/leave/system messages directly
      if (msg.kind !== "chat" && msg.kind !== "user") {
        renderMessage(msg);
      }
      // After join/leave, show current room members
      if (msg.kind === "join" || msg.kind === "leave") {
        renderPresence(
          state.activeAgents.map(a => ({
            name: a.personality.name,
            color: a.personality.color,
          })),
        );
      }
    },

    onStreamToken: (agent, token) => {
      if (streamingAgent !== agent) {
        if (streamingAgent !== null) {
          renderStreamEnd();
        }
        streamingAgent = agent;
        renderStreamStart(agent, agentColorMap.get(agent) ?? "\x1b[37m");
      }
      renderStreamToken(token);
    },

    onStreamDone: (agent) => {
      if (streamingAgent === agent) {
        renderStreamEnd();
        streamingAgent = null;
      }
    },

    pollUserInput: () => {
      if (wantsQuit) return null;

      // Drain buffer — handle /who sentinel, return first real message
      while (inputBuffer.length > 0) {
        const line = inputBuffer.shift()!;
        if (line === "\x00WHO") {
          renderPresence(
            state.activeAgents.map(a => ({
              name: a.personality.name,
              color: a.personality.color,
            })),
          );
          continue;
        }
        return line;
      }

      return undefined; // nothing pending
    },
  };

  // Handle Ctrl+C gracefully — finalize transcript
  process.on("SIGINT", async () => {
    process.stdout.write("\n\x1b[2m  * Room closed. Goodbye.\x1b[0m\n");
    stopRoom(state);
    await transcript.finalize();
    process.stdout.write(
      `\x1b[2m  * Session ${session} saved to rooms/${roomName}/\x1b[0m\n\n`,
    );
    rl.close();
    process.exit(0);
  });

  // Start listening for user input (non-blocking)
  startInputListener();

  // Start the conversation — agents talk autonomously, you're an observer
  // Type anytime to chime in, press enter to nudge, /quit to leave
  await runRoom(state, callbacks);

  // Finalize transcript on normal exit
  await transcript.finalize();
  process.stdout.write(
    `\n\x1b[2m  * Session ${session} saved to rooms/${roomName}/\x1b[0m\n\n`,
  );
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
