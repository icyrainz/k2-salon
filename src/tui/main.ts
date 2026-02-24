import { createInterface } from "readline";
import { PERSONALITY_PRESETS } from "../core/roster.js";
import { loadConfig, resolveRoster } from "../engine/config.js";
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
} from "../engine/persist.js";
import { SalonEngine } from "../engine/salon-engine.js";
import { renderTui } from "./app.js";
import { toInkColor } from "./colors.js";
import type { RoomConfig, RoomMessage } from "../core/types.js";
import { generateAndCacheTts, playTts } from "../engine/tts.js";

// ── Pre-TUI prompts ────────────────────────────────────────────────

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // Parse args: strip --lang <value> flag before treating remainder as room name
  const rawArgs = process.argv.slice(2);
  let langFlag: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--lang" && i + 1 < rawArgs.length) {
      langFlag = rawArgs[++i];
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }
  const arg = filteredArgs.join(" ").trim();

  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);

  let roomName: string;
  let topic: string;
  let language: string;
  let preloadedHistory: RoomMessage[] = [];
  let isResumed = false;
  let savedRoster: string[] | undefined;

  if (!arg) {
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

  if (roomExists(roomName)) {
    const meta = await loadRoomMeta(roomName);
    if (meta) {
      topic = meta.topic;
      language = langFlag ?? meta.language ?? salonConfig.room.language;
      savedRoster = meta.activeRoster;
      isResumed = true;
      const prevMessages = await loadPreviousSessions(
        roomName,
        salonConfig.room.contextWindow,
      );
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
          if (!topic) {
            process.stdout.write("No topic provided. Exiting.\n");
            process.exit(0);
          }
        }
      } else {
        topic = await ask("Topic for this room: ");
        topic = topic.trim();
        if (!topic) {
          process.stdout.write("No topic provided. Exiting.\n");
          process.exit(0);
        }
      }
      language = langFlag ?? salonConfig.room.language;
      await saveRoomMeta(roomName, {
        topic,
        language,
        created: new Date().toISOString(),
        lastSession: 0,
      });
    }
  } else {
    topic = await ask(`Creating new room "${roomName}". Topic: `);
    topic = topic.trim();
    if (!topic) {
      process.stdout.write("No topic provided. Exiting.\n");
      process.exit(0);
    }

    if (langFlag) {
      language = langFlag;
    } else {
      const langAnswer = await ask("Language (leave blank for English): ");
      language = langAnswer.trim() || salonConfig.room.language;
    }

    await createRoomDir(roomName);
    await saveRoomMeta(roomName, {
      topic,
      language,
      created: new Date().toISOString(),
      lastSession: 0,
    });
  }

  const session = await nextSessionNumber(roomName);
  const transcript = new TranscriptWriter(roomName, session, topic);

  const meta = await loadRoomMeta(roomName);
  if (meta) {
    meta.lastSession = session;
    await saveRoomMeta(roomName, meta);
  }

  const config: RoomConfig = { ...salonConfig.room, topic, language };
  const engine = new SalonEngine(config, roster, preloadedHistory, savedRoster);

  await transcript.init(roster.map((a) => a.personality.name));

  // ── Clean stdin before ink takes over ─────────────────────────────
  process.stdin.removeAllListeners();
  process.stdin.pause();

  // ── Input buffer: TUI writes here, room loop reads ─────────────────
  const inputBuffer: string[] = [];
  const ttsMessageMap = new Map<string, string>();
  let wantsQuit = false;

  /** Persist the current active roster to room.yaml */
  const saveActiveRoster = async () => {
    const m = await loadRoomMeta(roomName);
    if (m) {
      m.activeRoster = [...engine.activeAgents].map((a) => a.personality.name);
      await saveRoomMeta(roomName, m);
    }
  };

  let activeTtsProc: ReturnType<typeof Bun.spawn> | null = null;
  let activeTtsSendCommand: ((cmd: string) => void) | null = null;
  let activeTtsCleanup: (() => void) | null = null;

  const handleUserInput = (line: string) => {
    if (line === "\x00WHO") {
      tui.handle.showWho([...engine.activeAgents]);
    } else if (line === "\x00TTS_STOP") {
      if (activeTtsProc) {
        activeTtsProc.kill();
        activeTtsCleanup?.();
        activeTtsProc = null;
        activeTtsSendCommand = null;
        activeTtsCleanup = null;
        tui.handle.setTtsActivity(null);
      }
    } else if (line.startsWith("\x00TTS_CMD:")) {
      const cmd = line.slice(9);
      activeTtsSendCommand?.(cmd);
    } else if (line.startsWith("\x00TTS:")) {
      const parts = line.slice(5).split(":");
      const msgId = parts[0];
      const agentName = parts.slice(1).join(":");
      handleTts(msgId, agentName);
    } else {
      inputBuffer.push(line);
    }
  };

  const handleTts = async (msgId: string, agentName: string) => {
    const agentConfig = roster.find((a) => a.personality.name === agentName);
    const color = agentConfig?.personality.color ?? ("white" as const);

    tui.handle.setTtsActivity({ agent: agentName, color, phase: "generating" });

    try {
      const content = ttsMessageMap.get(msgId);
      if (!content) {
        tui.handle.setTtsActivity(null);
        return;
      }

      const filePath = await generateAndCacheTts(
        roomName,
        msgId,
        content,
        agentName,
      );

      tui.handle.setTtsActivity({ agent: agentName, color, phase: "playing" });
      const { proc, done, sendCommand, cleanup } = playTts(filePath, (p) => {
        tui.handle.setTtsActivity({
          agent: agentName,
          color,
          phase: "playing",
          position: p.position,
          duration: p.duration,
          speed: p.speed,
          paused: p.paused,
        });
      });
      activeTtsProc = proc;
      activeTtsSendCommand = sendCommand;
      activeTtsCleanup = cleanup;
      await done;
      cleanup();
      activeTtsProc = null;
      activeTtsSendCommand = null;
      activeTtsCleanup = null;
    } catch (err: any) {
      tui.handle.pushMessage({
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `[TTS error: ${err.message}]`,
        color: "gray",
        kind: "system",
      });
    } finally {
      tui.handle.setTtsActivity(null);
    }
  };

  const handleQuit = () => {
    wantsQuit = true;
    engine.stop();
  };

  // ── Mount TUI ──────────────────────────────────────────────────────
  const tui = renderTui(
    engine,
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

  // Subscribe to engine messages for transcript writing + TUI updates
  engine.on("message", (msg) => {
    transcript.append(msg);
    // Push ALL messages to TUI — chat messages merge their engine ID
    // into the existing streaming placeholder (see app.tsx message handler)
    tui.handle.pushMessage(msg);
    if (msg.kind === "join" || msg.kind === "leave") {
      tui.handle.setActiveAgents([...engine.activeAgents]);
      saveActiveRoster();
    }
    if ((msg.kind === "chat" || msg.kind === "user") && msg.id !== undefined) {
      ttsMessageMap.set(msg.id, msg.content);
    }
  });

  process.on("SIGINT", async () => {
    engine.stop();
    wantsQuit = true;
    await transcript.finalize();
    process.exit(0);
  });

  // ── Show recent history in TUI when resuming ──────────────────────
  tui.handle.setActiveAgents([...engine.activeAgents]);
  if (isResumed && preloadedHistory.length > 0) {
    const TAIL = 20;
    const conversationOnly = preloadedHistory.filter(
      (m) => m.kind === "chat" || m.kind === "user",
    );
    const tail = conversationOnly.slice(-TAIL);
    if (conversationOnly.length > TAIL) {
      tui.handle.pushMessage({
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `... ${conversationOnly.length - TAIL} earlier messages omitted ...`,
        color: "gray",
        kind: "system",
      });
    }

    const agentColorMap = new Map<string, string>();
    for (const agent of roster) {
      agentColorMap.set(agent.personality.name, agent.personality.color);
    }

    for (const msg of tail) {
      // Restore color from roster (markdown transcripts don't store colors)
      if (msg.agent && agentColorMap.has(msg.agent)) {
        (msg as any).color = agentColorMap.get(msg.agent)!;
      }
      tui.handle.pushMessage(msg);
    }
    tui.handle.pushMessage({
      timestamp: new Date(),
      agent: "SYSTEM",
      content: "─── new session ───",
      color: "gray",
      kind: "system",
    });

    for (const msg of preloadedHistory) {
      if (
        (msg.kind === "chat" || msg.kind === "user") &&
        msg.id !== undefined
      ) {
        ttsMessageMap.set(msg.id, msg.content);
      }
    }
  }

  // ── Open room (emits topic + join messages via engine events) ──────
  engine.open();
  tui.handle.setActiveAgents([...engine.activeAgents]);
  await saveActiveRoster();

  let governed = true;
  tui.handle.setGoverned(governed);

  // ── Main TUI loop ──────────────────────────────────────────────────

  while (engine.running && !wantsQuit) {
    const nextSpeaker = engine.peekNextSpeaker();

    if (governed) {
      if (nextSpeaker) {
        const readyMsg: RoomMessage = {
          timestamp: new Date(),
          agent: "SYSTEM",
          content: `[${nextSpeaker.personality.name} is ready — /next to let them speak, or type a reply]`,
          color: "gray",
          kind: "system",
        };
        tui.handle.pushMessage(readyMsg);
      }

      let advanced = false;
      while (!advanced && engine.running && !wantsQuit) {
        await engine.sleep(120);
        const input = inputBuffer.shift();
        if (input === undefined) continue;
        if (input === "\x00NEXT") {
          advanced = true;
          break;
        }
        if (input === "\x00FREE") {
          governed = false;
          tui.handle.setGoverned(false);
          advanced = true;
          break;
        }
        if (input === "\x00GOVERN") continue;
        if (input === "\x00SHUFFLE") {
          engine.shuffle();
          tui.handle.setActiveAgents([...engine.activeAgents]);
          await saveActiveRoster();
          break;
        }
        if (input.trim()) {
          engine.injectUserMessage(input);
          advanced = true;
        }
      }

      if (!engine.running || wantsQuit) break;
      if (!advanced) continue;

      await engine.step({
        verbose: true,
        churn: false,
        speaker: nextSpeaker ?? undefined,
      });

      let stale: string | undefined;
      while ((stale = inputBuffer.shift()) !== undefined) {
        if (stale === "\x00NEXT") continue;
        if (stale === "\x00FREE") {
          governed = false;
          tui.handle.setGoverned(false);
          break;
        }
        if (stale === "\x00GOVERN") break;
        if (stale === "\x00SHUFFLE") {
          engine.shuffle();
          tui.handle.setActiveAgents([...engine.activeAgents]);
          await saveActiveRoster();
          break;
        }
        if (stale.trim()) {
          engine.injectUserMessage(stale);
          break;
        }
      }
    } else {
      const jitter = Math.random() * 3000;
      await engine.sleep(engine.config.turnDelayMs + jitter);

      if (!engine.running || wantsQuit) break;

      const input = inputBuffer.shift();
      if (input === "\x00GOVERN") {
        governed = true;
        tui.handle.setGoverned(true);
      } else if (input === "\x00SHUFFLE") {
        engine.shuffle();
        tui.handle.setActiveAgents([...engine.activeAgents]);
        await saveActiveRoster();
      } else if (input?.trim()) engine.injectUserMessage(input);

      await engine.step({ verbose: false, churn: true });
    }
  }

  await transcript.finalize();
  setTimeout(() => process.exit(0), 100);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
