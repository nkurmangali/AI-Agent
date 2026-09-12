import { cleanText, FIRECRAWL_ENDPOINT, parsePublicUrl } from "../../lib/web-utils.js";

export const config = { maxDuration: 60 };

const MAX_URLS = 5;
const MAX_JOBS_PER_SOURCE = 8;
const REQUEST_TIMEOUT_MS = 45_000;

const EXTRACTION_PROMPT = `Extract up to 8 job opportunities visibly listed on this exact page. Focus on actual job postings, not navigation or promotional content. For each job return title, employer, location, direct job URL if visible, date, employment type, a short factual description, evidence that it is junior, graduate, entry-level, trainee, internship, assistant, associate, coordinator, analyst, requires 0-2 years, or requires no prior experience, transferable skills, future-relevant technology, digital, data, policy or innovation signals, learning or training signals, and any evidence that the role is actually senior. Do not infer unsupported facts. Return an empty jobs array if no visible job listings can be verified.`;

const JOB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    jobs: {
      type: "array",
      maxItems: MAX_JOBS_PER_SOURCE,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          employer: { type: "string" },
          location: { type: "string" },
          jobUrl: { type: "string" },
          postedDate: { type: "string" },
          employmentType: { type: "string" },
          description: { type: "string" },
          juniorEvidence: { type: "array", items: { type: "string" } },
          transferableSkills: { type: "array", items: { type: "string" } },
          futureRelevantSignals: { type: "array", items: { type: "string" } },
          learningSignals: { type: "array", items: { type: "string" } },
          seniorityWarnings: { type: "array", items: { type: "string" } },
        },
        required: [
          "title", "employer", "location", "jobUrl", "postedDate", "employmentType",
          "description", "juniorEvidence", "transferableSkills", "futureRelevantSignals",
          "learningSignals", "seniorityWarnings",
        ],
      },
    },
  },
  required: ["jobs"],
};

const EARLY_SIGNALS = [
  ["junior", /\bjunior\b/i],
  ["graduate", /\bgraduate\b/i],
  ["entry-level", /\bentry[ -]level\b/i],
  ["trainee", /\btrainee\b/i],
  ["internship", /\bintern(?:ship)?\b/i],
  ["assistant", /\bassistant\b/i],
  ["associate", /\bassociate\b/i],
  ["coordinator", /\bcoordinator\b/i],
  ["analyst", /\banalyst\b/i],
  ["0–2 years of experience", /\b0\s*(?:-|–|to)\s*2\s+years?(?:\s+of)?\s+experience\b/i],
  ["no prior experience required", /\bno\s+(?:prior\s+)?experience\s+(?:is\s+)?required\b/i],
];

const SENIOR_TITLE_SIGNALS = [
  ["senior", /\bsenior\b/i],
  ["lead", /\blead\b/i],
  ["principal", /\bprincipal\b/i],
  ["head", /\bhead\b/i],
  ["director", /\bdirector\b/i],
  ["executive", /\bexecutive\b/i],
];

const SENIOR_EXPERIENCE_SIGNALS = [
  ["5+ years of experience", /\b(?:5|[6-9]|\d{2,})\+?\s+years?(?:\s+of)?\s+experience\b/i],
];

function compactText(value, maxLength = 500) {
  return cleanText(value, maxLength).replace(/\s+/g, " ").trim();
}

function stringArray(value, maxItems = 6) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => compactText(item, 220)).filter(Boolean))].slice(0, maxItems);
}

function resolveJobUrl(value, sourceUrl) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const resolved = new URL(value, sourceUrl);
    return parsePublicUrl(resolved.href)?.href || "";
  } catch {
    return "";
  }
}

function normalizeJob(rawJob, sourceUrl) {
  if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) return null;
  const title = compactText(rawJob.title, 180);
  if (!title) return null;

  return {
    title,
    employer: compactText(rawJob.employer, 160),
    location: compactText(rawJob.location, 160),
    jobUrl: resolveJobUrl(rawJob.jobUrl, sourceUrl.href),
    postedDate: compactText(rawJob.postedDate, 80),
    employmentType: compactText(rawJob.employmentType, 100),
    description: compactText(rawJob.description, 700),
    juniorEvidence: stringArray(rawJob.juniorEvidence),
    transferableSkills: stringArray(rawJob.transferableSkills),
    futureRelevantSignals: stringArray(rawJob.futureRelevantSignals),
    learningSignals: stringArray(rawJob.learningSignals),
    seniorityWarnings: stringArray(rawJob.seniorityWarnings),
    sourceDomain: sourceUrl.hostname.replace(/^www\./, ""),
    sourceUrl: sourceUrl.href,
  };
}

function detectedSignals(job, definitions) {
  const evidence = `${job.title} ${job.description}`;
  return definitions.filter(([, pattern]) => pattern.test(evidence)).map(([label]) => label);
}

function rankingDetails(job) {
  const earlySignals = detectedSignals(job, EARLY_SIGNALS);
  const seniorSignals = [
    ...detectedSignals({ ...job, description: "" }, SENIOR_TITLE_SIGNALS),
    ...detectedSignals(job, SENIOR_EXPERIENCE_SIGNALS),
  ];
  const accessibleEvidence = [...new Set([...job.juniorEvidence, ...earlySignals])];
  const warnings = [...new Set([...job.seniorityWarnings, ...seniorSignals])];

  const accessibility = accessibleEvidence.length ? Math.min(40, 24 + accessibleEvidence.length * 8) : 0;
  const skills = Math.min(30, job.transferableSkills.length * 8);
  const future = Math.min(20, job.futureRelevantSignals.length * 7);
  const learning = Math.min(10, job.learningSignals.length * 5);
  const seniorityPenalty = warnings.length ? Math.min(60, 42 + warnings.length * 6) : 0;

  return {
    score: accessibility + skills + future + learning - seniorityPenalty,
    accessibleEvidence,
    warnings,
  };
}

