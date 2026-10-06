import dns from "node:dns/promises";
import net from "node:net";

export class UrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlBlockedError";
  }
}

export function isPrivateIP(ip: string): boolean {
  if (net.isIP(ip) === 0) return false;
  if (!net.isIPv6(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  const dotted = lower.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/);
  if (dotted) return isPrivateIP(dotted[1]);
  const groups = lower.split(":");
  if (groups.length === 8 && groups.slice(0, 5).every((g) => g === "0" || g === "") && groups[5] === "ffff") {
    const hi = parseInt(groups[6], 16);
    const lo = parseInt(groups[7], 16);
    if (!Number.isInteger(hi) || !Number.isInteger(lo)) return true;
    return isPrivateIP(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  const first = parseInt(groups[0], 16);
  if (!Number.isInteger(first)) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfc00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

export function checkHostnameShape(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost") throw new UrlBlockedError("Private network host is not allowed");
  if (net.isIP(host) !== 0) {
    if (isPrivateIP(host)) throw new UrlBlockedError("Private network address is not allowed");
    return;
  }
  if (/^[0-9]+$/.test(host.replaceAll(".", "")) && net.isIP(host) === 0) {
    throw new UrlBlockedError("Numeric host is not allowed");
  }
}

export async function assertHostAllowed(hostname: string, allowPrivate: boolean): Promise<void> {
  checkHostnameShape(hostname);
  if (allowPrivate) return;
  let records: Array<{ address: string }>;
  try {
    records = (await dns.lookup(hostname, { all: true })) as unknown as Array<{ address: string }>;
  } catch {
    throw new UrlBlockedError("Hostname could not be resolved");
  }
  for (const record of records) {
    if (isPrivateIP(record.address)) {
      throw new UrlBlockedError("Resolved address is not public");
    }
  }
}

export function parseBaseUrl(input: unknown): URL {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new UrlBlockedError("Base URL is required");
  }
  const raw = input.trim();
  if (raw.length > 500) throw new UrlBlockedError("Base URL is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlBlockedError("Base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlBlockedError("Only http and https URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlBlockedError("Credentials in URL are not allowed");
  }
  return url;
}

export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

export async function validateBaseUrl(input: unknown, allowPrivate: boolean): Promise<string> {
  const url = parseBaseUrl(input);
  await assertHostAllowed(url.hostname, allowPrivate);
  return normalizeBaseUrl(url.toString());
}
