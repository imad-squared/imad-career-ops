# LinkedIn Jobs: Copy + Next

A small Chrome/Edge extension for the LinkedIn **Jobs** page.

- **`Alt + C`** (or the blue **📋 Copy + Next** button): copies the current job — title,
  company, location, direct link, and full description — to your clipboard **and saves it as a
  structured Markdown file** in `Downloads/jobs-md/`, then, after a short **human-paced** delay,
  advances to the next job in the list.
- **`Alt + G`** (or the green **🔎 GTM · 24h** button) / **`Alt + Shift + G`** (or
  **🔎 GTM · Week**): opens a LinkedIn Jobs search pre-filtered to your saved query —
  by default **go-to-market roles**, newest first, posted in the **past 24 hours** or the
  **past week** respectively.
- **`Alt + A`** (or the amber **▶ Auto page** button): **auto-saves every job on the current
  page** as `.md`, one after another at a human pace — a hands-off batch of Copy + Next.
  Stop anytime with the button, **`Esc`**, or `Alt + A`. Opt-in and bounded (current page
  only); see the risk note below.
- Both advance paths **step over** cards that aren't worth opening — **Promoted** (sponsored)
  posts, jobs you've **already saved**, ones LinkedIn marks **Viewed**, and titles that
  don't match the profile. Skipped cards are dimmed and badged with the reason, never
  hidden. See [Targeting & skipping](#targeting--skipping).

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

## Targeting & skipping

Everything about *what to look for* and *what to ignore* lives in one pure, unit-tested
file: **`extension/targeting.js`**. The content script owns no policy — it measures the
DOM, asks that module, and executes.

### Search profiles

Two profiles ship. Switch with the one-line `ACTIVE` constant at the top of
`extension/targeting.js`:

| Profile | `ACTIVE` | Targets | Location |
|---|---|---|---|
| **GTM** *(default)* | `'gtm'` | Go-to-market: GTM, RevOps, product marketing, growth, demand gen, sales enablement | Worldwide (`geoId=92000000`) |
| **HSE · KSA** | `'hse'` | HSE / EHS / Health & Safety Manager | Saudi Arabia (`geoId=100459316`) |

The HSE profile is preserved **exactly** as it shipped in v1.4 (same keywords, same geoId,
relevance filter off), so flipping `ACTIVE` back restores the previous behaviour byte-for-byte.

Both buttons run the active profile's query and differ only in the recency window
(`f_TPR=r86400` = 24h, `r604800` = 7 days), sorted newest-first (`sortBy=DD`).

### Why targeting takes two layers

A keyword query alone cannot be accurate, because **LinkedIn searches the description too**
— a posting that merely *mentions* "revenue operations" matches a `"Revenue Operations
Manager"` query. So accuracy is split:

1. **Server-side recall — a quoted boolean OR.** LinkedIn matches the posted title
   verbatim and the same role is advertised under many names, so each variant is listed and
   quoted (unquoted, `GTM Manager` also matches any manager posting that merely mentions
   GTM). LinkedIn *also* does its own undocumented semantic expansion; the explicit list is
   the guarantee, not an optimisation. Being broad here is fine — recall is this layer's job.
2. **Client-side precision — a title include/exclude pair.** Every card's title is
   re-checked in the browser. This is where the junk actually gets dropped, and it's done
   on the **title only**, on your machine, where it's visible and reversible. The biggest
   single win: **GTM is also the abbreviation for Google Tag Manager**, so a plain keyword
   search drags in web-analytics roles — the exclude list drops them, along with frontline
   quota-sales titles that "growth"/"revenue" pulls in.

   Exclusion is deliberately **not** done with a boolean `NOT` in the query: a server-side
   `NOT` also matches description text and would silently drop good jobs.

The filter **fails open** everywhere it is unsure — no title, no configured filter, or a
card that hasn't rendered yet all count as *keep*. Skipping a whole page by accident is far
worse than opening one extra job.

### What gets skipped

| Reason | Badge | What it means |
|---|---|---|
| `promoted` | PROMOTED | LinkedIn sponsored slot. Measured at **16/24** and **18/25** cards on the recommended and broad-search surfaces — this is most of a page. |
| `seen` | ALREADY SAVED | This tool already wrote the job's `.md`. Recorded **only after the download is confirmed**, so a failed save never makes a job invisible. |
| `viewed` | VIEWED | LinkedIn's own "you've looked at this" tag. |
| `off-target` | OFF-TARGET | The title failed the profile's relevance filter. |

Skipped cards are **dimmed and badged in place** — nothing is hidden or removed, and you
can still click any of them by hand. The already-saved list persists in `chrome.storage.local`
(capped at 2000 job ids, oldest pruned). Clear it from the page console with
`__liCopyNext.seen.clear()`.

### Skipping, human-mimicking

A filter that rejects 100% of sponsored cards, instantly, forever, is itself a machine
signature — so the neglect is modelled, not hard-coded:

- **A skipped card is never opened at all.** A person runs their eye down the list, clocks
  the little "Promoted" tag, and clicks the one worth reading; they don't open every card
  and bounce out of the bad ones. So the scan skips *ahead* to the next good card.
- **But skipping is never free.** Each rejected card costs a `glanceMs()` from the timing
  engine (log-normal, median ≈ 0.6–1 s, drawn from the *same* autocorrelated tempo as
  everything else, so a slow stretch slows the skips too). Five rejects in a row is a few
  seconds of scrolling and looking — not a zero-cost burst.
- **Occasionally it looks anyway.** ~8% of promoted cards and ~4% of off-target ones get a
  **peek**: opened, skimmed for a content-scaled dwell, then left *unsaved* and *not*
  recorded as seen. This is what keeps the skip rate off a perfect 100%.
- On the manual `Alt + C` path the scan is capped tight (`MANUAL_SCAN_CAP_MS`, ~1.8 s) so
  one keypress still feels like one keypress.

### Two caveats worth knowing, neither a bug

- **An empty 24-hour window is a normal result**, not a broken filter — some days simply
  have no new postings. Press `Alt + Shift + G` for the week view. (The e2e encodes this: it
  requires the *week* window to return results but only *reports* the 24h count.)
- **Leaving the location unset is not neutral.** LinkedIn then reuses a sticky/profile
  region, so the same query returns a different country depending on what you searched
  last — measured: an unpinned GTM search came back all-Saudi immediately after the HSE
  searches. That's why the GTM profile pins **Worldwide** rather than omitting the geo.
  Every geoId in the file was read back from LinkedIn's own location typeahead, never
  guessed: **Worldwide `92000000` · Pakistan `101022442` · Saudi Arabia `100459316`**. To
  resolve another, type the place into the Jobs location box, pick the suggestion, and copy
  the `geoId` out of the resulting URL.

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
- **Saved search:** the `PROFILES` object in `extension/targeting.js` — change `keywords`,
  `workplaceType` (`remote`/`onsite`/`hybrid`/`any`), `location` + `geoId`, `sortByDate`,
  the short `label` shown on the buttons, and the `relevance` include/exclude pair. Switch
  profiles with `ACTIVE`. The two recency windows live in `RECENCY` next to it.
- **What gets skipped:** the `SKIP` object in `extension/targeting.js` — flip `promoted`,
  `seen`, `viewed` or `offTarget` to `false` to stop skipping that category, or set the
  `*_PEEK_PROB` values to `0` to never open one out of curiosity. Setting a profile's
  `relevance.mode` to `'off'` disables title filtering for that profile only.
- **What a skip costs:** the `CONFIG.SKIP` block in `extension/humanize.js` (glance
  duration, scan caps, peek dwell).
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

`npm test` runs three pure suites — the timing engine (CV, autocorrelation, content
scaling, reaction floor, glance/peek bounds), **targeting** (built URLs per profile, title
include/exclude, triage decisions incl. the fail-open cases, seen-set pruning), and the
Markdown formatter (template exactness, section routing, messy/header-less fallbacks).

`test:e2e` opens **Microsoft Edge** (`channel: 'msedge'`) on LinkedIn Jobs; log in and it
auto-detects the listings, waits for the page to be ready, then exercises `Alt+C`, the copy
button, and **both** saved-search windows — and **verifies a real `jobs-md/*.md` file is
written** to a temp download dir. Every search assertion is derived from the **active
profile** (keywords, `f_TPR`, `geoId`, `sortBy`, and whether `f_WT` should appear), so
switching profiles doesn't break the harness; country checks only run for a profile that
pins one. It then runs a **triage probe** on the recommended collection — the surface
measured densest in sponsored cards — asserting the classifier's selectors still match live
markup and that the extension's own dim/badge marks reach the DOM. Results land in
`test/results.json`.

> Why the triage probe exists: a Node unit test **cannot** catch LinkedIn renaming a class.
> This repo has twice had green unit tests over a broken live path. The probe reads the real
> DOM; if `triagePromotedDetected` comes back `0` on that surface, the selectors have drifted.

> The harness runs in its **own persistent Playwright profile** (under your temp dir, or
> `PW_PROFILE`), not your everyday Edge profile — so the **first run needs a manual login**
> in the window it opens. It persists for later runs. This is deliberate: Playwright can't
> load an unpacked extension into an already-running Edge, and pointing it at your live
> profile would hit a profile lock.
