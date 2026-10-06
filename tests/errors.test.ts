import { describe, expect, it, vi } from "vitest";
import { fetchModels, type CallContext } from "../src/provider.js";

vi.mock("undici", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetch: vi.fn(),
}));

function ctx(): CallContext {
  return {
    baseUrl: "https://93.184.216.34/v1",
    apiKey: "sk-test",
    extraHeaders: {},
    timeoutMs: 5000,
    maxBytes: 1024 * 1024,
    allowPrivate: false,
  };
}

async function upstream() {
  const { fetch: f } = await import("undici");
  return vi.mocked(f);
}

describe("provider errors", () => {
  it("maps 401 to unauthorized", async () => {
    (await upstream()).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 }) as never,
    );
    const err = await fetchModels(ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: "unauthorized", httpStatus: 401 });
  });

  it("maps 429 to rate_limited", async () => {
    (await upstream()).mockResolvedValue(new Response("slow down", { status: 429 }) as never);
    const err = await fetchModels(ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: "rate_limited", httpStatus: 429 });
  });

  it("maps aborts to timeout", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    (await upstream()).mockRejectedValue(abort);
    const err = await fetchModels(ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: "timeout", httpStatus: null });
  });

  it("rejects invalid JSON as invalid_response", async () => {
    (await upstream()).mockResolvedValue(new Response("not json", { status: 200 }) as never);
    const err = await fetchModels(ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: "invalid_response" });
  });

  it("redacts the api key from provider error text", async () => {
    (await upstream()).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad key sk-test rejected" } }), { status: 500 }) as never,
    );
    const err = (await fetchModels(ctx()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("sk-test");
    expect(err.message).toContain("[redacted]");
  });
});
