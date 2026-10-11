// After each docs deploy: tell IndexNow which pages exist, and check
// that the search crawlers AI assistants use can fetch the site. Both are best effort: a failure
// is reported in the job summary and never fails the deploy. No dependencies; Node 20+.
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const site = (process.env.PAGE_URL || "https://rewake.js.org/").replace(/\/?$/, "/");
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

// The IndexNow key is the name of the only 32-hex-character .txt file in site/public.
const keyFile = readdirSync(join("site", "public")).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
const key = keyFile?.slice(0, 32);

async function fetchText(url, init) {
  const res = await fetch(url, { redirect: "follow", ...init });
  return { status: res.status, text: await res.text() };
}

async function waitForKey(url) {
  // A fresh Pages deploy can take a moment to serve new files.
  for (let i = 0; i < 10; i++) {
    const r = await fetchText(url).catch(() => ({ status: 0, text: "" }));
    if (r.status === 200 && r.text.trim() === key) return true;
    await new Promise((res) => setTimeout(res, 6000));
  }
  return false;
}

async function indexNow() {
  if (!key) return summary("IndexNow: skipped (no key file in site/public).");
  const keyLocation = `${site}${keyFile}`;
  if (!(await waitForKey(keyLocation)))
    return summary(`IndexNow: skipped (${keyLocation} not served yet).`);
  const index = await fetchText(`${site}sitemap-0.xml`);
  const urlList = [...index.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (urlList.length === 0) return summary("IndexNow: skipped (no URLs in the sitemap).");
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(site).host, key, keyLocation, urlList }),
  });
  summary(`IndexNow: submitted ${urlList.length} URLs, HTTP ${res.status}.`);
}

// Search crawlers (not training crawlers): blocking these hides the site from AI search answers.
const CRAWLERS = {
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "OAI-SearchBot": "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  "Claude-SearchBot": "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)",
  PerplexityBot:
    "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
};

async function crawlerCheck() {
  for (const [name, ua] of Object.entries(CRAWLERS)) {
    const r = await fetchText(site, { headers: { "User-Agent": ua } }).catch((e) => ({
      status: `error ${e.message}`,
    }));
    summary(`Crawler check: ${name} → ${r.status}${r.status === 200 ? "" : " (expected 200)"}`);
  }
}

await indexNow().catch((e) => summary(`IndexNow: failed (${e.message}).`));
await crawlerCheck().catch((e) => summary(`Crawler check: failed (${e.message}).`));
