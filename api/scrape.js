import { isIP } from "node:net";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONTENT_LENGTH = 6_000;

function isPrivateIp(hostname) {
  const version = isIP(hostname);
  if (version === 4) {
    const parts = hostname.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
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

function parsePublicUrl(value) {
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

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\u0000/g, "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to request a Deep Read." });
  }

  const body = request.body;
  const validShape = body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === 1 && Object.hasOwn(body, "url");
  const requestedUrl = validShape ? parsePublicUrl(body.url) : null;
  if (!requestedUrl) return response.status(400).json({ error: "Provide one valid public HTTP or HTTPS article URL." });

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Deep Read is not configured yet. Add the FIRECRAWL_API_KEY environment variable." });
  }

  try {
    const upstream = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: requestedUrl.href,
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        timeout: REQUEST_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 2_000),
    });

    const result = await upstream.json().catch(() => null);
    if (!upstream.ok || !result?.success) {
      const status = upstream.status === 429 ? 429 : 502;
      const error = status === 429
        ? "Deep Read is temporarily rate limited. Please try again shortly."
        : "The article could not be extracted right now.";
      return response.status(status).json({ error });
    }

    const data = result.data || {};
    const metadata = data.metadata || {};
    const finalUrl = parsePublicUrl(metadata.sourceURL || metadata.url || requestedUrl.href) || requestedUrl;
    return response.status(200).json({
      title: cleanText(metadata.title, 240),
      domain: finalUrl.hostname.replace(/^www\./, ""),
      url: finalUrl.href,
      description: cleanText(metadata.description, 600),
      content: cleanText(data.markdown, MAX_CONTENT_LENGTH),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return response.status(502).json({
      error: timedOut ? "Deep Read timed out while extracting this article." : "Deep Read could not reach the extraction service.",
    });
  }
}
