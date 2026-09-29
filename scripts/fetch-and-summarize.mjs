#!/usr/bin/env node
// AI Signal — daily digest job, Editorial Engine v1.
// 1. Fetch trusted sources (sources.json), keep items from the last 14 days.
// 2. Drop anything already published in the last 30 days.
// 3. Run the Editorial Engine (editorial-prompt.md) on Gemini with retry + fallback.
// 4. Enforce the constitution in code: real source URLs only, tier rules, signal threshold, max 8.
// 5. Write data/YYYY-MM-DD.json (status: draft) and a review summary for the pull request.
//
// Requires: GEMINI_API_KEY (free key from aistudio.google.com, personal Google account).

import Parser from "rss-parser";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash",
].filter((m, i, arr) => m && arr.indexOf(m) === i);
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const ENGINE_VERSION = "editorial-v1";
const FRESH_DAYS = 14;          // G3 freshness window (approved)
const RECENT_DAYS = 30;         // dedup window
const PUBLISH_THRESHOLD = 11;   // G6 (approved)
const MAX_STORIES = 8;
const TIER_SCORE = { 1: 3, 2: 2, 3: 0 };

const today = new Date().toISOString().slice(0, 10);
const parser = new Parser({ timeout: 20000, customFields: { item: [["media:content", "mediaContent"], ["media:thumbnail", "mediaThumb"]] }, headers: { "User-Agent": "AI-Signal/1.0 (+https://sanysharma.github.io/AI-Signal/)" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysAgo = (n) => Date.now() - n * 86400000;
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const normUrl = (u) => String(u || "").trim().replace(/[?#].*$/, "").replace(/\/$/, "");

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

// ---------- 1. Discover ----------
async function fetchCandidates(sources) {
  const items = [];
  const health = [];
  for (const src of sources.filter((s) => s.feed)) {
    try {
      const feed = await parser.parseURL(src.feed);
      let kept = 0;
      for (const entry of feed.items.slice(0, src.max_items || 6)) {
        const published = entry.isoDate || entry.pubDate || null;
        if (published && new Date(published).getTime() < daysAgo(FRESH_DAYS)) continue;
        items.push({
          source_name: src.name,
          source_tier: src.tier,
          source_url: entry.link,
          title: entry.title,
          published,
          excerpt: (entry.contentSnippet || entry.summary || "").replace(/\s+/g, " ").slice(0, 400),
          image: feedImage(entry),
        });
        kept += 1;
      }
      health.push({ source: src.name, ok: true, items: feed.items.length, fresh: kept });
    } catch (err) {
      console.warn(`Skipping ${src.name}: ${err.message}`);
      health.push({ source: src.name, ok: false, error: err.message.slice(0, 120) });
    }
  }
  return { items, health };
}

function feedImage(entry) {
  const enc = entry.enclosure;
  if (enc?.url && (!enc.type || enc.type.startsWith("image/"))) return enc.url;
  return entry.mediaContent?.$?.url || entry.mediaThumb?.$?.url || null;
}

// ---------- 2. Recent stories (dedup) ----------
async function loadRecent() {
  if (!existsSync("data")) return [];
  const files = (await readdir("data")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const cutoff = new Date(daysAgo(RECENT_DAYS)).toISOString().slice(0, 10);
  const recent = [];
  for (const f of files.sort()) {
    const day = f.slice(0, 10);
    if (day < cutoff || day === today) continue;
    const d = await loadJSON(`data/${f}`, null);
    for (const s of d?.stories || []) recent.push({ title: s.title, source_url: s.source_url, tags: s.tags || [] });
  }
  return recent;
}

// ---------- 3. Editorial Engine ----------
const STORY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["design_process", "design_tools", "design_trends", "design_impact"] },
    tags: { type: "array", items: { type: "string" } },
    title: { type: "string" },
    summary: { type: "string" },
    design_implication: { type: "string" },
    implication_lens: { type: "string", enum: ["pattern", "workflow", "capability", "trust_and_risk", "business"] },
    visual_need: { type: "string", enum: ["illustrate", "none"] },
    source_name: { type: "string" },
    source_url: { type: "string" },
    source_date: { type: "string" },
    related_sources: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: { type: "object", properties: { claim: { type: "string" }, quote: { type: "string" } }, required: ["claim", "quote"] },
    },
    scores: {
      type: "object",
      properties: {
        relevance: { type: "integer" }, novelty: { type: "integer" }, concreteness: { type: "integer" },
        source_quality: { type: "integer" }, design_leverage: { type: "integer" },
      },
      required: ["relevance", "novelty", "concreteness", "source_quality", "design_leverage"],
    },
  },
  required: ["category", "tags", "title", "summary", "design_implication", "implication_lens", "visual_need",
    "source_name", "source_url", "source_date", "evidence", "scores"],
};
const LOG_ITEM = {
  type: "object",
  properties: { source_url: { type: "string" }, reason: { type: "string" } },
  required: ["source_url", "reason"],
};
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    stories: { type: "array", items: STORY_SCHEMA },
    held: { type: "array", items: LOG_ITEM },
    consolidated: { type: "array", items: LOG_ITEM },
    rejected: { type: "array", items: LOG_ITEM },
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
          source_urls: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["emerging", "established"] },
        },
        required: ["id", "name", "description", "source_urls", "confidence"],
      },
    },
  },
  required: ["stories", "held", "consolidated", "rejected", "patterns"],
};

