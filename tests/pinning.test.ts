import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetch as undiciFetch } from "undici";
import { buildPinnedAgent } from "../src/provider.js";

describe("buildPinnedAgent", () => {
  it("sends requests to pinned addresses without using DNS", async () => {
    const server = createServer((_req, res) => {
      res.end("pinned-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const agent = buildPinnedAgent(["127.0.0.1"]);
    try {
      const res = await undiciFetch(`http://does-not-resolve.invalid:${port}/`, { dispatcher: agent });
      expect(await res.text()).toBe("pinned-ok");
    } finally {
      await agent.close();
      server.close();
    }
  });
});
