import { createInterface } from "readline";
import { PERSONALITY_PRESETS } from "./agents/roster.js";
import { loadConfig, resolveRoster } from "./config/loader.js";
import {
  createRoom,
  openRoom,
  stepRoom,
  stopRoom,
  injectUserMessage,
  sleepAbortable,
  type RoomCallbacks,
} from "./room/room.js";
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
import { renderTui } from "./cli/tui.js";
import type { RoomConfig, RoomMessage } from "./types.js";

// ── Pre-TUI prompts ────────────────────────────────────────────────

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv.slice(2).join(" ").trim();

  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);

  let roomName: string;
  let topic: string;
  let preloadedHistory: RoomMessage[] = [];
  let isResumed = false;

  if (!arg) {
    process.stdout.write("\x1b[1mk2-salon\x1b[0m — Multi-AI Debate Room\n\n");
    roomName = await ask("Room name (creates new if doesn't exist): ");
    roomName = roomName.trim().toLowerCase().replace(/\s+/g, "-");
    if (!roomName) { process.stdout.write("No room name provided. Exiting.\n"); process.exit(0); }
  } else {
    roomName = arg.toLowerCase().replace(/\s+/g, "-");
  }

  if (roomExists(roomName)) {
    const meta = await loadRoomMeta(roomName);
    if (meta) {
      topic = meta.topic;
      isResumed = true;
      const prevMessages = await loadPreviousSessions(roomName, salonConfig.room.contextWindow);
      preloadedHistory.push(...prevMessages);
      process.stdout.write(
        `\x1b[2m  Resuming room "${roomName}" — ${prevMessages.length} messages loaded\x1b[0m\n`,
      );
    } else {
      const seed = await loadSeedMaterial(roomName);
      if (seed) {
        const seedMessages = parseSeedToMessages(seed);
        preloadedHistory.push(...seedMessages);
        const headingMatch = seed.match(/^#\s+(.+)/m);
        if (headingMatch) {
          topic = headingMatch[1].trim();
        } else {
          topic = await ask("Topic for this room: ");
          topic = topic.trim();
          if (!topic) { process.stdout.write("No topic provided. Exiting.\n"); process.exit(0); }
        }
      } else {
        topic = await ask("Topic for this room: ");
        topic = topic.trim();
        if (!topic) { process.stdout.write("No topic provided. Exiting.\n"); process.exit(0); }
      }
      await saveRoomMeta(roomName, { topic, created: new Date().toISOString(), lastSession: 0 });
    }
  } else {
    topic = await ask(`Creating new room "${roomName}". Topic: `);
    topic = topic.trim();
    if (!topic) { process.stdout.write("No topic provided. Exiting.\n"); process.exit(0); }
    await createRoomDir(roomName);
    await saveRoomMeta(roomName, { topic, created: new Date().toISOString(), lastSession: 0 });
  }

  const session = await nextSessionNumber(roomName);
  const transcript = new TranscriptWriter(roomName, session, topic);

  const meta = await loadRoomMeta(roomName);
  if (meta) { meta.lastSession = session; await saveRoomMeta(roomName, meta); }

  const config: RoomConfig = { topic, ...salonConfig.room };
  const state = createRoom(config, roster, preloadedHistory);

  await transcript.init(roster.map((a) => a.personality.name));

  // ── Clean stdin before ink takes over ─────────────────────────────
  process.stdin.removeAllListeners();
  process.stdin.pause();

  // ── Input buffer: TUI writes here, room loop reads ─────────────────
  const inputBuffer: string[] = [];
  let wantsQuit = false;

  const handleUserInput = (line: string) => {
    if (line === "\x00WHO") {
      tui.handle.showWho([...state.activeAgents]);
    } else {
      inputBuffer.push(line);
    }
  };

  const handleQuit = () => {
    wantsQuit = true;
    stopRoom(state);
  };

  // ── Mount TUI ──────────────────────────────────────────────────────
  const tui = renderTui(
    { roomName, session, topic, resumed: isResumed, contextCount: preloadedHistory.length },
    handleUserInput,
    handleQuit,
  );

  const agentColorMap = new Map<string, string>();
  for (const agent of roster) {
    agentColorMap.set(agent.personality.name, agent.personality.color);
  }

  // Streaming state tracked here in the TUI layer
  let streamingAgent: string | null = null;

  const callbacks: RoomCallbacks = {
    onMessage: (msg) => {
      transcript.append(msg);
      if (msg.kind !== "chat") tui.handle.pushMessage(msg);
      if (msg.kind === "join" || msg.kind === "leave") {
        tui.handle.setActiveAgents([...state.activeAgents]);
      }
    },
    onStreamToken: (agent, token) => {
      if (!streamingAgent || streamingAgent !== agent) {
        if (streamingAgent !== null) tui.handle.streamDone(streamingAgent);
        streamingAgent = agent;
        tui.handle.streamStart(agent, agentColorMap.get(agent) ?? "\x1b[37m");
      }
      tui.handle.streamToken(agent, token);
    },
    onStreamDone: (agent) => {
      if (streamingAgent === agent) { tui.handle.streamDone(agent); streamingAgent = null; }
    },
  };

  process.on("SIGINT", async () => {
    stopRoom(state);
    wantsQuit = true;
    await transcript.finalize();
    process.exit(0);
  });

  // ── Open room (emits topic + join messages) ────────────────────────
  openRoom(state, callbacks);
  tui.handle.setActiveAgents([...state.activeAgents]);
  tui.handle.setGoverned(state.governed);

  // ── Main TUI loop ──────────────────────────────────────────────────
  // The governed wait and free-mode pacing both live here, not in the engine.

  while (state.running && !wantsQuit) {
    const nextSpeaker = pickNextSpeakerPreview(state);

    if (state.governed) {
      // Announce who is up and wait for /next (or a user message)
      if (nextSpeaker) {
        const readyMsg: RoomMessage = {
          timestamp: new Date(),
          agent: "SYSTEM",
          content: `[${nextSpeaker.personality.name} is ready — /next to let them speak, or type a reply]`,
          color: "\x1b[90m",
          kind: "system",
        };
        tui.handle.pushMessage(readyMsg);
      }

      // Wait for /next, /free, user text, or quit
      let advanced = false;
      while (!advanced && state.running && !wantsQuit) {
        await sleepAbortable(120, state.abortController.signal);

        // Drain one item from the input buffer
        const input = inputBuffer.shift();
        if (input === undefined) continue;
        if (input === "\x00NEXT") { advanced = true; break; }
        if (input === "\x00FREE") {
          state.governed = false;
          tui.handle.setGoverned(false);
          advanced = true;
          break;
        }
        if (input === "\x00GOVERN") continue; // already governed
        if (input.trim()) {
          injectUserMessage(state, input, callbacks);
          advanced = true;
        }
      }

      if (!state.running || wantsQuit) break;

      // Drain any stale /next that queued up during streaming
      const step = stepRoom(state, callbacks);
      await step;

      // Flush stale sentinels accumulated while agent was streaming
      let stale: string | undefined;
      while ((stale = inputBuffer.shift()) !== undefined) {
        if (stale === "\x00FREE") { state.governed = false; tui.handle.setGoverned(false); break; }
        if (stale === "\x00GOVERN") break; // handled below
        if (stale === "\x00NEXT") continue; // discard
        if (stale.trim()) { injectUserMessage(state, stale, callbacks); break; }
      }
    } else {
      // Free mode: natural pacing delay, then step
      const jitter = Math.random() * 3000;
      await sleepAbortable(state.config.turnDelayMs + jitter, state.abortController.signal);

      if (!state.running || wantsQuit) break;

      // Check for user input before stepping
      const input = inputBuffer.shift();
      if (input === null || wantsQuit) break;
      if (input === "\x00GOVERN") { state.governed = true; tui.handle.setGoverned(true); }
      else if (input?.trim()) injectUserMessage(state, input, callbacks);

      await stepRoom(state, callbacks);
    }
  }

  await transcript.finalize();
  setTimeout(() => process.exit(0), 100);
}

// ── Peek at who would speak next (mirrors pickSpeaker logic) ────────
// Used only for the governed-mode announcement; the engine re-picks internally.

function pickNextSpeakerPreview(state: ReturnType<typeof createRoom>) {
  const { activeAgents, lastSpeaker, turnsSinceSpoke } = state;
  const candidates = activeAgents.filter(a => {
    const turns = turnsSinceSpoke.get(a.personality.name) ?? 2;
    return a.personality.name !== lastSpeaker && turns >= 1;
  });
  if (candidates.length === 0) return activeAgents.find(a => a.personality.name !== lastSpeaker) ?? null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