async function requestGemini(model, body) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
    } catch (err) {
      if (attempt === maxAttempts) throw new Error(`Network error after ${maxAttempts} attempts: ${err.message}`);
      await sleep(2 ** (attempt - 1) * 2000);
      continue;
    }
    if (res.ok) return res.json();
    const errText = await res.text();
    if (!RETRYABLE_STATUS_CODES.has(res.status) || attempt === maxAttempts) {
      throw new Error(`Gemini API error ${res.status} (${model}): ${errText.slice(0, 500)}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** (attempt - 1) * 5000;
    console.warn(`HTTP ${res.status} from ${model}; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxAttempts})`);
    await sleep(delay);
  }
}

async function runEditorialEngine(prompt, candidates, recent) {
  const body = {
    contents: [{
      parts: [{
        text: `${prompt}\n\nTODAY: ${today}\n\nRECENT (published in the last ${RECENT_DAYS} days):\n${JSON.stringify(recent)}\n\nCANDIDATES:\n${JSON.stringify(candidates)}`,
      }],
    }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 },
  };
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`Trying Gemini model: ${model}`);
      const data = await requestGemini(model, body);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`No content returned from ${model}.`);
      return { ...JSON.parse(text), model };
    } catch (err) {
      lastError = err;
      console.warn(`Model ${model} failed: ${err.message}`);
    }
  }
  throw lastError;
}

// ---------- 4. Enforce the constitution in code ----------
function enforce(result, candidates) {
  const byUrl = new Map(candidates.map((c) => [normUrl(c.source_url), c]));
  const held = [...(result.held || [])];
  const rejected = [...(result.rejected || [])];
  const kept = [];
  const seenUrls = new Set();
  for (const s of result.stories || []) {
    const cand = byUrl.get(normUrl(s.source_url));
    if (!cand) { rejected.push({ source_url: s.source_url, reason: "unsupported_claim (URL not in candidates)" }); continue; }
    if (seenUrls.has(normUrl(cand.source_url))) { rejected.push({ source_url: s.source_url, reason: "duplicate" }); continue; }
    s.source_url = cand.source_url;            // exact URL from the feed
    s.source_name = cand.source_name;
    s.source_tier = cand.source_tier;          // tier comes from the registry, not the model
    s.scores.source_quality = TIER_SCORE[cand.source_tier] ?? 0;
    const sc = s.scores;
    sc.total = sc.relevance + sc.novelty + sc.concreteness + sc.source_quality + sc.design_leverage;
    if (cand.source_tier === 3) { held.push({ source_url: s.source_url, reason: "needs_primary_source" }); continue; }
    if (sc.total < PUBLISH_THRESHOLD || sc.relevance < 2 || sc.source_quality < 2) {
      rejected.push({ source_url: s.source_url, reason: `below_bar (${sc.total}/15)` });
      continue;
    }
    seenUrls.add(normUrl(cand.source_url));
    kept.push(s);
  }
  kept.sort((a, b) => b.scores.total - a.scores.total || b.scores.concreteness - a.scores.concreteness);
  for (const s of kept.slice(MAX_STORIES)) rejected.push({ source_url: s.source_url, reason: "below_bar (no slot)" });
  const stories = kept.slice(0, MAX_STORIES).map((s) => ({
    id: `${today}-${slug(s.title)}`,
    status: "draft",
    ...s,
    word_count: words(s.title) + words(s.summary) + words(s.design_implication),
    discovered_date: today,
    visual_type: null, visual_url: null, visual_credit: null, visual_source_url: null, visual_license: null,
  }));
  return { stories, held, rejected };
}

function prBody(out) {
  const lines = [
    `## AI Signal draft — ${today}`,
    "",
    `Engine ${ENGINE_VERSION} · model ${out.review.model} · ${out.review.candidates_reviewed} candidates · **${out.stories.length} stories**`,
    "",
    "Merge this pull request to publish. Close it to skip the day. To drop one story, edit the JSON file in this PR and delete it before merging.",
    "",
  ];
  out.stories.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.title}`);
    lines.push(`*${s.category.replace("design_", "Design ")} · ${s.tags.join(", ")} · score ${s.scores.total}/15 · ${s.word_count} words · tier ${s.source_tier}*`);
    lines.push("", s.summary, "", `**Design implication:** ${s.design_implication}`, "", `Source: [${s.source_name}](${s.source_url})`);
    lines.push(s.visual_type === "source_image"
      ? `Visual: source image (${s.visual_license}), [view image](${s.visual_url}), credit "${s.visual_credit}". Check you are comfortable reusing it; if not, set visual_type to "generated".`
      : `Visual: ${s.visual_type === "none" ? "none (text-only card)" : "generated illustration"}`, "");
    if (s.word_count > 90) lines.push(`> Note: ${s.word_count} words, over the 90-word target.`, "");
  });
  const fails = out.review.feed_health.filter((f) => !f.ok);
  lines.push("---", `Held: ${out.review.held.length} · Consolidated: ${out.review.consolidated.length} · Rejected: ${out.review.rejected.length} · Patterns: ${out.review.patterns.length}`);
  if (fails.length) lines.push("", `Feeds failing (${fails.length}): ${fails.map((f) => f.source).join(", ")}`);
  return lines.join("\n");
}


// ---------- 5. Visual Agent v0: source image (only if allowed) → generated illustration → none ----------
// Priority 1 is permission. A source image is used only when the source's image_policy allows it AND the
// image is hosted on the source's own domain (third-party/stock images are rejected). Everything else
// falls back to AI Signal's own generated illustration, or no image when the story doesn't need one.
const ALLOWED_POLICIES = new Set(["press", "official_with_credit"]);
const baseDomain = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return ""; } };

async function findOgImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "AI-Signal/1.0" } });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200000);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    return m ? new URL(m[1], url).href : null;
  } catch { return null; }
}

async function visualAgent(stories, candidates, sources) {
  const srcByName = new Map(sources.map((s) => [s.name, s]));
  const candByUrl = new Map(candidates.map((c) => [normUrl(c.source_url), c]));
  const log = [];
  for (const s of stories) {
    const src = srcByName.get(s.source_name) || {};
    const policy = src.image_policy || "never";
    let decision = null;
    if (ALLOWED_POLICIES.has(policy)) {
      const cand = candByUrl.get(normUrl(s.source_url));
      const img = cand?.image || (await findOgImage(s.source_url));
      const allowedHosts = new Set([baseDomain(s.source_url), baseDomain(src.url), ...(src.image_hosts || [])]);
      if (img && img.startsWith("https://") && allowedHosts.has(baseDomain(img))) {
        const org = s.source_name.replace(/ (Blog|News|Newsroom|Release Notes|Releases|Research Blog|Machine Learning Research)$/i, "");
        decision = { visual_type: "source_image", visual_url: img, visual_credit: `Image: ${org}`, visual_source_url: s.source_url, visual_license: policy };
      } else {
        log.push({ story: s.id, reason: img ? `image host not allowed (${baseDomain(img)})` : "no source image found" });
      }
    }
    if (!decision) {
      decision = s.visual_need === "none"
        ? { visual_type: "none", visual_url: null, visual_credit: null, visual_source_url: null, visual_license: null }
        : { visual_type: "generated", visual_url: null, visual_credit: "Illustration: AI Signal", visual_source_url: null, visual_license: "original" };
    }
    Object.assign(s, decision);
  }
  return log;
}

// ---------- main ----------
async function main() {
  const { sources } = JSON.parse(await readFile(new URL("../sources.json", import.meta.url), "utf8"));
  const prompt = await readFile(new URL("../editorial-prompt.md", import.meta.url), "utf8");

  const recent = await loadRecent();
  const recentUrls = new Set(recent.map((r) => normUrl(r.source_url)));

  console.log(`Fetching from ${sources.filter((s) => s.feed).length} feeds...`);
  const { items, health } = await fetchCandidates(sources);
  const candidates = items.filter((c) => c.source_url && !recentUrls.has(normUrl(c.source_url)));
  console.log(`Collected ${items.length} fresh items, ${candidates.length} new candidates.`);
  console.table(health.map((h) => ({ source: h.source, ok: h.ok, fresh: h.fresh ?? "-" })));

  let result = { stories: [], held: [], consolidated: [], rejected: [], patterns: [], model: "none" };
  if (candidates.length) result = await runEditorialEngine(prompt, candidates, recent);
  else console.log("No new candidates today.");

  const { stories, held, rejected } = enforce(result, candidates);
  const visualLog = await visualAgent(stories, candidates, sources);
  const out = {
    date: today,
    engine_version: ENGINE_VERSION,
    status: "draft",
    stories,
    review: {
      model: result.model,
      candidates_reviewed: candidates.length,
      held,
      consolidated: result.consolidated || [],
      rejected,
      patterns: result.patterns || [],
      feed_health: health,
      visual_log: visualLog,
    },
  };

  if (!existsSync("data")) await mkdir("data", { recursive: true });
  await writeFile(`data/${today}.json`, JSON.stringify(out, null, 2));
  await writeFile(process.env.PR_BODY_FILE || "pr-body.md", prBody(out));
  console.log(`Drafted ${stories.length} stories for ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
