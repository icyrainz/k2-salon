import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, Static, useApp } from "ink";
import TextInput from "ink-text-input";
import type { AgentConfig, RoomMessage } from "../types.js";

// ── ANSI color to ink color mapping ─────────────────────────────────

const ANSI_TO_INK: Record<string, string> = {
  "\x1b[30m": "black",
  "\x1b[31m": "red",
  "\x1b[32m": "green",
  "\x1b[33m": "yellow",
  "\x1b[34m": "blue",
  "\x1b[35m": "magenta",
  "\x1b[36m": "cyan",
  "\x1b[37m": "white",
  "\x1b[90m": "gray",
  "\x1b[91m": "redBright",
  "\x1b[92m": "greenBright",
  "\x1b[93m": "yellowBright",
  "\x1b[94m": "blueBright",
  "\x1b[95m": "magentaBright",
  "\x1b[96m": "cyanBright",
  "\x1b[97m": "whiteBright",
};

function ansiToInk(ansi: string): string {
  return ANSI_TO_INK[ansi] ?? "white";
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
  /** For streaming messages, the content accumulates here */
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

// ── Message rendering ───────────────────────────────────────────────

function ChatMessage({ dm }: { dm: DisplayMessage }) {
  const { msg, streamContent, isStreaming } = dm;
  const time = fmtTime(msg.timestamp);
  const inkColor = ansiToInk(msg.color);

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
            <Text>{msg.content}</Text>
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
            <Text>{content}{isStreaming ? "\u2588" : ""}</Text>
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
  // Find max widths for alignment
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
            <Text bold color={ansiToInk(a.personality.color)}>
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

function StatusBar({ agents }: { agents: { name: string; color: string }[] }) {
  return (
    <Box>
      <Text dimColor>  In room: </Text>
      {agents.map((a, i) => (
        <React.Fragment key={a.name}>
          {i > 0 && <Text dimColor>, </Text>}
          <Text color={ansiToInk(a.color)}>{a.name}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

// ── Input line ──────────────────────────────────────────────────────

interface InputLineProps {
  onSubmit: (value: string) => void;
}

function InputLine({ onSubmit }: InputLineProps) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (val: string) => {
      onSubmit(val);
      setValue("");
    },
    [onSubmit],
  );

  return (
    <Box>
      <Text dimColor>{">"} </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="type here anytime, or just watch"
      />
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
  /** Push a completed message to the chat */
  pushMessage: (msg: RoomMessage) => void;
  /** Start streaming for an agent (creates a placeholder message) */
  streamStart: (agent: string, color: string) => void;
  /** Append a token to the currently streaming message */
  streamToken: (agent: string, token: string) => void;
  /** Finalize the streaming message */
  streamDone: (agent: string) => void;
  /** Update the active agents list */
  setActiveAgents: (agents: AgentConfig[]) => void;
  /** Show /who table */
  showWho: (agents: AgentConfig[]) => void;
  /** Update governed mode indicator */
  setGoverned: (governed: boolean) => void;
}

// We use a module-level event emitter pattern to communicate
// between the room engine (running async) and the React tree.

type TuiEvent =
  | { type: "message"; msg: RoomMessage }
  | { type: "streamStart"; agent: string; color: string }
  | { type: "streamToken"; agent: string; token: string }
  | { type: "streamDone"; agent: string }
  | { type: "setActiveAgents"; agents: AgentConfig[] }
  | { type: "showWho"; agents: AgentConfig[] }
  | { type: "setGoverned"; governed: boolean };

let eventQueue: TuiEvent[] = [];
let eventFlush: (() => void) | null = null;

function emitTuiEvent(event: TuiEvent): void {
  eventQueue.push(event);
  eventFlush?.();
}

function App({
  roomName,
  session,
  topic,
  resumed,
  contextCount,
  onUserInput,
  onQuit,
}: TuiProps & { onUserInput: (line: string) => void; onQuit: () => void }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [activeAgents, setActiveAgents] = useState<AgentConfig[]>([]);
  const [whoDisplay, setWhoDisplay] = useState<AgentConfig[] | null>(null);
  const [governed, setGoverned] = useState(true); // default governed
  const nextId = useRef(0);
  const streamingRef = useRef<{
    agent: string;
    color: string;
    id: number;
    buffer: string;
  } | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);



  // Process events from the room engine
  useEffect(() => {
    const processEvents = () => {
      const events = eventQueue.splice(0);
      if (events.length === 0) return;

      for (const event of events) {
        switch (event.type) {
          case "message": {
            // If this is a chat message that matches the current streaming agent,
            // the stream is done — finalize the streaming message
            if (
              event.msg.kind === "chat" &&
              streamingRef.current &&
              streamingRef.current.agent === event.msg.agent
            ) {
              // Already handled by streamDone, just skip the duplicate push
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
            break;
          }

          case "streamToken": {
            const sr = streamingRef.current;
            if (sr && sr.agent === event.agent) {
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
            }
            break;
          }

          case "setActiveAgents":
            setActiveAgents(event.agents);
            break;

          case "showWho":
            setWhoDisplay(event.agents);
            // Auto-clear after 8 seconds
            setTimeout(() => setWhoDisplay(null), 8000);
            break;

          case "setGoverned":
            setGoverned(event.governed);
            break;
        }
      }
    };

    eventFlush = processEvents;

    return () => {
      eventFlush = null;
    };
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

      onUserInput(trimmed);
    },
    [onUserInput, onQuit, exit],
  );

  // Split: settled messages go into <Static>, the live streaming message
  // stays outside so it can update without re-rendering static history.
  const streamingDm = messages.find((dm) => dm.isStreaming);
  const settledMessages = messages.filter((dm) => !dm.isStreaming);

  return (
    <Box flexDirection="column">
      {/* Header — rendered once via Static so it doesn't scroll away */}
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

      {/* Settled chat history — Static means ink never re-renders these,
          they scroll up naturally as new ones appear */}
      <Static items={settledMessages}>
        {(dm) => <ChatMessage key={dm.id} dm={dm} />}
      </Static>

      {/* Live streaming message — outside Static so it updates */}
      {streamingDm && <ChatMessage dm={streamingDm} />}

      {/* Who table (shown when /who is active) */}
      {whoDisplay && <WhoTable agents={whoDisplay} />}

      {/* Status bar + mode indicator */}
      <Box>
        {activeAgents.length > 0 && (
          <StatusBar
            agents={activeAgents.map((a) => ({
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

      {/* Separator */}
      <Text dimColor>{"─".repeat(60)}</Text>

      {/* Input line — always at the bottom, never pushed away */}
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
  props: TuiProps,
  onUserInput: (line: string) => void,
  onQuit: () => void,
): TuiInstance {
  const instance = render(
    <App {...props} onUserInput={onUserInput} onQuit={onQuit} />,
  );

  const handle: TuiHandle = {
    pushMessage: (msg) => emitTuiEvent({ type: "message", msg }),
    streamStart: (agent, color) =>
      emitTuiEvent({ type: "streamStart", agent, color }),
    streamToken: (agent, token) =>
      emitTuiEvent({ type: "streamToken", agent, token }),
    streamDone: (agent) => emitTuiEvent({ type: "streamDone", agent }),
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
