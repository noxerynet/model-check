import { describe, expect, it } from "vitest";
import { isPrivateIP, parseBaseUrl, validateBaseUrl } from "../src/ssrf.js";

describe("isPrivateIP", () => {
  it("flags private and reserved ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "::1"]) {
      expect(isPrivateIP(ip)).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPrivateIP(ip)).toBe(false);
    }
  });
});

describe("parseBaseUrl", () => {
  it("rejects non-http schemes and credentials", () => {
    expect(() => parseBaseUrl("ftp://example.com")).toThrow();
    expect(() => parseBaseUrl("https://user:pass@example.com")).toThrow();
    expect(() => parseBaseUrl("not a url")).toThrow();
  });
});

describe("validateBaseUrl", () => {
  it("blocks localhost and private IPs", async () => {
    await expect(validateBaseUrl("http://localhost:8000/v1", false)).rejects.toThrow();
    await expect(validateBaseUrl("http://127.0.0.1:8000/v1", false)).rejects.toThrow();
    await expect(validateBaseUrl("http://192.168.1.10/v1", false)).rejects.toThrow();
  });
});
