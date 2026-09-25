#!/usr/bin/env node

// AI Signal — daily digest job.
// Fetches configured RSS sources, runs the candidates through the editorial
// engine and writes today's digest to /data.

import Parser from "rss-parser";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

// Preferred model first, fallback second
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash",
].filter((model, index, arr) => arr.indexOf(model) === index);

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const today = new Date().toISOString().slice(0, 10);
const parser = new Parser();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds)) {
      return Math.max(retryAfterSeconds * 1000, 1000);
    }
  }

  return (2 ** (attempt - 1) * 2000) + Math.floor(Math.random() * 500);
}

async function requestGemini(model, body) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;

    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Gemini network error after ${maxAttempts} attempts: ${error.message}`);
      }

      const delayMs = 2 ** (attempt - 1) * 2000;
      console.warn(`Gemini network error; retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(delayMs);
      continue;
    }

    if (response.ok) {
      return response.json();
    }

    const errorText = await response.text();

    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxAttempts) {
      throw new Error(`Gemini API error ${response.status} using ${model}: ${errorText}`);
    }

    const delayMs = getRetryDelay(response, attempt);
    console.warn(`Gemini model ${model} returned HTTP ${response.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
    await sleep(delayMs);
  }

  throw new Error(`Gemini request failed for model ${model}.`);
}

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
    } catch (error) {
      console.warn(`Skipping ${src.name}: ${error.message}`);
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
          "category",
          "title",
          "summary",
          "design_implication",
          "source_name",
          "source_url",
          "source_date",
        ],
      },
    },
  },
  required: ["stories"],
};

async function runEditorialEngine(promptTemplate, candidates, alreadyCovered) {
  const body = {
    contents: [
      {
        parts: [
          {
            text: `${promptTemplate}

Already covered in the last 14 days (do not repeat these):
${JSON.stringify(alreadyCovered)}

Candidate articles:
${JSON.stringify(candidates)}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let lastError;

  for (const model of GEMINI_MODELS) {
    try {
      console.log(`Trying Gemini model: ${model}`);

      const data = await requestGemini(model, body);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error(`No content returned from Gemini model ${model}.`);
      }

      const parsed = JSON.parse(text);
      return parsed.stories ?? [];
    } catch (error) {
      lastError = error;
      console.warn(`Gemini model ${model} failed: ${error.message}`);

      if (model !== GEMINI_MODELS[GEMINI_MODELS.length - 1]) {
        console.warn("Trying fallback Gemini model...");
      }
    }
  }

  throw lastError || new Error("All Gemini models failed.");
}

async function main() {
  const { sources } = JSON.parse(
    await readFile(new URL("../sources.json", import.meta.url), "utf8"),
  );

  const promptTemplate = await readFile(
    new URL("../editorial-prompt.md", import.meta.url),
    "utf8",
  );

  const index = await loadJSON("data/index.json", { days: [], latest: null });

  const recentDays = index.days.slice(-14);
  const alreadyCovered = [];

  for (const day of recentDays) {
    const digest = await loadJSON(`data/${day}.json`, null);
    if (digest?.stories) {
      alreadyCovered.push(...digest.stories.map((story) => story.title));
    }
  }

  console.log(`Fetching from ${sources.length} sources...`);

  const candidates = await fetchCandidates(sources);
  console.log(`Collected ${candidates.length} candidates.`);

  if (candidates.length === 0) {
    console.log("No candidates fetched — skipping today.");
    return;
  }

  const stories = await runEditorialEngine(promptTemplate, candidates, alreadyCovered);

  if (!existsSync("data")) {
    await mkdir("data", { recursive: true });
  }

  await writeFile(
    `data/${today}.json`,
    JSON.stringify({ date: today, stories }, null, 2),
  );

  if (!index.days.includes(today)) {
    index.days.push(today);
  }

  index.days = index.days.slice(-90);
  index.latest = today;

  await writeFile("data/index.json", JSON.stringify(index, null, 2));

  console.log(`Published ${stories.length} stories for ${today}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
