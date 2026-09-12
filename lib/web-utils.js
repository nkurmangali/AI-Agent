import { isIP } from "node:net";

export const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

function isPrivateIp(hostname) {
  const version = isIP(hostname);
  if (version === 4) {
    const parts = hostname.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (version === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  return false;
}

export function parsePublicUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const blockedName = hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !hostname || blockedName || isPrivateIp(hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\u0000/g, "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
