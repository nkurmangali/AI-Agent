const loadButton = document.querySelector("#load-news");
const filterInput = document.querySelector("#news-filter");
const newsList = document.querySelector("#news-list");
const newsStatus = document.querySelector("#news-status");
const articleCount = document.querySelector("#article-count");
const deepReadPanel = document.querySelector("#deep-read");
const deepReadContent = document.querySelector("#deep-read-content");
const deepReadDomain = document.querySelector("#deep-read-domain");
const explorerForm = document.querySelector("#explorer-form");
const explorerUrl = document.querySelector("#explorer-url");
const scrapeButton = document.querySelector("#scrape-page");
const explorerStatus = document.querySelector("#explorer-status");
const explorerResult = document.querySelector("#explorer-result");

let articles = [];
let activeDeepReadButton = null;

function setNewsStatus(message, isError = false) {
  newsStatus.textContent = message;
  newsStatus.classList.toggle("error", isError);
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function createArticleCard(article) {
  const card = document.createElement("article");
  card.className = "news-card";
  const body = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "card-meta";

  const source = document.createElement("span");
  source.className = "source-name";
  source.textContent = article.source;
  const date = document.createElement("time");
  date.className = "published-date";
  date.dateTime = article.publishedAt || "";
  date.textContent = formatDate(article.publishedAt);

  const heading = document.createElement("h3");
  heading.className = "article-title";
  const link = document.createElement("a");
  link.href = article.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = article.title;
  heading.append(link);

  const summary = document.createElement("p");
  summary.className = "article-summary";
  summary.textContent = article.summary || "No summary was provided by the publisher.";

  const deepReadButton = document.createElement("button");
  deepReadButton.className = "deep-read-button";
  deepReadButton.type = "button";
  deepReadButton.textContent = "Deep Read";
  deepReadButton.addEventListener("click", () => loadDeepRead(article, deepReadButton));

  meta.append(source, date);
  body.append(meta, heading, summary);
  card.append(body, deepReadButton);
  return card;
}

function renderArticles() {
  const query = filterInput.value.trim().toLocaleLowerCase();
  const visibleArticles = articles.filter((article) => `${article.title} ${article.summary || ""}`.toLocaleLowerCase().includes(query));
  newsList.replaceChildren();
  for (const article of visibleArticles) newsList.append(createArticleCard(article));

  if (articles.length && !visibleArticles.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = `No loaded stories match “${filterInput.value.trim()}”.`;
    newsList.append(empty);
  }

  articleCount.textContent = articles.length ? `${visibleArticles.length} of ${articles.length} stories` : "Ready to scan";
}

async function loadNews() {
  loadButton.disabled = true;
  loadButton.textContent = "Loading…";
  newsList.setAttribute("aria-busy", "true");
  setNewsStatus("Contacting the three news desks…");

  try {
    const response = await fetch("/api/news", { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The news feeds could not be loaded.");

    articles = Array.isArray(payload.articles) ? payload.articles : [];
    renderArticles();
    const failedSources = Array.isArray(payload.errors) ? payload.errors : [];

    if (!articles.length) {
      setNewsStatus("The feeds responded, but no stories were available.", true);
    } else if (failedSources.length) {
      setNewsStatus(`Loaded ${articles.length} stories. Some sources were unavailable: ${failedSources.map((item) => item.source).join(", ")}.`, true);
    } else {
      setNewsStatus(`Loaded ${articles.length} recent stories from all three sources.`);
    }
  } catch (error) {
    articles = [];
    renderArticles();
    setNewsStatus(error.message || "The news feeds could not be loaded.", true);
  } finally {
    loadButton.disabled = false;
    loadButton.textContent = "↻ Load Latest News";
    newsList.setAttribute("aria-busy", "false");
  }
}

function renderDeepRead(payload) {
  deepReadContent.replaceChildren();
  const title = document.createElement("h4");
  title.textContent = payload.title || "Deep Read";
  deepReadContent.append(title);

  if (payload.description) {
    const description = document.createElement("p");
    description.className = "deep-description";
    description.textContent = payload.description;
    deepReadContent.append(description);
  }

  const content = document.createElement("p");
  content.textContent = payload.content || "No main article text was returned.";
  deepReadContent.append(content);
  deepReadDomain.textContent = payload.domain || "Article source";
  deepReadDomain.hidden = false;
}

async function loadDeepRead(article, button) {
  if (activeDeepReadButton) {
    activeDeepReadButton.disabled = false;
    activeDeepReadButton.textContent = "Deep Read";
  }
  activeDeepReadButton = button;
  button.disabled = true;
  button.textContent = "Reading…";
  deepReadDomain.hidden = true;
  deepReadContent.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "panel-placeholder";
  loading.textContent = `Extracting “${article.title}”…`;
  deepReadContent.append(loading);
  deepReadPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: article.url }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The article could not be extracted.");
    renderDeepRead(payload);
  } catch (error) {
    deepReadContent.replaceChildren();
    const message = document.createElement("p");
    message.className = "panel-placeholder";
    message.textContent = error.message || "The article could not be extracted.";
    deepReadContent.append(message);
  } finally {
    button.disabled = false;
    button.textContent = "Deep Read";
    activeDeepReadButton = null;
  }
}

function setExplorerStatus(message, isError = false) {
  explorerStatus.textContent = message;
  explorerStatus.classList.toggle("error", isError);
}

function showExplorerMessage(message) {
  explorerResult.replaceChildren();
  const paragraph = document.createElement("p");
  paragraph.className = "panel-placeholder";
  paragraph.textContent = message;
  explorerResult.append(paragraph);
}

function renderExplorerResult(payload) {
  explorerResult.replaceChildren();

  const heading = document.createElement("div");
  heading.className = "explorer-result-heading";
  const title = document.createElement("h3");
  title.textContent = payload.title || "Retrieved page";
  const domain = document.createElement("span");
  domain.className = "domain-badge";
  domain.textContent = payload.domain || "Web page";
  heading.append(title, domain);

  const pageUrl = document.createElement("a");
  pageUrl.className = "retrieved-url";
  pageUrl.href = payload.url;
  pageUrl.target = "_blank";
  pageUrl.rel = "noopener noreferrer";
  pageUrl.textContent = payload.url;

  explorerResult.append(heading, pageUrl);

  if (payload.description) {
    const description = document.createElement("p");
    description.className = "explorer-description";
    description.textContent = payload.description;
    explorerResult.append(description);
  }

  const content = document.createElement("p");
  content.className = "explorer-content";
  content.textContent = payload.content || "No main page text was returned.";

  const originalLink = document.createElement("a");
  originalLink.className = "original-page-link";
  originalLink.href = payload.url;
  originalLink.target = "_blank";
  originalLink.rel = "noopener noreferrer";
  originalLink.textContent = "Open Original Page ↗";
  explorerResult.append(content, originalLink);
}

async function explorePage(event) {
  event.preventDefault();
  const url = explorerUrl.value.trim();
  if (!url) {
    setExplorerStatus("Enter a public webpage URL before scraping.", true);
    showExplorerMessage("No URL was provided.");
    explorerUrl.focus();
    return;
  }

  scrapeButton.disabled = true;
  scrapeButton.textContent = "Scraping…";
  explorerResult.setAttribute("aria-busy", "true");
  setExplorerStatus("Retrieving one webpage with Firecrawl…");
  showExplorerMessage(`Retrieving ${url}…`);

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The webpage could not be retrieved.");

    renderExplorerResult(payload);
    setExplorerStatus(`Retrieved one page from ${payload.domain || "the requested website"}.`);
  } catch (error) {
    const message = error.message || "The webpage could not be retrieved.";
    setExplorerStatus(message, true);
    showExplorerMessage(message);
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.textContent = "Scrape Page";
    explorerResult.setAttribute("aria-busy", "false");
  }
}

loadButton.addEventListener("click", loadNews);
filterInput.addEventListener("input", renderArticles);
explorerForm.addEventListener("submit", explorePage);
