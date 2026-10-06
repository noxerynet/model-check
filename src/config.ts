export interface AppConfig {
  port: number;
  providerTimeoutMs: number;
  providerTestTimeoutMs: number;
  providerMaxBytes: number;
  allowPrivateNetworks: boolean;
  allowedOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const origins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    port: num(env.PORT, 3000),
    providerTimeoutMs: num(env.PROVIDER_TIMEOUT_MS, 30000),
    providerTestTimeoutMs: num(env.PROVIDER_TEST_TIMEOUT_MS, 20000),
    providerMaxBytes: num(env.PROVIDER_MAX_BYTES, 2 * 1024 * 1024),
    allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === "true",
    allowedOrigins: origins,
    rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: num(env.RATE_LIMIT_MAX, 60),
  };
}
