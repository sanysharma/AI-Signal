#!/usr/bin/env node
// AI Signal — daily digest job.
// Fetches configured RSS sources, runs the candidates through the editorial
// engine (Gemini 2.5 Flash, free tier), and writes today's digest to /data.
//
// Requires: GEMINI_API_KEY env var (free key from aistudio.google.com,
// personal Google account — not your corporate one, see README).

import Parser from "rss-parser";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const parser = new Parser();

async function loadJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchCandidates(sources) {
  const items = [];
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.feed);
      for (const entry of feed.items.slice(0, 8)) {
        items.push({
          source_name: src.name,
          source_url: entry.link,
          title: entry.title,
          published: entry.isoDate || entry.pubDate || null,
          excerpt: (entry.contentSnippet || entry.summary || "").slice(0, 600),
        });
      }
    } catch (err) {
      console.warn(`Skipping ${src.name}: ${err.message}`);
    }
  }
  return items;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          design_implication: { type: "string" },
          source_name: { type: "string" },
          source_url: { type: "string" },
          source_date: { type: "string" },
        },
        required: [
          "category", "title", "summary", "design_implication",
          "source_name", "source_url", "source_date",
        ],
      },
    },
  },
  required: ["stories"],
};

async function runEditorialEngine(promptTemplate, candidates, alreadyCovered) {
  const body = {
    contents: [{
      parts: [{
        text: `${promptTemplate}\n\nAlready covered in the last 14 days (do not repeat these):\n${JSON.stringify(alreadyCovered)}\n\nCandidate articles:\n${JSON.stringify(candidates)}`,
      }],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No content returned from Gemini.");
  return JSON.parse(text).stories ?? [];
}

async function main() {
  const { sources } = JSON.parse(
    await readFile(new URL("../sources.json", import.meta.url), "utf8"),
  );
  const promptTemplate = await readFile(
    new URL("../editorial-prompt.md", import.meta.url), "utf8",
  );

  const index = await loadJSON("data/index.json", { days: [], latest: null });

  const recentDays = index.days.slice(-14);
  const alreadyCovered = [];
  for (const day of recentDays) {
    const d = await loadJSON(`data/${day}.json`, null);
    if (d?.stories) alreadyCovered.push(...d.stories.map((s) => s.title));
  }

  console.log(`Fetching from ${sources.length} sources...`);
  const candidates = await fetchCandidates(sources);
  console.log(`Collected ${candidates.length} candidates.`);

  if (candidates.length === 0) {
    console.log("No candidates fetched — skipping today.");
    return;
  }

  const stories = await runEditorialEngine(promptTemplate, candidates, alreadyCovered);

  if (!existsSync("data")) await mkdir("data", { recursive: true });
  await writeFile(
    `data/${today}.json`,
    JSON.stringify({ date: today, stories }, null, 2),
  );

  if (!index.days.includes(today)) index.days.push(today);
  index.days = index.days.slice(-90); // rolling 90-day archive
  index.latest = today;
  await writeFile("data/index.json", JSON.stringify(index, null, 2));

  console.log(`Published ${stories.length} stories for ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
