import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  },
}));

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("API", () => {
  it("serves health", async () => {
    const app = createApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects missing credentials", async () => {
    const app = createApp();
    const res = await request(app).post("/api/providers/models").send({});
    expect(res.status).toBe(400);
  });

  it("blocks private base URLs", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/providers/models")
      .send({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("sk-test");
  });

  it("lists models through the provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m-a", owned_by: "org" }] }), { status: 200 })),
    );
    const app = createApp();
    const res = await request(app)
      .post("/api/providers/models")
      .send({ baseUrl: "https://example.com/v1", apiKey: "sk-test" });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.models[0].id).toBe("m-a");
  });

  it("rejects invalid chat messages", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/models/chat")
      .send({ baseUrl: "https://example.com/v1", apiKey: "sk-test", model: "m-a", messages: [] });
    expect(res.status).toBe(400);
  });
});
