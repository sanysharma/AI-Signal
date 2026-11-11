# AI Signal: guide for AI agents

Read this before every task. It is the owner's brief: what the product is, how it is built, the design rules, and what not to touch.

## 1. What AI Signal is
- A daily brief for **experienced product designers** on how AI is changing their work: what is shipping in design tools and design practice, what the market leaders (Meta, Google, Anthropic, OpenAI and others) are doing, and what it means in product and service industries such as Cloud, IAM and Martech.
- The problem: designers with full-time jobs can't follow X, blogs and several apps to stay current. AI Signal collects what matters in one place.
- **Learn tab:** helps beginners get past the "where do I start with AI" confusion: free courses, a learning roadmap, and new and trending courses for designers.
- Voice: trusted, curated, concise. Signal over volume.
- Live site: https://sanysharma.github.io/AI-Signal/ (GitHub Pages serves the `main` branch).

## 2. Direction (context, not a task)
The next audience is **product managers**. The opening screen will later ask a few questions (job profile, industry) and tailor the feed. **Do not build this unless asked**, but avoid hard-coding "designers" into data structures or logic in a way that would block it.

## 3. How it's built
- `index.html`: the whole site in one file. CSS design tokens in `:root`, HTML, then one `<script type="module">`.
- `data/YYYY-MM-DD.json`: one brief per day. The site checks the last 30 days and shows the latest 10 stories, newest first.
- Each story has two pages: **front** (`title` + `design_implication`) and, by swiping sideways, **What happened** (`summary`, `key_facts`, source link).
- Daily pipeline: `.github/workflows/daily-signal.yml` runs at 02:17 UTC (07:47 IST). It runs `scripts/fetch-and-summarize.mjs`, which reads the feeds in `sources.json`, keeps items from the last 14 days, drops anything published in the last 30, asks Gemini to edit them using `editorial-prompt.md`, enforces the rules in code (max 8 stories), and opens a draft PR on a `digest/YYYY-MM-DD` branch. Merging the PR publishes the brief.
- `.github/workflows/auto-publish.yml` runs at 06:43 UTC (12:13 IST). If the repo variable `AUTO_PUBLISH` is `"true"`, it merges any draft without a `hold` label.
- `GEMINI_API_KEY` lives in GitHub Secrets. It must never appear in any file.

## 4. Design rules (set by the owner)
1. **Phone first.** Design for a 390 px wide screen, then check desktop. Content stays within a 560 px column.
2. **Short landing screen.** It opens the feed by itself after about 5 seconds and always offers a way to skip or stay.
3. **Cards fill the screen.** Use the full height. The feed moves card to card; content inside a card never scrolls (it fights the swipe). If content doesn't fit, the image shrinks first.
4. **One story per card.**
5. **Headline:** a short, plain-language description of the development.
6. **Body:** what it means in a product designer's working life. This is the hero; nothing else on the card front should compete with it.
7. **Learn tab stays in the top bar** for beginners: course list, roadmap, and a section for new and trending courses.
8. **Images, in this order of preference:** (1) the source's own image when `sources.json` allows reuse, shown with credit; (2) an openly licensed image with its licence and credit (not built yet; images from a Google search are not automatically free to use); (3) the generated illustration.

### Build guardrails
- Colours only through tokens (`--accent`, `--c-*`, `--on-accent`). Never hard-code a hex value in a component.
- Light and dark mode must both work. Check both.
- Type: Bricolage Grotesque for headings, Geist for body text, Geist Mono for small labels.
- Motion is quick (under ~0.6 s) and is switched off when the reader has asked for reduced motion.
- Accessibility: tap targets at least 44 px, readable contrast, everything usable with a keyboard.
- Microcopy: plain and direct, no hype words, no emoji, British spelling.

## 5. Content rules
- `editorial-prompt.md` is the source of truth for editorial rules. In short: title ≤ 12 words; design implication 55–70 words (why it matters → how daily work changes → one thing to start doing); summary 30–40 words; key facts 2–3 bullets of ≤ 12 words; card front ≤ 82 words.
- Never copy article text from sources into the site. Summarise in AI Signal's own words and link to the original.
- Never invent facts, numbers, quotes or URLs.

## 6. How to work
- **Never push to `main`.** Work on a branch and open a pull request; the owner reviews the diff and merges. Never start a branch name with `digest/` (auto-publish merges those).
- Explain the plan before editing. Keep each PR to one purpose and as small as it can be.
- Before opening a PR, test in a browser at 390×844, 375×667, desktop, and in dark mode. Check for console errors and that no card content scrolls inside.
- In the PR, say what changed, why, and how it was tested, with screenshots for visual changes.
- After a merge, the live site can take up to ~10 minutes to update because of caching.

## 7. Don't touch without asking
- `.github/workflows/*`, GitHub Secrets and repo variables
- The pipeline: `scripts/`, `sources.json`, `editorial-prompt.md`. Changes here alter tomorrow's brief.
- Published `data/*.json` files, `digest/*` branches and draft PRs
- The analytics ID and the feedback email address
- Deleting files or branches

## Known leftovers (cleanup candidates; ask before removing)
- Old card styles that the newer layout overrides (the card v1 rules near the top of the CSS)
- The topic chips and the reading ring: built in code but always hidden
- Colour tokens named after old areas (`--c-cloud` is used for Design tools, `--c-iam` for Design impact)
- Digest mode and splash variants A and C: in the code but switched off
