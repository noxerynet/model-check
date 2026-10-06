import { Router, type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import {
  fetchModels,
  filterCustomHeaders,
  redactSecrets,
  runChatOnce,
  runTestSuite,
  streamChat,
  summarize,
  ProviderError,
  type CallContext,
  type ChatMessage,
} from "./provider.js";
import { UrlBlockedError, normalizeBaseUrl, parseBaseUrl, assertHostAllowed } from "./ssrf.js";

const config = loadConfig();

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { message, code: "bad_request" } });
}

function providerErrorResponse(res: Response, err: unknown, apiKey: string): void {
  if (err instanceof UrlBlockedError) {
    res.status(400).json({ error: { message: err.message, code: "blocked_url" } });
    return;
  }
  if (err instanceof ProviderError) {
    const httpStatus =
      err.status === "unauthorized" ? 401
      : err.status === "rate_limited" ? 429
      : err.status === "timeout" ? 504
      : err.status === "model_not_found" ? 404
      : 502;
    res.status(httpStatus).json({
      error: { message: redactSecrets(err.message, [apiKey]), code: err.status },
      httpStatus: err.httpStatus,
    });
    return;
  }
  res.status(502).json({ error: { message: "Provider request failed", code: "unknown" } });
}

async function buildContext(req: Request): Promise<CallContext> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.baseUrl !== "string" || body.baseUrl.trim() === "") {
    throw new UrlBlockedError("Base URL is required");
  }
  if (typeof body.apiKey !== "string" || body.apiKey.trim() === "") {
    throw new UrlBlockedError("API key is required");
  }
  const apiKey = body.apiKey.trim();
  if (apiKey.length > 500) throw new UrlBlockedError("API key is too long");
  const raw = parseBaseUrl(body.baseUrl);
  await assertHostAllowed(raw.hostname, config.allowPrivateNetworks);
  const extraHeaders = filterCustomHeaders(body.headers);
  const timeoutMs =
    typeof body.timeoutMs === "number" && body.timeoutMs >= 1000 && body.timeoutMs <= 120000
      ? Math.floor(body.timeoutMs)
      : config.providerTimeoutMs;
  return {
    baseUrl: normalizeBaseUrl(raw.toString()),
    apiKey,
    extraHeaders,
    timeoutMs,
    maxBytes: config.providerMaxBytes,
    allowPrivate: config.allowPrivateNetworks,
  };
}

function parseMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) return null;
  const out: ChatMessage[] = [];
  for (const entry of input) {
    if (entry == null || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (!["system", "user", "assistant"].includes(String(record.role))) return null;
    if (typeof record.content !== "string" || record.content.length === 0 || record.content.length > 8000) return null;
    out.push({ role: record.role as ChatMessage["role"], content: record.content });
  }
  return out;
}

export const apiRouter = Router();

apiRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "model-check", time: new Date().toISOString() });
});

apiRouter.post("/providers/models", async (req: Request, res: Response) => {
  try {
    const ctx = await buildContext(req);
    const { models, latencyMs } = await fetchModels(ctx);
    res.json({ endpoint: ctx.baseUrl, count: models.length, latencyMs, models });
  } catch (err) {
    const key = typeof (req.body as Record<string, unknown> | undefined)?.apiKey === "string"
      ? String((req.body as Record<string, unknown>).apiKey)
      : "";
    providerErrorResponse(res, err, key);
  }
});

apiRouter.post("/providers/test", async (req: Request, res: Response) => {
  try {
    const ctx = await buildContext(req);
    ctx.timeoutMs = Math.min(ctx.timeoutMs, config.providerTestTimeoutMs);
    const { models, latencyMs } = await fetchModels(ctx);
    res.json({ ok: true, endpoint: ctx.baseUrl, count: models.length, latencyMs });
  } catch (err) {
    const key = typeof (req.body as Record<string, unknown> | undefined)?.apiKey === "string"
      ? String((req.body as Record<string, unknown>).apiKey)
      : "";
    providerErrorResponse(res, err, key);
  }
});

apiRouter.post("/models/test", async (req: Request, res: Response) => {
  try {
    const ctx = await buildContext(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.model !== "string" || body.model.trim() === "" || body.model.length > 200) {
      badRequest(res, "Model is required");
      return;
    }
    const selected = Array.isArray(body.tests)
      ? body.tests.filter((t): t is string => typeof t === "string")
      : undefined;
    const results = await runTestSuite(ctx, body.model.trim(), selected);
    res.json({ model: body.model.trim(), endpoint: ctx.baseUrl, summary: summarize(results), results });
  } catch (err) {
    const key = typeof (req.body as Record<string, unknown> | undefined)?.apiKey === "string"
      ? String((req.body as Record<string, unknown>).apiKey)
      : "";
    providerErrorResponse(res, err, key);
  }
});

apiRouter.post("/models/chat", async (req: Request, res: Response) => {
  let ctx: CallContext | null = null;
  try {
    ctx = await buildContext(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.model !== "string" || body.model.trim() === "" || body.model.length > 200) {
      badRequest(res, "Model is required");
      return;
    }
    const messages = parseMessages(body.messages);
    if (messages == null) {
      badRequest(res, "Messages must be a non-empty array of role/content objects");
      return;
    }
    const model = body.model.trim();
    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const started = Date.now();
      try {
        for await (const event of streamChat(ctx, model, messages)) {
          if ("delta" in event) {
            res.write(`data: ${JSON.stringify({ delta: event.delta })}\n\n`);
          } else {
            res.write(
              `data: ${JSON.stringify({ done: true, model: event.returnedModel, latencyMs: Date.now() - started })}\n\n`,
            );
          }
        }
        res.end();
      } catch (err) {
        const message = err instanceof ProviderError ? err.message : "Stream failed";
        try {
          res.write(`data: ${JSON.stringify({ error: redactSecrets(message, [ctx.apiKey]) })}\n\n`);
          res.end();
        } catch {
          try { res.end(); } catch { /* noop */ }
        }
      }
      return;
    }
    const started = Date.now();
    const result = await runChatOnce(ctx, model, messages, 512);
    res.json({
      content: result.content,
      model: result.returnedModel,
      usage: result.usage,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    providerErrorResponse(res, err, ctx?.apiKey ?? "");
  }
});
