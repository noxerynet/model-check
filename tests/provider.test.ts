import { describe, expect, it } from "vitest";
import {
  compareIdentity,
  filterCustomHeaders,
  normalizeModels,
  summarize,
} from "../src/provider.js";

describe("normalizeModels", () => {
  it("extracts id, object, created and owned_by", () => {
    const models = normalizeModels({
      object: "list",
      data: [
        { id: "b-model", object: "model", created: 1700000000, owned_by: "org" },
        { id: "a-model" },
        { id: 42 },
        null,
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["a-model", "b-model"]);
    expect(models[1]).toMatchObject({ object: "model", created: 1700000000, owned_by: "org" });
    expect(models[0]).toMatchObject({ object: "model", created: null, owned_by: "unknown" });
  });

  it("returns empty list for unexpected shapes", () => {
    expect(normalizeModels({})).toEqual([]);
    expect(normalizeModels(null)).toEqual([]);
  });
});

describe("compareIdentity", () => {
  it("matches equal ids and flags mismatches", () => {
    expect(compareIdentity("deepseek-chat", "deepseek-chat")).toBe("match");
    expect(compareIdentity("deepseek-chat", "other-model")).toBe("mismatch");
    expect(compareIdentity("deepseek-chat", null)).toBe("unavailable");
    expect(compareIdentity("deepseek-chat", "")).toBe("unavailable");
  });
});

describe("filterCustomHeaders", () => {
  it("keeps x- headers and drops sensitive ones", () => {
    expect(
      filterCustomHeaders({
        "X-Custom": "yes",
        Authorization: "Bearer secret",
        Host: "evil",
        "OpenAI-Organization": "org_1",
        "Content-Type": "text/plain",
      }),
    ).toEqual({ "x-custom": "yes", "openai-organization": "org_1" });
  });

  it("rejects non-objects and header injection", () => {
    expect(filterCustomHeaders("nope")).toEqual({});
    expect(filterCustomHeaders({ "x-bad": "a\r\nb" })).toEqual({});
  });
});

describe("summarize", () => {
  it("counts working, failed and unknown", () => {
    const summary = summarize([
      { name: "a", status: "working", httpStatus: 200, latencyMs: 1, response: "", returnedModel: null, identity: "match", error: null },
      { name: "b", status: "timeout", httpStatus: null, latencyMs: 0, response: "", returnedModel: null, identity: "unavailable", error: "t" },
      { name: "c", status: "unknown", httpStatus: null, latencyMs: 0, response: "", returnedModel: null, identity: "unavailable", error: "u" },
    ]);
    expect(summary).toEqual({ working: 1, failed: 1, unknown: 1 });
  });
});
