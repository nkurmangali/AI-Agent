import { FIRECRAWL_CRAWL_ENDPOINT, parsePublicUrl } from "../lib/web-utils.js";

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 25;

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to start a site exploration." });
  }

  const body = request.body;
  const validShape = body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === 2 && Object.hasOwn(body, "url") && Object.hasOwn(body, "depth");
  const requestedUrl = validShape ? parsePublicUrl(body.url) : null;
  const depth = validShape && Number.isInteger(body.depth) && body.depth >= 1 && body.depth <= 3
    ? body.depth
    : null;
  if (!requestedUrl || depth === null) {
    return response.status(400).json({ error: "Provide one public HTTP or HTTPS URL and a crawl depth from 1 to 3." });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Site exploration is not configured yet. Add the FIRECRAWL_API_KEY environment variable." });
  }

  try {
    const upstream = await fetch(FIRECRAWL_CRAWL_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: requestedUrl.href,
        maxDiscoveryDepth: depth,
        sitemap: "skip",
        crawlEntireDomain: true,
        allowExternalLinks: false,
        allowSubdomains: false,
        ignoreQueryParameters: true,
        limit: PAGE_LIMIT,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
          onlyCleanContent: true,
          removeBase64Images: true,
          blockAds: true,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const result = await upstream.json().catch(() => null);
    if (!upstream.ok || !result?.success || typeof result.id !== "string") {
      const status = upstream.status === 429 ? 429 : 502;
      const error = status === 429
        ? "Site exploration is temporarily rate limited. Please try again shortly."
        : "The crawl could not be started for this website.";
      return response.status(status).json({ error });
    }

    return response.status(202).json({
      id: result.id,
      url: requestedUrl.href,
      depth,
      status: "scraping",
      pageLimit: PAGE_LIMIT,
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return response.status(502).json({
      error: timedOut ? "The crawl service took too long to start." : "The crawl service could not be reached.",
    });
  }
}
