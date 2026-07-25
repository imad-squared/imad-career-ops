# LinkedIn Jobs: Copy + Next

A small Chrome/Edge extension for the LinkedIn **Jobs** page.

- **`Alt + C`** (or the blue **📋 Copy + Next** button): copies the current job — title,
  company, location, direct link, and full description — to your clipboard, then, after a
  short **human-paced** delay, advances to the next job in the list.
- **`Alt + G`** (or the green **🔎 GTM · Remote · 24h** button): opens a LinkedIn Jobs
  search pre-filtered to your saved query (default: **GTM**, **Remote**, **past 24 hours**,
  newest first).

Then paste (`Ctrl + V`) wherever you keep notes / your ATS / a sheet.

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
npm test        # pure timing-engine stats — no browser (CV, autocorrelation, scaling, floor)
npm run test:e2e   # headed Playwright: loads the extension, you log in, verifies all 3 actions
```

`test:e2e` opens a browser on LinkedIn Jobs; log in and it auto-detects the listings, waits
for the page to be ready, then exercises `Alt+C`, the button, and the GTM search. Results
(including the measured humanized delays and a live selector probe) land in
`test/results.json`.
