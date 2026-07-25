# LinkedIn Jobs: Copy + Next

A small Chrome/Edge extension for the LinkedIn **Jobs** page.

- **`Alt + C`** (or the blue **📋 Copy + Next** button): copies the current job — title,
  company, location, direct link, and full description — to your clipboard **and saves it as a
  structured Markdown file** in `Downloads/jobs-md/`, then, after a short **human-paced** delay,
  advances to the next job in the list.
- **`Alt + G`** (or the green **🔎 GTM · Remote · 24h** button): opens a LinkedIn Jobs
  search pre-filtered to your saved query (default: **GTM**, **Remote**, **past 24 hours**,
  newest first).
- **`Alt + A`** (or the amber **▶ Auto page** button): **auto-saves every job on the current
  page** as `.md`, one after another at a human pace — a hands-off batch of Copy + Next.
  Stop anytime with the button, **`Esc`**, or `Alt + A`. Opt-in and bounded (current page
  only); see the risk note below.

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

- ✅ **Default (Copy + Next):** every action is triggered by **one of your inputs → one
  action** — no loops, no background activity, no network calls, no access to your account data.
- ✅ **Opt-in auto-run (`Alt + A`):** a *bounded, attended* batch that walks only the **current
  page** of jobs. It's deliberately human-paced (variable multi-second gaps, occasional
  multi-minute idles), stops on `Esc`/button, **pauses when the tab is hidden**, halts on a
  verification/checkpoint page, and enforces hard **job (40) and time (15 min) caps**. It never
  paginates and never runs on a timer. This is the one place the tool loops — use it knowingly.
- ✅ Reads only what's already rendered on screen; advances at a **human, variable pace**,
  never machine-speed.

> ⚠️ **Risk note.** Any automated loop through your job list — *even human-paced* — is the
> category of activity LinkedIn detects and can **restrict or ban accounts** for. The pattern
> (continuous programmatic advancing with no human at the wheel) is the tell, not the speed;
> and a content script cannot forge genuinely trusted input events. The default
> one-keypress-per-job mode is materially lower-risk. Auto-run trades that for convenience —
> it's your call and your account. Browser extensions that alter LinkedIn are also discouraged
> by LinkedIn's ToS; if you're a LinkedIn *employee*, check internal policy first.

## Auto-run (opt-in batch)

Press **`Alt + A`** (or click **▶ Auto page**) once and it saves every job on the current page,
advancing itself with the same human-timing engine as Copy + Next — plus a browsing overlay:
generous inter-job dwell scaled to each description, occasional heavy-tailed idles, and a mix
of click/keyboard-style advances. Median gap is ~8–15 s with an occasional minute-plus pause.

Controls & guarantees:

- **Stop instantly:** the ⏹ **Stop** button, **`Esc`** (works even while typing), or `Alt + A`.
- **Attended:** if you switch away from the tab it **pauses**, resuming when you return.
- **Bounded:** stops at the end of the current page (no pagination), or after 40 jobs / 15 min.
- **Fails safe:** halts on a captcha/checkpoint page and after 3 consecutive missing descriptions
  (variable re-read latency between attempts — never a tight retry loop).

Tune the pacing/caps in the `CONFIG.BATCH` block at the top of `extension/humanize.js`.

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
