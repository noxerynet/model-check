export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export function rateLimit(options: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  const middleware = (
    req: { ip?: string; headers?: Record<string, unknown> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ): void => {
    const key =
      req.ip ??
      (typeof req.headers?.["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"]
        : "unknown");
    const now = Date.now();
    const windowStart = now - options.windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
    recent.push(now);
    hits.set(key, recent);
    if (recent.length > options.max) {
      res.status(429).json({ error: { message: "Rate limit exceeded, try again later", code: "rate_limited" } });
      return;
    }
    if (hits.size > 10000) hits.clear();
    next();
  };
  return middleware;
}
