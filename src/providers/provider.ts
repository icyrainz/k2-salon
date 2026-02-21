import type { CompletionRequest, CompletionResponse, ProviderKind } from "../types.js";

// ── Unified LLM provider ───────────────────────────────────────────

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OLLAMA_BASE = "http://localhost:11434";

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onDone?: (full: string) => void;
}

export interface ProviderOpts {
  baseUrl?: string;
  apiKey?: string;
  /** AbortSignal to cancel the request (e.g. on /quit) */
  signal?: AbortSignal;
}

export async function complete(
  provider: ProviderKind,
  req: CompletionRequest,
  stream?: StreamCallbacks,
  opts?: ProviderOpts,
): Promise<CompletionResponse> {
  switch (provider) {
    case "openrouter":
      return completeOpenRouter(req, stream, opts);
    case "openai-compat":
      return completeOpenAICompat(req, stream, opts);
    case "ollama":
      return completeOllama(req, stream, opts);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── List available models from a provider ───────────────────────────

export async function listModels(
  provider: ProviderKind,
  opts?: ProviderOpts,
): Promise<{ id: string; name?: string }[]> {
  switch (provider) {
    case "openrouter":
      return listModelsOpenAI(
        opts?.baseUrl || OPENROUTER_BASE,
        opts?.apiKey || process.env.OPENROUTER_API_KEY,
      );
    case "openai-compat":
      if (!opts?.baseUrl) throw new Error("openai-compat requires a baseUrl");
      return listModelsOpenAI(opts.baseUrl, opts.apiKey);
    case "ollama":
      return listModelsOllama(opts?.baseUrl || process.env.OLLAMA_BASE_URL || OLLAMA_BASE);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function listModelsOpenAI(
  baseUrl: string,
  apiKey?: string,
): Promise<{ id: string; name?: string }[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  const data = json.data ?? json;
  if (!Array.isArray(data)) return [];
  return data.map((m: any) => ({ id: m.id, name: m.name ?? m.id }));
}

async function listModelsOllama(
  baseUrl: string,
): Promise<{ id: string; name?: string }[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  const models = json.models ?? [];
  return models.map((m: any) => ({ id: m.name, name: m.name }));
}

// ── OpenRouter ──────────────────────────────────────────────────────

async function completeOpenRouter(
  req: CompletionRequest,
  stream?: StreamCallbacks,
  opts?: ProviderOpts,
): Promise<CompletionResponse> {
  const apiKey = opts?.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const baseUrl = opts?.baseUrl || process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE;
  const doStream = !!stream?.onToken;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: opts?.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/k2-salon",
      "X-Title": "k2-salon",
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.9,
      max_tokens: req.maxTokens ?? 300,
      stream: doStream,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  if (doStream) {
    return readSSEStream(res, req.model, stream!, opts?.signal);
  }

  const json = (await res.json()) as any;
  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, model: req.model };
}

// ── OpenAI-compatible (llama.cpp, vLLM, etc.) ──────────────────────

async function completeOpenAICompat(
  req: CompletionRequest,
  stream?: StreamCallbacks,
  opts?: ProviderOpts,
): Promise<CompletionResponse> {
  if (!opts?.baseUrl) throw new Error("openai-compat provider requires a baseUrl");

  const baseUrl = opts.baseUrl;
  const doStream = !!stream?.onToken;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  // Build body, optionally omitting temperature
  function buildBody(includeTemp: boolean) {
    const body: Record<string, any> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 300,
      stream: doStream,
    };
    if (includeTemp) {
      body.temperature = req.temperature ?? 0.9;
    }
    return body;
  }

  let res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: opts?.signal,
    headers,
    body: JSON.stringify(buildBody(true)),
  });

  // If API rejects temperature (e.g. "only 1 is allowed"), retry once
  // without it. Only do this when we guessed the temperature (0.9 default),
  // not when the provider config explicitly set it — that would be a config error.
  if (!res.ok) {
    const text = await res.text();
    const isTemperatureError =
      text.toLowerCase().includes("temperature") &&
      req.temperature === 0.9; // only retry on our default, not explicit config
    if (isTemperatureError) {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: opts?.signal,
        headers,
        body: JSON.stringify(buildBody(false)),
      });
      if (!res.ok) {
        const retryText = await res.text();
        throw new Error(`OpenAI-compat ${res.status}: ${retryText}`);
      }
    } else {
      throw new Error(`OpenAI-compat ${res.status}: ${text}`);
    }
  }

  if (doStream) {
    return readSSEStream(res, req.model, stream!, opts?.signal);
  }

  const json = (await res.json()) as any;
  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, model: req.model };
}

// ── Ollama ──────────────────────────────────────────────────────────

async function completeOllama(
  req: CompletionRequest,
  stream?: StreamCallbacks,
  opts?: ProviderOpts,
): Promise<CompletionResponse> {
  const baseUrl = opts?.baseUrl || process.env.OLLAMA_BASE_URL || OLLAMA_BASE;

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    signal: opts?.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: !!stream?.onToken,
      options: {
        temperature: req.temperature ?? 0.9,
        num_predict: req.maxTokens ?? 300,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama ${res.status}: ${text}`);
  }

  if (stream?.onToken) {
    return readOllamaStream(res, req.model, stream, opts?.signal);
  }

  const json = (await res.json()) as any;
  const content = json.message?.content ?? "";
  return { content, model: req.model };
}

// ── SSE stream reader (OpenRouter / OpenAI-compatible) ──────────────

async function readSSEStream(
  res: Response,
  model: string,
  stream: StreamCallbacks,
  signal?: AbortSignal,
): Promise<CompletionResponse> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";
  let truncated = false;

  // Cancel the reader when the abort signal fires
  signal?.addEventListener("abort", () => { reader.cancel().catch(() => {}); });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;

        try {
          const json = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content ?? "";
          if (token) {
            full += token;
            stream.onToken?.(token);
          }
          // Detect hard token-limit cutoff
          if (json.choices?.[0]?.finish_reason === "length") {
            truncated = true;
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } catch (err: any) {
    if (err?.name !== "AbortError") throw err;
    // AbortError = intentional cancel, return what we have
  }

  // Append ellipsis token so the TUI shows the message was cut
  if (truncated) {
    stream.onToken?.(" …");
    full += " …";
  }

  stream.onDone?.(full);
  return { content: full, model };
}

// ── Ollama NDJSON stream reader ─────────────────────────────────────

async function readOllamaStream(
  res: Response,
  model: string,
  stream: StreamCallbacks,
  signal?: AbortSignal,
): Promise<CompletionResponse> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  signal?.addEventListener("abort", () => { reader.cancel().catch(() => {}); });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const token = json.message?.content ?? "";
          if (token) {
            full += token;
            stream.onToken?.(token);
          }
        } catch {
          // skip
        }
      }
    }
  } catch (err: any) {
    if (err?.name !== "AbortError") throw err;
  }

  stream.onDone?.(full);
  return { content: full, model };
}
