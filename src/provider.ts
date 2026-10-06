import { checkHostnameShape, isPrivateIP, parseBaseUrl } from "./ssrf.js";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as upstreamFetch, interceptors, type Dispatcher } from "undici";

export type TestStatus =
  | "verified"
  | "working"
  | "failed"
  | "timeout"
  | "unauthorized"
  | "rate_limited"
  | "model_not_found"
  | "invalid_response"
  | "unknown";

export type IdentityState = "match" | "mismatch" | "unavailable";

export interface NormalizedModel {
  id: string;
  object: string;
  created: number | null;
  owned_by: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SingleTestResult {
  name: string;
  status: TestStatus;
  httpStatus: number | null;
  latencyMs: number;
  response: string;
  returnedModel: string | null;
  identity: IdentityState;
  error: string | null;
}

export interface SuiteSummary {
  working: number;
  failed: number;
  unknown: number;
}

export class ProviderError extends Error {
  status: TestStatus;
  httpStatus: number | null;

  constructor(status: TestStatus, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

const HEADER_ALLOWLIST = new Set(["openai-organization", "openai-project", "x-request-id"]);
const HEADER_BLOCKED = new Set([
  "authorization",
  "host",
  "content-length",
  "content-type",
  "connection",
  "proxy-authorization",
  "cookie",
]);

export function filterCustomHeaders(input: unknown): Record<string, string> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    if (key.length === 0 || key.length > 64) continue;
    if (HEADER_BLOCKED.has(key)) continue;
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (value.length === 0 || value.length > 500) continue;
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) continue;
    if (key.startsWith("x-") || HEADER_ALLOWLIST.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function normalizeModels(payload: unknown): NormalizedModel[] {
  const list = (
    payload != null && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : []
  );
  const models: NormalizedModel[] = [];
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 200) continue;
    models.push({
      id: item.id,
      object: typeof item.object === "string" ? item.object : "model",
      created: typeof item.created === "number" && Number.isFinite(item.created) ? item.created : null,
      owned_by: typeof item.owned_by === "string" ? item.owned_by : "unknown",
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export function compareIdentity(requested: string, returned: unknown): IdentityState {
  if (typeof returned !== "string" || returned.length === 0) return "unavailable";
  return returned === requested ? "match" : "mismatch";
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

interface FetchBounds {
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
}

async function readBounded(res: UpstreamResponse, maxBytes: number): Promise<string> {
  const length = res.headers.get("content-length");
  if (length != null && Number(length) > maxBytes) {
    throw new ProviderError("invalid_response", `Response exceeded size limit (${maxBytes} bytes)`);
  }
  if (res.body == null) {
    const text = await res.text();
    if (text.length > maxBytes) throw new ProviderError("invalid_response", "Response exceeded size limit");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value != null) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError("invalid_response", "Response exceeded size limit");
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

type UpstreamResponse = Awaited<ReturnType<typeof upstreamFetch>>;

interface UpstreamInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

interface UpstreamResult {
  res: UpstreamResponse;
  done: () => Promise<void>;
}

export function buildPinnedAgent(ips: string[]): Dispatcher {
  let i = 0;
  const agent = new Agent().compose(
    interceptors.dns({
      lookup: (
        _origin: URL,
        _options: unknown,
        callback: (err: Error | null, addresses: Array<{ address: string; ttl: number; family: 4 | 6 }>) => void,
      ) => {
        callback(
          null,
          ips.map((address) => ({ address, ttl: 60, family: (net.isIP(address) === 6 ? 6 : 4) as 4 | 6 })),
        );
      },
      pick: (_origin: URL, records: { records: { 4: { ips: unknown[] } | null; 6: { ips: unknown[] } | null } }) => {
        const all = [...(records.records[4]?.ips ?? []), ...(records.records[6]?.ips ?? [])];
        return all[i++ % all.length] as { address: string; ttl: number; family: 4 | 6 };
      },
    }),
  );
  return agent;
}

async function resolvePinnedHost(hostname: string, allowPrivate: boolean): Promise<string[]> {
  if (net.isIP(hostname) !== 0) {
    if (!allowPrivate && isPrivateIP(hostname)) {
      throw new ProviderError("invalid_response", "Provider address is not public");
    }
    return [hostname];
  }
  checkHostnameShape(hostname);
  let records: Array<{ address: string }>;
  try {
    records = (await dns.lookup(hostname, { all: true })) as Array<{ address: string }>;
  } catch {
    throw new ProviderError("unknown", "Could not resolve provider host");
  }
  const ips = [...new Set(records.map((r) => r.address))].filter((a) => net.isIP(a) !== 0);
  if (ips.length === 0) throw new ProviderError("unknown", "Could not resolve provider host");
  if (!allowPrivate && ips.some((ip) => isPrivateIP(ip))) {
    throw new ProviderError("invalid_response", "Provider resolved to a private address");
  }
  return ips;
}

async function fetchUpstream(url: string, init: UpstreamInit, bounds: FetchBounds): Promise<UpstreamResult> {
  let current = url;
  let agent: Dispatcher | null = null;
  const closeAgent = async (): Promise<void> => {
    if (agent) {
      await agent.close().catch(() => undefined);
      agent = null;
    }
  };
  try {
    for (let hop = 0; hop < 3; hop++) {
      let hostname: string;
      try {
        hostname = parseBaseUrl(current).hostname;
      } catch {
        throw new ProviderError("invalid_response", "Provider returned an unsafe redirect");
      }
      await closeAgent();
      agent = buildPinnedAgent(await resolvePinnedHost(hostname, bounds.allowPrivate));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
      let res: UpstreamResponse;
      try {
        res = await upstreamFetch(current, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          redirect: "manual",
          signal: controller.signal,
          dispatcher: agent,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ProviderError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new ProviderError("timeout", "Provider did not respond within the configured timeout");
        }
        throw new ProviderError("unknown", "Could not reach provider");
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (location == null) throw new ProviderError("invalid_response", "Provider returned an invalid redirect");
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new ProviderError("invalid_response", "Provider returned an unsafe redirect");
        }
        continue;
      }
      const ready = agent;
      agent = null;
      return {
        res,
        done: async () => {
          await ready.close().catch(() => undefined);
        },
      };
    }
    throw new ProviderError("invalid_response", "Too many redirects from provider");
  } catch (err) {
    await closeAgent();
    throw err;
  }
}

function mapHttpError(status: number, bodyText: string, apiKey: string): ProviderError {
  const safe = redactSecrets(bodyText.slice(0, 500), [apiKey]);
  if (status === 401 || status === 403) return new ProviderError("unauthorized", "Invalid API key", status);
  if (status === 429) return new ProviderError("rate_limited", "Provider rate limit reached", status);
  if (/model_not_found|does not exist|unknown model/i.test(safe)) {
    return new ProviderError("model_not_found", "Model not found on provider", status);
  }
  if (status === 404) return new ProviderError("model_not_found", "Model endpoint not found", status);
  if (status === 502 || status === 503 || status === 504) {
    return new ProviderError("failed", "Provider unavailable", status);
  }
  const detail = extractErrorMessage(bodyText);
  return new ProviderError("failed", detail ?? `Provider returned HTTP ${status}`, status);
}

function extractErrorMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed != null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const err = record.error;
      if (typeof err === "string" && err.length > 0) return err.slice(0, 300);
      if (err != null && typeof err === "object") {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === "string" && message.length > 0) return message.slice(0, 300);
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface CallContext {
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
}

function authHeaders(ctx: CallContext): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...ctx.extraHeaders,
  };
}

export async function fetchModels(ctx: CallContext): Promise<{ models: NormalizedModel[]; latencyMs: number }> {
  const started = Date.now();
  const { res, done } = await fetchUpstream(`${ctx.baseUrl}/models`, { headers: authHeaders(ctx) }, ctx);
  try {
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await readBounded(res, ctx.maxBytes).catch(() => "");
      throw mapHttpError(res.status, text, ctx.apiKey);
    }
    const text = await readBounded(res, ctx.maxBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_response", "Provider returned invalid JSON for model list");
    }
    return { models: normalizeModels(payload), latencyMs };
  } finally {
    await done();
  }
}

interface ChatCallResult {
  httpStatus: number;
  latencyMs: number;
  content: string;
  returnedModel: string | null;
  usage: unknown;
}

export async function runChatOnce(
  ctx: CallContext,
  model: string,
  messages: ChatMessage[],
  maxTokens = 64,
): Promise<ChatCallResult> {
  const started = Date.now();
  const { res, done } = await fetchUpstream(
    `${ctx.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: authHeaders(ctx),
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
    },
    ctx,
  );
  try {
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await readBounded(res, ctx.maxBytes).catch(() => "");
      throw mapHttpError(res.status, text, ctx.apiKey);
    }
    const text = await readBounded(res, ctx.maxBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_response", "Provider returned invalid JSON");
    }
    if (payload == null || typeof payload !== "object") {
      throw new ProviderError("invalid_response", "Provider returned an unexpected response shape");
    }
    const record = payload as Record<string, unknown>;
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    return {
      httpStatus: res.status,
      latencyMs,
      content,
      returnedModel: typeof record.model === "string" ? record.model : null,
      usage: record.usage ?? null,
    };
  } finally {
    await done();
  }
}

export async function* streamChat(
  ctx: CallContext,
  model: string,
  messages: ChatMessage[],
  maxTokens = 512,
): AsyncGenerator<{ delta: string } | { done: true; returnedModel: string | null }, void, void> {
  const { res, done } = await fetchUpstream(
    `${ctx.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), Accept: "text/event-stream" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true }),
    },
    ctx,
  );
  try {
    if (!res.ok) {
      const text = await readBounded(res, ctx.maxBytes).catch(() => "");
      throw mapHttpError(res.status, text, ctx.apiKey);
    }
    if (res.body == null) throw new ProviderError("invalid_response", "Provider returned an empty stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamedBytes = 0;
    let returnedModel: string | null = null;
    let gotChunk = false;
    try {
      for (;;) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n").filter((l) => l.startsWith("data:"));
          for (const line of lines) {
            const data = line.slice(5).trim();
            if (data === "" || data === "[DONE]") continue;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (typeof parsed.model === "string" && returnedModel == null) returnedModel = parsed.model;
            const choice = (Array.isArray(parsed.choices) ? parsed.choices[0] : undefined) as
              | Record<string, unknown>
              | undefined;
            const delta = choice?.delta as Record<string, unknown> | undefined;
            if (typeof delta?.content === "string" && delta.content.length > 0) {
              streamedBytes += delta.content.length;
              if (streamedBytes > ctx.maxBytes) {
                throw new ProviderError("invalid_response", "Provider stream exceeded size limit");
              }
              gotChunk = true;
              yield { delta: delta.content };
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!gotChunk) throw new ProviderError("invalid_response", "Provider stream produced no content");
    yield { done: true, returnedModel };
  } finally {
    await done();
  }
}

function toStatus(err: unknown): { status: TestStatus; httpStatus: number | null; message: string } {
  if (err instanceof ProviderError) {
    return { status: err.status, httpStatus: err.httpStatus, message: err.message };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { status: "timeout", httpStatus: null, message: "Provider did not respond within the configured timeout" };
  }
  return { status: "unknown", httpStatus: null, message: "Unexpected error while testing model" };
}

async function singleCheck(
  name: string,
  ctx: CallContext,
  model: string,
  messages: ChatMessage[],
  validate: (content: string) => boolean,
  maxTokens = 64,
): Promise<SingleTestResult> {
  try {
    const result = await runChatOnce(ctx, model, messages, maxTokens);
    const ok = validate(result.content);
    return {
      name,
      status: ok ? "working" : "invalid_response",
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      response: result.content.slice(0, 2000),
      returnedModel: result.returnedModel,
      identity: compareIdentity(model, result.returnedModel),
      error: ok ? null : "Response did not match expected output",
    };
  } catch (err) {
    const mapped = toStatus(err);
    return {
      name,
      status: mapped.status,
      httpStatus: mapped.httpStatus,
      latencyMs: 0,
      response: "",
      returnedModel: null,
      identity: "unavailable",
      error: redactSecrets(mapped.message, [ctx.apiKey]),
    };
  }
}

export interface SuiteDefinition {
  id: string;
  name: string;
}

export const SUITE_TESTS: SuiteDefinition[] = [
  { id: "basic", name: "Basic" },
  { id: "arithmetic", name: "Arithmetic" },
  { id: "instruction", name: "Instruction following" },
  { id: "json", name: "JSON" },
  { id: "identity", name: "Model identity" },
  { id: "streaming", name: "Streaming" },
];

export async function runTestSuite(
  ctx: CallContext,
  model: string,
  selected: string[] = SUITE_TESTS.map((t) => t.id),
): Promise<SingleTestResult[]> {
  const wanted = new Set(selected);
  const results: SingleTestResult[] = [];

  if (wanted.has("basic")) {
    results.push(
      await singleCheck(
        "Basic",
        ctx,
        model,
        [{ role: "user", content: "Reply with exactly: NOXERY_OK" }],
        (c) => c.includes("NOXERY_OK"),
      ),
    );
  }
  if (wanted.has("arithmetic")) {
    results.push(
      await singleCheck(
        "Arithmetic",
        ctx,
        model,
        [{ role: "user", content: "Calculate: 137 * 29. Reply with only the number." }],
        (c) => c.includes("3973"),
      ),
    );
  }
  if (wanted.has("instruction")) {
    results.push(
      await singleCheck(
        "Instruction following",
        ctx,
        model,
        [{ role: "user", content: "Reply with exactly: PASS and nothing else." }],
        (c) => c.includes("PASS"),
      ),
    );
  }
  if (wanted.has("json")) {
    results.push(
      await singleCheck(
        "JSON",
        ctx,
        model,
        [{ role: "user", content: 'Reply with a valid JSON object like {"status":"ok"} and nothing else.' }],
        (c) => {
          try {
            JSON.parse(c.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""));
            return true;
          } catch {
            return false;
          }
        },
      ),
    );
  }
  if (wanted.has("identity")) {
    try {
      const result = await runChatOnce(
        ctx,
        model,
        [{ role: "user", content: "What model are you? Reply with your model name only." }],
        64,
      );
      results.push({
        name: "Model identity",
        status: "working",
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        response: `Self-report: ${result.content.slice(0, 500)} (not proof of identity)`,
        returnedModel: result.returnedModel,
        identity: compareIdentity(model, result.returnedModel),
        error: null,
      });
    } catch (err) {
      const mapped = toStatus(err);
      results.push({
        name: "Model identity",
        status: mapped.status,
        httpStatus: mapped.httpStatus,
        latencyMs: 0,
        response: "",
        returnedModel: null,
        identity: "unavailable",
        error: redactSecrets(mapped.message, [ctx.apiKey]),
      });
    }
  }
  if (wanted.has("streaming")) {
    const started = Date.now();
    try {
      let collected = "";
      let returnedModel: string | null = null;
      for await (const event of streamChat(ctx, model, [{ role: "user", content: "Reply with exactly: NOXERY_OK" }], 64)) {
        if ("delta" in event) collected += event.delta;
        else returnedModel = event.returnedModel;
      }
      const ok = collected.includes("NOXERY_OK");
      results.push({
        name: "Streaming",
        status: ok ? "working" : "invalid_response",
        httpStatus: 200,
        latencyMs: Date.now() - started,
        response: collected.slice(0, 2000),
        returnedModel,
        identity: compareIdentity(model, returnedModel),
        error: ok ? null : "Stream did not return expected output",
      });
    } catch (err) {
      const mapped = toStatus(err);
      results.push({
        name: "Streaming",
        status: mapped.status,
        httpStatus: mapped.httpStatus,
        latencyMs: Date.now() - started,
        response: "",
        returnedModel: null,
        identity: "unavailable",
        error: redactSecrets(mapped.message, [ctx.apiKey]),
      });
    }
  }
  return results;
}

export function summarize(results: SingleTestResult[]): SuiteSummary {
  let working = 0;
  let failed = 0;
  let unknown = 0;
  for (const r of results) {
    if (r.status === "working" || r.status === "verified") working++;
    else if (r.status === "unknown") unknown++;
    else failed++;
  }
  return { working, failed, unknown };
}
