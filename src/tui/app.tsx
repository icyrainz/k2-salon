import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, Static, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentConfig, AgentColor, RoomMessage } from "../core/types.js";
import type { SalonEngine } from "../engine/salon-engine.js";
import { toInkColor } from "./colors.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

// ── Time formatting ─────────────────────────────────────────────────

function fmtTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Display message type ────────────────────────────────────────────

interface DisplayMessage {
  id: number;
  msg: RoomMessage;
  streamContent?: string;
  isStreaming?: boolean;
}

// ── Header ──────────────────────────────────────────────────────────

interface HeaderProps {
  roomName: string;
  session: number;
  topic: string;
  resumed: boolean;
}

function Header({ roomName, session, topic, resumed }: HeaderProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">k2-salon</Text>
        <Text dimColor> -- </Text>
        <Text bold>{roomName}</Text>
        <Text dimColor>  session {session}</Text>
        {resumed && <Text dimColor> (resumed)</Text>}
      </Box>
      <Box>
        <Text dimColor>Topic: </Text>
        <Text bold>{topic}</Text>
      </Box>
      <Box>
        <Text dimColor>{"=".repeat(60)}</Text>
      </Box>
    </Box>
  );
}

// ── Mention highlighting ────────────────────────────────────────────

let mentionColorMap = new Map<string, string>(); // agent name → ink color

function renderContent(text: string): React.ReactNode {
  if (mentionColorMap.size === 0) return text;

  const names = [...mentionColorMap.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "g",
  );

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const name = match[1];
    parts.push(
      <Text key={match.index} bold color={mentionColorMap.get(name)}>
        {name}
      </Text>,
    );
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? <>{parts}</> : text;
}

// ── Message rendering ───────────────────────────────────────────────

function ChatMessage({ dm }: { dm: DisplayMessage }) {
  const { msg, streamContent, isStreaming } = dm;
  const time = fmtTime(msg.timestamp);
  const inkColor = toInkColor(msg.color);

  switch (msg.kind) {
    case "join": {
      const providerInfo = msg.providerLabel && msg.modelLabel
        ? ` ${msg.providerLabel}/${msg.modelLabel}`
        : "";
      return (
        <Box>
          <Text dimColor>{time} </Text>
          <Text dimColor>{"-->>"} </Text>
          <Text bold color={inkColor}>{msg.agent}</Text>
          <Text dimColor> has joined </Text>
          <Text italic>({msg.content}{providerInfo ? ` \u00b7${providerInfo}` : ""})</Text>
        </Box>
      );
    }

    case "leave":
      return (
        <Box>
          <Text dimColor>{time} </Text>
          <Text dimColor>{"<<--"} </Text>
          <Text bold color={inkColor}>{msg.agent}</Text>
          <Text dimColor> has left </Text>
          <Text italic>({msg.content})</Text>
        </Box>
      );

    case "system":
      return (
        <Box>
          <Text dimColor>{time}   * {msg.content}</Text>
        </Box>
      );

    case "user":
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{time} </Text>
            <Text bold color="whiteBright">{"<YOU>"}</Text>
          </Box>
          <Box marginLeft={6}>
            <Text>{renderContent(msg.content)}</Text>
          </Box>
        </Box>
      );

    case "chat": {
      const content = isStreaming ? (streamContent ?? "") : msg.content;
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{time} </Text>
            <Text bold color={inkColor}>{"<"}{msg.agent}{">"}</Text>
          </Box>
          <Box marginLeft={6}>
            <Text>{renderContent(content)}</Text>
          </Box>
        </Box>
      );
    }

    default:
      return null;
  }
}

// ── Who table (local-only display) ──────────────────────────────────

function WhoTable({ agents }: { agents: AgentConfig[] }) {
  const nameWidth = Math.max(...agents.map(a => a.personality.name.length), 4);
  const provWidth = Math.max(
    ...agents.map(a => {
      const prov = a.providerName ?? a.provider;
      return `${prov}/${a.model}`.length;
    }),
    5,
  );

  return (
    <Box flexDirection="column" marginTop={0} marginBottom={0}>
      <Text dimColor>  {"=".repeat(60)}</Text>
      {agents.map((a) => {
        const prov = a.providerName ?? a.provider;
        const provModel = `${prov}/${a.model}`;
        return (
          <Box key={a.personality.name}>
            <Text>  </Text>
            <Text bold color={toInkColor(a.personality.color)}>
              {a.personality.name.padEnd(nameWidth + 2)}
            </Text>
            <Text dimColor>{provModel.padEnd(provWidth + 2)}</Text>
            <Text italic>{a.personality.tagline}</Text>
          </Box>
        );
      })}
      <Text dimColor>  {"=".repeat(60)}</Text>
    </Box>
  );
}

