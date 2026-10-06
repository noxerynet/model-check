import { describe, expect, it } from "vitest";
import { rateLimit } from "../src/rateLimit.js";

function run(mw: ReturnType<typeof rateLimit>, ip: string): { next: boolean; code: number } {
  let next = false;
  let code = 0;
  mw(
    { ip },
    {
      status: (c: number) => ({
        json: (_body: unknown) => {
          code = c;
        },
      }),
    },
    () => {
      next = true;
    },
  );
  return { next, code };
}

describe("rateLimit", () => {
  it("blocks past the max and isolates clients", () => {
    const mw = rateLimit({ windowMs: 60000, max: 2 });
    expect(run(mw, "1.1.1.1").next).toBe(true);
    expect(run(mw, "1.1.1.1").next).toBe(true);
    const blocked = run(mw, "1.1.1.1");
    expect(blocked.next).toBe(false);
    expect(blocked.code).toBe(429);
    expect(run(mw, "2.2.2.2").next).toBe(true);
  });
});
