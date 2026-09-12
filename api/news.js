import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const FEEDS = [
  { source: "WIRED", url: "https://www.wired.com/feed/tag/ai/latest/rss" },
  { source: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { source: "VentureBeat", url: "https://venturebeat.com/category/ai/feed/" },
];

const ARTICLES_PER_SOURCE = 6;
const MAX_ARTICLES = 18;
const REQUEST_TIMEOUT_MS = 12_000;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true, trimValues: true });

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return String(value["#text"] || value.__cdata || value["@_href"] || "");
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function plainText(value, maxLength = 420) {
  const text = decodeEntities(asText(value).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function articleUrl(item) {
  if (typeof item.link === "string") return item.link.trim();
  const links = asArray(item.link);
  const preferred = links.find((link) => link?.["@_rel"] === "alternate") || links[0];
  return asText(preferred).trim();
}

function normalizeDate(value) {
  const date = new Date(asText(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeItem(item, source) {
  const url = articleUrl(item);
  const title = plainText(item.title, 220);
  if (!url || !title) return null;

  return {
    id: createHash("sha256").update(`${source}:${url}`).digest("hex").slice(0, 20),
    source,
    title,
    url,
    publishedAt: normalizeDate(item.pubDate || item.published || item.updated || item["dc:date"]),
    summary: plainText(item.description || item.summary || item["content:encoded"] || item.content),
  };
}

function parseFeed(xml, source) {
  const document = parser.parse(xml);
  const items = document?.rss?.channel?.item || document?.feed?.entry || [];
  return asArray(items).map((item) => normalizeItem(item, source)).filter(Boolean).slice(0, ARTICLES_PER_SOURCE);
}

async function loadFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "AI-News-Briefing/1.0 (+https://ai-agent-nk-fund.vercel.app)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Feed responded with HTTP ${response.status}.`);
  return parseFeed(await response.text(), feed.source);
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Use GET to load the latest news." });
  }

  const settled = await Promise.allSettled(FEEDS.map(loadFeed));
  const articles = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      articles.push(...result.value);
    } else {
      errors.push({ source: FEEDS[index].source, message: result.reason?.message || "The feed is temporarily unavailable." });
    }
  });

  articles.sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightTime - leftTime;
  });

  const limitedArticles = articles.slice(0, MAX_ARTICLES);
  if (!limitedArticles.length) {
    return response.status(502).json({
      error: "None of the news feeds could be loaded right now. Please try again shortly.",
      articles: [],
      errors,
    });
  }

  return response.status(200).json({ articles: limitedArticles, errors });
}