// ── Status bar ──────────────────────────────────────────────────────

function StatusBar({ agents }: { agents: { name: string; color: AgentColor }[] }) {
  return (
    <Box>
      <Text dimColor>  In room: </Text>
      {agents.map((a, i) => (
        <React.Fragment key={a.name}>
          {i > 0 && <Text dimColor>, </Text>}
          <Text color={toInkColor(a.color)}>{a.name}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

// ── Input line ──────────────────────────────────────────────────────

interface InputLineProps {
  onSubmit: (value: string) => void;
}

const COMMANDS = [
  { cmd: "/next",    hint: "advance discussion" },
  { cmd: "/who",     hint: "show participants" },
  { cmd: "/shuffle", hint: "new random roster" },
  { cmd: "/govern",  hint: "take control" },
  { cmd: "/free",    hint: "auto mode" },
  { cmd: "/quit",    hint: "exit" },
] as const;

type InputMode = "command" | "input";

function InputLine({ onSubmit }: InputLineProps) {
  const [mode, setMode] = useState<InputMode>("command");
  const [commandIndex, setCommandIndex] = useState(0);
  const [value, setValue] = useState("");

  const switchMode = useCallback(() => {
    setMode((m) => (m === "command" ? "input" : "command"));
    setValue("");
  }, []);

  const handleTextSubmit = useCallback(
    (val: string) => {
      if (val.trim()) onSubmit(val);
      setValue("");
      setMode("command");
    },
    [onSubmit],
  );

  // Command mode keys
  useInput(
    (input, key) => {
      if (key.tab && key.shift) {
        setCommandIndex((i) => (i - 1 + COMMANDS.length) % COMMANDS.length);
      } else if (key.tab) {
        setCommandIndex((i) => (i + 1) % COMMANDS.length);
      } else if (key.downArrow || key.upArrow || (key.ctrl && input === "n") || (key.ctrl && input === "p")) {
        switchMode();
      } else if (key.return) {
        onSubmit(COMMANDS[commandIndex].cmd);
      }
    },
    { isActive: mode === "command" },
  );

  // Input mode keys — only handle mode-switch when input is empty
  useInput(
    (input, key) => {
      if (
        !value &&
        (key.upArrow || (key.ctrl && input === "p") || key.escape)
      ) {
        switchMode();
      }
    },
    { isActive: mode === "input" },
  );

  if (mode === "input") {
    return (
      <Box>
        <Text dimColor>{">"} </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleTextSubmit}
          focus={true}
          placeholder="type your reply... [↑/Esc] commands"
        />
      </Box>
    );
  }

  return (
    <Box>
      <Text bold color="green">{">"} {COMMANDS[commandIndex].cmd}</Text>
      <Text dimColor>  {COMMANDS[commandIndex].hint}  [Tab] cycle commands  [↓] input mode</Text>
    </Box>
  );
}

// ── App (top-level) ─────────────────────────────────────────────────

export interface TuiProps {
  roomName: string;
  session: number;
  topic: string;
  resumed: boolean;
  contextCount: number;
}

export interface TuiHandle {
  pushMessage: (msg: RoomMessage) => void;
  setActiveAgents: (agents: readonly AgentConfig[]) => void;
  showWho: (agents: readonly AgentConfig[]) => void;
  setGoverned: (governed: boolean) => void;
}

// ── Engine events bridge ────────────────────────────────────────────
// The engine runs async alongside the React tree. We bridge via a
// module-level event queue that React drains on each flush.

type TuiEvent =
  | { type: "message"; msg: RoomMessage }
  | { type: "streamStart"; agent: string; color: AgentColor }
  | { type: "streamToken"; agent: string; token: string }
  | { type: "streamDone"; agent: string }
  | { type: "setActiveAgents"; agents: readonly AgentConfig[] }
  | { type: "showWho"; agents: readonly AgentConfig[] }
  | { type: "setGoverned"; governed: boolean };

let eventQueue: TuiEvent[] = [];
let eventFlush: (() => void) | null = null;

function emitTuiEvent(event: TuiEvent): void {
  eventQueue.push(event);
  eventFlush?.();
}

function App({
  engine,
  roomName,
  session,
  topic,
  resumed,
  contextCount,
  onUserInput,
  onQuit,
}: TuiProps & {
  engine: SalonEngine;
  onUserInput: (line: string) => void;
  onQuit: () => void;
}) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [activeAgents, setActiveAgents] = useState<readonly AgentConfig[]>([]);
  const [whoDisplay, setWhoDisplay] = useState<readonly AgentConfig[] | null>(null);
  const [governed, setGoverned] = useState(true);
  const [agentActivity, setAgentActivity] = useState<{
    agent: string;
    color: AgentColor;
    phase: "thinking" | "responding";
  } | null>(null);
  const nextId = useRef(0);
  const streamingRef = useRef<{
    agent: string;
    color: AgentColor;
    id: number;
    buffer: string;
  } | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to engine events
  useEffect(() => {
    const onThinking = (agent: string) => {
      // Finalize any previous stream
      const sr = streamingRef.current;
      if (sr !== null) {
        emitTuiEvent({ type: "streamDone", agent: sr.agent });
      }
      // Find the agent's color from the engine
      const agentConfig = engine.activeAgents.find(a => a.personality.name === agent);
      const color: AgentColor = agentConfig?.personality.color ?? "white";
      emitTuiEvent({ type: "streamStart", agent, color });
    };

    const onStreamToken = (agent: string, token: string) => {
      const sr = streamingRef.current;
      if (!sr || sr.agent !== agent) {
        // Late start — create stream entry
        if (sr !== null) {
          emitTuiEvent({ type: "streamDone", agent: sr.agent });
        }
        const agentConfig = engine.activeAgents.find(a => a.personality.name === agent);
        const color: AgentColor = agentConfig?.personality.color ?? "white";
        emitTuiEvent({ type: "streamStart", agent, color });
      }
      emitTuiEvent({ type: "streamToken", agent, token });
    };

    const onStreamDone = (agent: string) => {
      if (streamingRef.current?.agent === agent) {
        emitTuiEvent({ type: "streamDone", agent });
      }
    };

    engine.on("thinking", onThinking);
    engine.on("streamToken", onStreamToken);
    engine.on("streamDone", onStreamDone);

    return () => {
      engine.off("thinking", onThinking);
      engine.off("streamToken", onStreamToken);
      engine.off("streamDone", onStreamDone);
    };
  }, [engine]);

  // Process events from the bridge
  useEffect(() => {
    const processEvents = () => {
      const events = eventQueue.splice(0);
      if (events.length === 0) return;

      for (const event of events) {
        switch (event.type) {
          case "message": {
            if (
              event.msg.kind === "chat" &&
              streamingRef.current &&
              streamingRef.current.agent === event.msg.agent
            ) {
              break;
            }

            const id = nextId.current++;
            setMessages((prev) => [...prev, { id, msg: event.msg }]);
            break;
          }

          case "streamStart": {
            const id = nextId.current++;
            const placeholder: RoomMessage = {
              timestamp: new Date(),
              agent: event.agent,
              content: "",
              color: event.color,
              kind: "chat",
            };
            streamingRef.current = {
              agent: event.agent,
              color: event.color,
              id,
              buffer: "",
            };
            setMessages((prev) => [
              ...prev,
              { id, msg: placeholder, streamContent: "", isStreaming: true },
            ]);
            setAgentActivity({ agent: event.agent, color: event.color, phase: "thinking" });
            break;
          }

          case "streamToken": {
            const sr = streamingRef.current;
            if (sr && sr.agent === event.agent) {
              if (sr.buffer.length === 0) {
                setAgentActivity((prev) =>
                  prev && prev.agent === event.agent
                    ? { ...prev, phase: "responding" }
                    : prev,
                );
              }
              sr.buffer += event.token;
            }
            break;
          }

          case "streamDone": {
            const sr = streamingRef.current;
            if (sr && sr.agent === event.agent) {
              const finalContent = sr.buffer;
              const finalId = sr.id;
              streamingRef.current = null;
              setMessages((prev) =>
                prev.map((dm) =>
                  dm.id === finalId
                    ? {
                        ...dm,
                        msg: { ...dm.msg, content: finalContent },
                        streamContent: undefined,
                        isStreaming: false,
                      }
                    : dm,
                ),
              );
              setAgentActivity(null);
            }
            break;
          }

          case "setActiveAgents":
            setActiveAgents(event.agents);
            mentionColorMap = new Map<string, string>();
            for (const a of event.agents) {
              mentionColorMap.set(a.personality.name, toInkColor(a.personality.color));
            }
            break;

          case "showWho":
            setWhoDisplay(event.agents);
            setTimeout(() => setWhoDisplay(null), 8000);
            break;

          case "setGoverned":
            setGoverned(event.governed);
            break;
        }
      }
    };

    eventFlush = processEvents;
    return () => { eventFlush = null; };
  }, []);

  // Periodic flush of streaming buffer to UI (every 50ms)
  useEffect(() => {
    flushTimerRef.current = setInterval(() => {
      const sr = streamingRef.current;
      if (!sr) return;

      setMessages((prev) =>
        prev.map((dm) =>
          dm.id === sr.id && dm.isStreaming
            ? { ...dm, streamContent: sr.buffer }
            : dm,
        ),
      );
    }, 50);

    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, []);

  // Handle user submit
  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed === "/quit" || trimmed === "/exit") {
        onQuit();
        exit();
        return;
      }

      if (trimmed === "/who") {
        onUserInput("\x00WHO");
        return;
      }

      if (trimmed === "/next" || trimmed === "/n") {
        onUserInput("\x00NEXT");
        return;
      }

      if (trimmed === "/govern") {
        onUserInput("\x00GOVERN");
        return;
      }

      if (trimmed === "/free") {
        onUserInput("\x00FREE");
        return;
      }

      if (trimmed === "/shuffle") {
        onUserInput("\x00SHUFFLE");
        return;
      }

      onUserInput(trimmed);
    },
    [onUserInput, onQuit, exit],
  );

  const streamingDm = messages.find((dm) => dm.isStreaming);
  const settledMessages = messages.filter((dm) => !dm.isStreaming);

  return (
    <Box flexDirection="column">
      <Static items={[{ id: "header", roomName, session, topic, resumed, contextCount }]}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            <Header
              roomName={item.roomName}
              session={item.session}
              topic={item.topic}
              resumed={item.resumed}
            />
            {item.contextCount > 0 && (
              <Text dimColor>
                {"  "}Context: {item.contextCount} messages from prior conversations
              </Text>
            )}
          </Box>
        )}
      </Static>

      <Static items={settledMessages}>
        {(dm) => <ChatMessage key={dm.id} dm={dm} />}
      </Static>

      {streamingDm && <ChatMessage dm={streamingDm} />}

      {whoDisplay && <WhoTable agents={[...whoDisplay]} />}

      <Box>
        {activeAgents.length > 0 && (
          <StatusBar
            agents={[...activeAgents].map((a) => ({
              name: a.personality.name,
              color: a.personality.color,
            }))}
          />
        )}
        <Text> </Text>
        {governed
          ? <Text color="yellow" bold>[GOVERNED — /next to advance, /free for auto]</Text>
          : <Text dimColor>[AUTO — /govern to take control]</Text>
        }
      </Box>

      {agentActivity && (
        <Box>
          <Text>  </Text>
          <Spinner active={true} />
          <Text> </Text>
          <Text bold color={toInkColor(agentActivity.color)}>{agentActivity.agent}</Text>
          <Text dimColor>
            {agentActivity.phase === "thinking" ? " thinking..." : " responding..."}
          </Text>
        </Box>
      )}

      <Text dimColor>{"─".repeat(60)}</Text>

      <InputLine onSubmit={handleSubmit} />
    </Box>
  );
}

// ── Render + handle factory ─────────────────────────────────────────

export interface TuiInstance {
  handle: TuiHandle;
  waitUntilExit: () => Promise<void>;
}

export function renderTui(
  engine: SalonEngine,
  props: TuiProps,
  onUserInput: (line: string) => void,
  onQuit: () => void,
): TuiInstance {
  const instance = render(
    <App engine={engine} {...props} onUserInput={onUserInput} onQuit={onQuit} />,
  );

  const handle: TuiHandle = {
    pushMessage: (msg) => emitTuiEvent({ type: "message", msg }),
    setActiveAgents: (agents) =>
      emitTuiEvent({ type: "setActiveAgents", agents }),
    showWho: (agents) => emitTuiEvent({ type: "showWho", agents }),
    setGoverned: (governed) => emitTuiEvent({ type: "setGoverned", governed }),
  };

  return {
    handle,
    waitUntilExit: () => instance.waitUntilExit() as Promise<void>,
  };
}
