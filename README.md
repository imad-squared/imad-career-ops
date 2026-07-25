# LinkedIn Jobs: Copy + Next

A small Chrome/Edge extension for the LinkedIn **Jobs** page.

- **`Alt + C`** (or the blue **📋 Copy + Next** button): copies the current job — title,
  company, location, direct link, and full description — to your clipboard **and saves it as a
  structured Markdown file** in `Downloads/jobs-md/`, then, after a short **human-paced** delay,
  advances to the next job in the list.
- **`Alt + G`** (or the green **🔎 GTM · Remote · 24h** button): opens a LinkedIn Jobs
  search pre-filtered to your saved query (default: **GTM**, **Remote**, **past 24 hours**,
  newest first).

Then paste (`Ctrl + V`) wherever you keep notes / your ATS / a sheet.

## Saved Markdown files

Every copy also writes a clean, structured card to **`Downloads/jobs-md/<slug>-<jobId>.md`**:

```
# [Exact Job Title]
**Company:** [Company Name]
**Location:** [City, Country or Remote]
**URL:** [Link to the posting]

### Role Summary
…
### Key Responsibilities
- …
### Requirements & Qualifications
- …
```

- An extension can only write to your **Downloads** folder — not an arbitrary path — so files
  land in `Downloads/jobs-md/`. Re-copying a job **overwrites** its file (named by job id), so
  there are no `job (1).md` duplicates.
- The three-section split is a **heuristic** parse of the posting's own headings/bullets;
  boilerplate tails (benefits, EEO, how-to-apply) are trimmed. The full raw text still goes to
  your clipboard. See `jobs-md/README.md`.
- If Chrome is set to **"Ask where to save each file before downloading"** (Settings → Downloads),
  every copy will pop a save dialog. Turn it off for silent, one-keypress saves.
- The save needs the `downloads` permission, so after updating the extension click the **reload**
  icon on its card in `chrome://extensions`.

## What it does / doesn't do

- ✅ Every action is triggered by **one of your inputs → one action**. No loops, no
  background activity, no bulk scraping, no network calls, no access to your account data.
- ✅ Reads only what's already rendered on screen.
- ✅ Advances at a **human, variable pace** (see below), never machine-speed.
- ❌ Never runs unattended or on a timer.

Browser extensions that alter LinkedIn are discouraged by LinkedIn's Terms of Service; the
practical risk for personal, human-paced use is low, but it's your call. (If you're a
LinkedIn *employee*, check internal policy first.)

## Human-paced advancing

Per `CLAUDE.md`, the delay before each advance comes from a **pure timing engine**
(`extension/humanize.js`) implementing its two most load-bearing anti-bot-tell techniques:

1. **Autocorrelated tempo** — a latent tempo evolving as an AR(1) / Ornstein–Uhlenbeck
   process multiplies every interval, giving inter-action intervals a coefficient of
   variation ≈ 0.5–1.0 that is *positively autocorrelated* (real "runs" of fast/slow),
   never below a human reaction floor.
2. **Content-scaled think-time** — the pause scales with the current job description's word
   count (reading-speed prior × an L2 `r_read` multiplier) plus a log-normal decision pause.

The content script is a thin driver: it measures the DOM, asks the engine for a delay,
waits, then performs the single advance. Typical pause is a few seconds with an occasional
longer one — tune it with a single knob.

### Tuning

All knobs live at the top of the two files, each commented as a prior:

- **Pace:** `CONFIG.PACE_MULTIPLIER` in `extension/humanize.js` — `0.5` = twice as fast,
  `2.0` = twice as slow.
- **Saved search:** the `SEARCH` object at the top of `extension/content.js` — change
  `keywords`, `workplaceType` (`remote`/`onsite`/`hybrid`/`any`), `postedWithin`
  (`24h`/`week`/`month`/`any`), `sortByDate`.
- **Shortcuts:** the `SHORTCUTS` object in `extension/content.js`.

After any edit, click the reload icon on the extension card in `chrome://extensions`.

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked** → select the `extension/` folder
4. Go to a LinkedIn Jobs search and press `Alt + C` (or `Alt + G`)

## Tests

```
npm test        # no browser: timing-engine stats + job->Markdown formatter/section parsing
npm run test:e2e   # headed Playwright: loads the extension, you log in, verifies all actions
```

`npm test` runs two pure suites — the timing engine (CV, autocorrelation, scaling, floor) and
the Markdown formatter (template exactness, section routing, messy/header-less fallbacks).

`test:e2e` opens a browser on LinkedIn Jobs; log in and it auto-detects the listings, waits
for the page to be ready, then exercises `Alt+C`, the button, and the GTM search — and
**verifies a real `jobs-md/*.md` file is written** to a temp download dir. Results (measured
humanized delays, a live selector probe, and a saved-`.md` sample) land in `test/results.json`.
