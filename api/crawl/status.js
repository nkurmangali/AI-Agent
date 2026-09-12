import { cleanText, FIRECRAWL_CRAWL_ENDPOINT, parsePublicUrl } from "../../lib/web-utils.js";

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 25;
const MAX_EXCERPT_LENGTH = 420;
const CRAWL_ID_PATTERN = /^[a-zA-Z0-9-]{8,100}$/;

function compactMarkdown(value) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+[.)] )\s*/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleanText(text, MAX_EXCERPT_LENGTH);
}

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function normalizePage(document, startingUrl) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const metadata = document.metadata && typeof document.metadata === "object" ? document.metadata : {};
  const pageUrl = parsePublicUrl(metadata.sourceURL || metadata.url);
  if (!pageUrl || normalizedHostname(pageUrl) !== normalizedHostname(startingUrl)) return null;

  return {
    title: cleanText(metadata.title, 240) || pageUrl.pathname.split("/").filter(Boolean).pop() || pageUrl.hostname,
    url: pageUrl.href,
    excerpt: compactMarkdown(document.markdown || metadata.description),
  };
}

function validNextUrl(value, crawlId) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.firecrawl.dev" &&
      url.pathname === `/v2/crawl/${crawlId}` ? url : null;
  } catch {
    return null;
  }
}

async function getCrawlPage(url, apiKey) {
  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = await upstream.json().catch(() => null);
  return { upstream, result };
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Use GET to check site-exploration progress." });
  }

  const crawlId = typeof request.query?.id === "string" ? request.query.id : "";
  const startingUrl = parsePublicUrl(request.query?.url);
  if (!CRAWL_ID_PATTERN.test(crawlId) || !startingUrl) {
    return response.status(400).json({ error: "Provide a valid crawl ID and starting URL." });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Site exploration is not configured yet. Add the FIRECRAWL_API_KEY environment variable." });
  }

  try {
    let nextUrl = new URL(`${FIRECRAWL_CRAWL_ENDPOINT}/${encodeURIComponent(crawlId)}`);
    const documents = [];
    let result;
    let upstream;
    let pageCount = 0;

    while (nextUrl && documents.length < PAGE_LIMIT && pageCount < 3) {
      ({ upstream, result } = await getCrawlPage(nextUrl, apiKey));
      if (!upstream.ok || !result) break;
      if (Array.isArray(result.data)) documents.push(...result.data);
      nextUrl = validNextUrl(result.next, crawlId);
      pageCount += 1;
      if (result.status !== "completed") break;
    }

    if (!upstream?.ok || !result) {
      const status = upstream?.status === 429 ? 429 : 502;
      const error = status === 429
        ? "Site exploration is temporarily rate limited. Please try again shortly."
        : "The crawl status could not be retrieved.";
      return response.status(status).json({ error });
    }

    const pages = documents
      .map((document) => normalizePage(document, startingUrl))
      .filter(Boolean)
      .slice(0, PAGE_LIMIT);
    const completed = Math.min(PAGE_LIMIT, Math.max(0, Number(result.completed) || pages.length));
    const total = Math.min(PAGE_LIMIT, Math.max(completed, Number(result.total) || 0));
    const status = ["scraping", "completed", "failed", "cancelled"].includes(result.status)
      ? result.status
      : "scraping";

    return response.status(200).json({
      status,
      completed,
      total,
      pages,
      pageLimit: PAGE_LIMIT,
      capReached: Math.max(Number(result.completed) || 0, Number(result.total) || 0, documents.length) >= PAGE_LIMIT,
      ...(status === "failed" || status === "cancelled"
        ? { error: status === "failed" ? "Firecrawl could not complete this site exploration." : "This site exploration was cancelled." }
        : {}),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return response.status(502).json({
      error: timedOut ? "Checking crawl progress took too long." : "The crawl service could not be reached.",
    });
  }
}