function asSentence(value) {
  if (!value) return "";
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function buildReasons(job, details) {
  const accessible = job.juniorEvidence[0]
    ? asSentence(job.juniorEvidence[0])
    : `The listing explicitly uses “${details.accessibleEvidence[0]},” an early-career signal used in this ranking.`;
  const skills = job.transferableSkills.length
    ? `The listing identifies ${job.transferableSkills.slice(0, 3).join(", ")}.`
    : "The supplied listing does not state specific transferable skills.";
  const exposureSignals = [...job.futureRelevantSignals, ...job.learningSignals];
  const exposure = exposureSignals.length
    ? `The role offers exposure to ${exposureSignals.slice(0, 3).join(", ")}.`
    : "The supplied listing does not state clear future-relevant or training exposure.";

  return [
    { heading: "Accessible start", text: accessible },
    { heading: "Skills you can build", text: skills },
    { heading: "Career exposure", text: exposure },
  ];
}

function rankJobs(jobs) {
  const unique = new Map();
  for (const job of jobs) {
    const key = job.jobUrl || `${job.title}|${job.employer}|${job.location}`.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, job);
  }

  return [...unique.values()]
    .map((job) => ({ job, details: rankingDetails(job) }))
    .filter(({ details }) => details.accessibleEvidence.length > 0 && details.score > 0)
    .sort((left, right) => right.details.score - left.details.score || left.job.title.localeCompare(right.job.title))
    .slice(0, 5)
    .map(({ job, details }, index) => ({
      rank: index + 1,
      title: job.title,
      employer: job.employer,
      location: job.location,
      sourceDomain: job.sourceDomain,
      employmentType: job.employmentType,
      postedDate: job.postedDate,
      jobUrl: job.jobUrl,
      sourceUrl: job.sourceUrl,
      reasons: buildReasons(job, details),
    }));
}

async function scanSource(source, apiKey) {
  try {
    const upstream = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: source.url.href,
        formats: [{ type: "json", prompt: EXTRACTION_PROMPT, schema: JOB_SCHEMA }],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        timeout: REQUEST_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 2_000),
    });
    const result = await upstream.json().catch(() => null);
    if (!upstream.ok || !result?.success) {
      const message = upstream.status === 429
        ? "Firecrawl is temporarily rate limited. Try this source again shortly."
        : "This page could not be cleanly extracted. Try another public job page.";
      return { source, status: "could_not_extract", message, jobs: [] };
    }

    const jobs = (Array.isArray(result.data?.json?.jobs) ? result.data.json.jobs : [])
      .slice(0, MAX_JOBS_PER_SOURCE)
      .map((job) => normalizeJob(job, source.url))
      .filter(Boolean);

    return jobs.length
      ? { source, status: "extracted", message: `Extracted ${jobs.length} visible job${jobs.length === 1 ? "" : "s"}.`, jobs }
      : { source, status: "no_jobs", message: "No usable job listings were found on this page.", jobs: [] };
  } catch {
    return {
      source,
      status: "could_not_extract",
      message: "This page could not be cleanly extracted. Try another public job page.",
      jobs: [],
    };
  }
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to scan job pages." });
  }

  const body = request.body;
  const validShape = body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === 1 && Object.hasOwn(body, "urls") && Array.isArray(body.urls);
  if (!validShape || body.urls.length < 1 || body.urls.length > MAX_URLS) {
    return response.status(400).json({ error: "Provide between 1 and 5 public job-page URLs." });
  }

  const invalidIndexes = [];
  const uniqueSources = new Map();
  body.urls.forEach((value, index) => {
    const url = parsePublicUrl(value);
    if (!url) {
      invalidIndexes.push(index);
      return;
    }
    if (!uniqueSources.has(url.href)) uniqueSources.set(url.href, { url, inputIndexes: [] });
    uniqueSources.get(url.href).inputIndexes.push(index);
  });

  if (invalidIndexes.length) {
    return response.status(400).json({
      error: "Every supplied value must be a valid public HTTP or HTTPS URL.",
      invalidIndexes,
    });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Junior Job Scout is not configured yet. Add the FIRECRAWL_API_KEY environment variable." });
  }

  const scans = await Promise.all([...uniqueSources.values()].map((source) => scanSource(source, apiKey)));
  const sources = scans.map(({ source, status, message, jobs }) => ({
    url: source.url.href,
    domain: source.url.hostname.replace(/^www\./, ""),
    inputIndexes: source.inputIndexes,
    status,
    message,
    jobCount: jobs.length,
  }));
  const jobs = rankJobs(scans.flatMap((scan) => scan.jobs));
  const allFailed = scans.every((scan) => scan.status === "could_not_extract");

  if (allFailed) {
    return response.status(502).json({
      error: "None of the supplied pages could be cleanly extracted. Try another public job page.",
      sources,
      jobs: [],
    });
  }

  return response.status(200).json({ jobs, sources });
}
