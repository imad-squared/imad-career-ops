# LinkedIn Jobs: Copy + Next

A small Chrome/Edge extension for the LinkedIn **Jobs** page.

- **`Alt + C`** (or the blue **📋 Copy + Next** button): copies the current job — title,
  company, location, direct link, and full description — to your clipboard **and saves it as a
  structured Markdown file** in `Downloads/jobs-md/`, then, after a short **human-paced** delay,
  advances to the next job in the list.
- **`Alt + G`** (or the green **🔎 HSE · KSA · 24h** button) / **`Alt + Shift + G`** (or
  **🔎 HSE · KSA · Week**): opens a LinkedIn Jobs search pre-filtered to your saved query —
  by default **HSE / Health & Safety Manager roles in Saudi Arabia**, newest first, posted
  in the **past 24 hours** or the **past week** respectively.
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

## Saved search: HSE roles in Saudi Arabia

Both search buttons run the same query and differ only in the recency window:

| | Shortcut | Button | LinkedIn filter |
|---|---|---|---|
| Past 24 hours | `Alt + G` | 🔎 HSE · KSA · 24h | `f_TPR=r86400` |
| Past week | `Alt + Shift + G` | 🔎 HSE · KSA · Week | `f_TPR=r604800` |

Query details, and why each is what it is:

- **Location — `geoId=100459316` (Saudi Arabia).** The `geoId` is the parameter LinkedIn
  actually filters on; the human-readable `location=Saudi Arabia` only drives the UI. Both
  are set, because **LinkedIn silently defaults the location to your own profile region**
  otherwise. This geoId was read back from LinkedIn's own location typeahead rather than
  guessed — to re-resolve it (or switch countries), type the place into the Jobs location
  box, pick the suggestion, and copy the `geoId` out of the resulting URL.
- **Keywords — a boolean OR, not one phrase.** LinkedIn matches the posted title verbatim,
  and the same job is advertised under many names. A single bare phrase leaves the 24-hour
  window empty most days, so the default query ORs eight variants — each quoted so the
  phrases stay intact: *HSE Manager*, *EHS Manager*, *HSE Lead*, *EHS Lead*, *Health and
  Safety Manager*, *Health & Safety Manager*, *Safety Manager*, *HSE Supervisor*. **EHS**
  is the dominant form in Gulf industrial hiring, so don't drop it when editing.
  Measured caveat: LinkedIn *also* does its own semantic expansion, so listing the variants
  explicitly did not change the result count on the day this was tested (an
  "Environment, Health and Safety Manager" posting already matched). They're kept because
  that expansion is undocumented and can change — the explicit list is the guarantee.
- **Workplace type — `any`, deliberately.** HSE is an on-site discipline (plants, sites,
  refineries); filtering to *Remote* returns close to nothing within one country. `any`
  omits `f_WT` from the URL entirely.
- **Sort — `sortBy=DD`** (newest first), which is what makes a 24-hour window useful.

Two caveats worth knowing, neither of them a bug:

- **An empty 24-hour window is a normal result**, not a broken filter — some days simply
  have no new postings. Press `Alt + Shift + G` for the week view. (The e2e test encodes
  this: it requires the *week* window to return results but only *reports* the 24h count.)
- LinkedIn sometimes includes **region-wide remote postings** in a country search (e.g. an
  EMEA-wide "Safety Manager (Nordics)" appearing under Saudi Arabia). That comes from
  LinkedIn's own geo matching, not from these filters; the test lists such cards as
  `offLocation` without failing.

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
  `keywords`, `workplaceType` (`remote`/`onsite`/`hybrid`/`any`), `location` + `geoId`,
  `sortByDate`, and the short `label` shown on the buttons. The two recency windows live
  in the `RECENCY` object next to it (`f_TPR=r86400` = 24h, `r604800` = 7 days).
- **Shortcuts:** the `SHORTCUTS` object in `extension/content.js`. They match on
  `event.code`, so they're keyboard-layout independent. One Windows caveat: if you install
  a **second keyboard layout**, `Alt + Shift` becomes the OS language-switch hotkey and can
  swallow `Alt + Shift + G` before the page sees it — rebind `searchWeek` to something like
  `{ alt: true, shift: false, code: 'KeyW' }` if that happens.

After any edit, click the reload icon on the extension card in `chrome://extensions`.

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked** → select the `extension/` folder
4. Go to a LinkedIn Jobs search and press `Alt + C` (or `Alt + G` / `Alt + Shift + G`)

## Tests

```
npm test        # no browser: timing-engine stats + job->Markdown formatter/section parsing
npm run test:e2e   # headed Playwright: loads the extension, you log in, verifies all actions
```

`npm test` runs two pure suites — the timing engine (CV, autocorrelation, scaling, floor) and
the Markdown formatter (template exactness, section routing, messy/header-less fallbacks).

`test:e2e` opens **Microsoft Edge** (`channel: 'msedge'`) on LinkedIn Jobs; log in and it
auto-detects the listings, waits for the page to be ready, then exercises `Alt+C`, the copy
button, and **both** saved-search windows — and **verifies a real `jobs-md/*.md` file is
written** to a temp download dir. For each search window it asserts the built URL
(`f_TPR`, `geoId=100459316`, `sortBy=DD`, and **no** `f_WT`), that every dated result card
is inside the window, and that no Pakistan-region cards leak back in. Results (measured
humanized delays, a live selector probe, per-window card ages, and a saved-`.md` sample)
land in `test/results.json`.

> The harness runs in its **own persistent Playwright profile** (under your temp dir, or
> `PW_PROFILE`), not your everyday Edge profile — so the **first run needs a manual login**
> in the window it opens. It persists for later runs. This is deliberate: Playwright can't
> load an unpacked extension into an already-running Edge, and pointing it at your live
> profile would hit a profile lock.
