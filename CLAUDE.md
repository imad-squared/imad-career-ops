# CLAUDE.md

Project memory for this repository. Read this before doing anything. It defines
what we're building, the non-negotiable architecture, the behavioral model, and
the invariants that must never be violated.

---

## What this is

A Python library that simulates **human interaction timing** and drives a browser
via **Playwright**. It makes one simulated actor operate a system at a realistic
human pace, specifically modeling a person who uses **English as a second language
(ESL)**, with a strict **one-input-event → one-semantic-action** invariant.

This is a **personal, attended** tool. Every design choice must keep it in the
low-risk / human-paced regime. It must never behave like an unattended,
machine-speed scraper. When a choice trades realism/safety against speed, choose
realism/safety.

> **Amendment (v1.3, opt-in auto-run).** The tool now ships ONE deliberate,
> user-invoked exception to "non-looping": an **auto-run** that walks the *current
> page* of jobs, saving each as `.md` (see "Auto-run" below). It is not a scraper:
> it is opt-in, **bounded** (hard job + time caps, current page only, no
> pagination), **attended** (visible Stop via button/Esc/Alt+A, pauses when the tab
> is hidden, halts on a checkpoint page), and paced by the *same* human-timing
> engine plus a browsing-idle overlay. Everything else in this doc still holds; the
> auto-run is the only place a single input fans out, and it does so knowingly and
> reversibly. Keep all other paths one-input → one-action.

**Async vs sync:** default is **async Playwright** (`asyncio.sleep`, async `Page`),
which fits a delay-driven event loop cleanly. If this repo is built on sync
Playwright instead, the driver uses `sync_playwright` + `time.sleep` — do not mix
the two APIs in one path.

---

## Core architectural rule (do not violate)

**The timing/behavior engine is pure and framework-agnostic. Playwright is a thin
adapter that consumes the engine's output.**

- The engine imports **no Playwright**. It emits a stream of timed, typed events.
- A `PlaywrightDriver` consumes that stream and executes it against a `Page`.
- Swapping to another framework later means writing a new driver, never touching
  the engine.
- All human timing lives in the engine. The driver only sleeps and executes; it
  never invents delays or reaches for Playwright's internal waits as a substitute
  for human timing (auto-wait is layered *on top of*, not *instead of*, human
  timing).

---

## Module map

```
actor_profile.py         # per-actor traits, sampled once, seedable
session_envelope.py      # session bounds, fatigue, breaks, idle, failure policy
timing.py                # per-screen / per-element stage timing (TimingGenerator)
keystroke.py             # inter-keystroke timing + error/correction model
tempo.py                 # latent autocorrelated tempo state (TempoState)
events.py                # Event dataclasses (the engine↔driver contract)
engine.py                # orchestrator: wires the above into an event stream
config.py                # ALL priors centralized here
drivers/
  playwright_driver.py   # consumes event stream, executes against a Page
examples/
  fill_form.py           # runnable async demo (see Deliverables)
tests/                   # pytest, no browser required
```

---

## Event stream (engine ↔ driver contract)

The engine yields typed events, each carrying a delay/duration and payload.
Minimum event types:

`ORIENT`, `LOCATE`, `READ`, `DECIDE`, `MOVE`, `CLICK`, `KEYSTROKE`, `BACKSPACE`,
`MICRO_BREAK`, `LONG_IDLE`, `ABANDON`.

- `MOVE`/`CLICK` carry waypoints and scattered target coordinates (not a single
  hop, not dead-center).
- `KEYSTROKE`/`BACKSPACE` carry the character and its per-key delay.
- `READ`/`ORIENT`/`DECIDE`/`MICRO_BREAK`/`LONG_IDLE` carry a duration and produce
  no DOM action (pure sleep).

---

## Behavioral model (reference)

### ActorProfile — sampled once per actor, fixed for the session, seedable

Same seed reproduces the same "person." These give between-session consistency.

| Trait | Range / shape | Effect |
|---|---|---|
| baseline tempo `T` | 0.7–1.4× scalar | global multiplier on all intervals |
| L2 proficiency | intermediate → near-native | sets reading multiplier `r_read` ≈ 2.5× (intermediate) down to ≈ 1.3× (near-native) |
| typing style | touch-typist / hybrid / hunt-peck | sets inter-keystroke base |
| deliberateness `D` | careful → impulsive | scales hesitation + verification pauses |
| error proneness | 1–4% per keystroke | interacts with L2 on English spellings |

### SessionEnvelope — encodes human *presence* (the key safety layer)

- **Bounded duration.** Session ends; never continuous / overnight.
- **Fatigue drift.** Intervals drift up ~+10–40% by session end; error rate rises
  slightly. Implement as a slowly increasing scalar on `T`.
- **Micro-breaks.** Irregular 2–10 s pauses. NOT periodic.
- **Long idle.** Low-rate Poisson arrivals, heavy-tailed multi-minute durations.
  Their presence is a stronger human signal than any single gap.
- **No tight retry loop.** On failure → variable seconds-scale latency, often a
  re-read, plus a non-zero abandonment probability. This is the concrete
  difference from an unattended machine-speed loop.

### TimingGenerator — per-screen, per-element

On landing on a new screen, emit an **orientation/scan pause** (scales with layout
density) before the first action. Then per element, sum:

1. **Locate** — visual search cost, scales with layout density.
2. **Read** *(dominant ESL stage)* — `(word_count / 238 wpm) × r_read`. Apply
   `r_read` to labels, tooltips, and error text too. Add a **re-read probability**
   elevated for L2 and rising sharply on long or idiomatic/jargon-heavy text.
3. **Decide** — Hick's law `a + b·log2(n+1)` over option count, PLUS a separate
   log-normal deliberation pause (median ~300–800 ms, heavy right tail) scaled by
   `D` and by action consequence (submit/delete > navigate).
4. **Point** — Fitts's law `MT = a + b·log2(2·distance/width)`, `a`≈0–150 ms,
   `b`≈100–200 ms/bit. Path is **curved** (not straight), bell-shaped velocity,
   occasional overshoot-then-settle, a 50–150 ms micro-pause after settle before
   click, and click coordinates that **scatter** around the element.

### KeystrokeModel — second ESL-heavy stage

- Inter-keystroke intervals: **log-normal, digraph-dependent** (common bigrams
  faster). Medians: touch-typist ~120–220 ms; hunt-peck ~300–600 ms.
- Word-boundary/space keys slightly longer. Insert **heavy-tailed "recall" spikes**
  mid-word/mid-field; more frequent and larger for L2 and unfamiliar terms.
- **Errors:** per-keystroke typo rate with **variable detection latency**
  (sometimes next key, sometimes several chars late) → backspace + retype. Add a
  small ESL rate of homophone/spelling substitutions caught on re-read.

### TempoState — variability + autocorrelation (do not skip)

Latent tempo evolving as an **AR(1) / Ornstein–Uhlenbeck** drift, multiplying all
sampled intervals. Target **coefficient of variation ≈ 0.5–1.0** on inter-action
intervals, **positively autocorrelated** so fast/slow stretches persist. Per-action
jitter alone looks wrong — real people have runs.

---

## PlaywrightDriver rules

- Accept a Playwright `Page`; consume the event stream, sleeping each event's delay
  before executing. Prefer the async API.
- **MOVE/CLICK:** trace the engine's curved path with `mouse.move()` across the
  emitted waypoints (use `steps` and multiple calls). Click at the engine's
  scattered coords (bounding box + offset), NOT `page.click()` auto-center. Honor
  the post-settle micro-pause before `mouse.down/up`.
- **KEYSTROKE:** type character-by-character via `keyboard.type()/press()` with the
  engine's per-key delays. Never use `fill()` or a constant `delay=`. Execute
  BACKSPACE as real Backspace presses so corrections show up in input events.
- **READ/ORIENT/DECIDE/MICRO_BREAK/LONG_IDLE:** real `asyncio.sleep` of the emitted
  duration, no DOM action. Optionally scroll slightly during long reads.
- Resolve targets via locator/selector; use Playwright's visible/enabled auto-wait
  **on top of** human timing, never as a replacement.
- **Strict serial gating:** `await` each event fully before the next. No
  `asyncio.gather` / concurrency across actions.
- On failure/timeout: surface to `SessionEnvelope`'s failure policy (variable-
  latency re-read / possible abandonment), NOT an immediate retry.

---

## Auto-run (opt-in batch mode, v1.3)

A user-invoked mode (`Alt+A` / the amber ▶ button) that walks the **current page** of
job cards, running the Copy + Next action on each and saving the `.md`. It is the
SessionEnvelope layer made real, and it is the *only* sanctioned loop.

- **Pacing:** each inter-job gap comes from the engine (`humanizer.batchGapMs`) — the
  same autocorrelated tempo + content-scaled think-time as a manual advance, times a
  browse multiplier, PLUS a low-rate heavy-tailed **long idle** (Poisson-ish, multi-
  second to multi-minute). Median gap ~8–15 s; occasional minute-plus pauses. Modality
  alternates between click and keyboard-style events.
- **Bounded:** hard caps `MAX_JOBS` (40) and `MAX_SESSION_MS` (15 min); **current page
  only — never clicks "next page."**
- **Attended:** visible Stop (button / `Esc` / `Alt+A`); **pauses while the tab is
  hidden** (`document.hidden`), so it never runs in a background tab.
- **Fails safe:** halts on a checkpoint/verification page; on a missing description it
  waits a variable re-read latency and gives up after 3 in a row — never a tight retry.
- **Priors** live in `CONFIG.BATCH` in `extension/humanize.js`; the driver
  (`runAutoLoop` in `content.js`) only sequences and executes, never invents delays.
- **Serial:** `await`s each job's full copy → gap → advance before the next; the
  one-input→one-action budget still governs every internal step.

## Targeting & neglect (v1.5)

A third pure module, `extension/targeting.js` (`globalThis.__liTargeting`), owns every
*decision* about which cards are worth opening; `humanize.js` owns how long each
decision takes; `content.js` remains a driver that invents neither.

- **Two accuracy layers.** A keyword query also matches DESCRIPTION text, so it can never
  be precise on its own. Recall is server-side (a quoted boolean OR); precision is
  client-side (`relevanceOf` over the card TITLE). Exclusion is deliberately *not* a
  boolean `NOT` in the query — that would match description text and silently drop good
  jobs. Geo must be **pinned**: an unset location makes LinkedIn reuse a sticky region, so
  the same query returns a different country run to run. geoIds are read back from
  LinkedIn's typeahead, never guessed.
- **Neglect is modelled, not hard-coded.** Skipping is the *absence* of a click — the scan
  jumps ahead to the next good card rather than opening and bouncing out of bad ones — but
  it is never free: every skipped card costs a `glanceMs()` drawn from the same AR(1)
  tempo, and a small `*_PEEK_PROB` occasionally opens one anyway (skimmed, never saved,
  never recorded). A 100%-accurate, zero-cost filter would be a NEW bot tell, which is why
  invariant #3 below now names it.
- **Fail open, always.** No title, no filter configured, or an unrendered card ⇒ open it.
  LinkedIn's list is VIRTUALIZED: an off-screen `<li>` carries its job id but no text, so
  classifying a blank card would skip the entire page while every unit test still passed.
  Classification must scroll-into-view → wait for text → re-read → decide.
- **"Seen" means written.** A job enters the persisted seen set only when the service
  worker confirms the download; recording on the attempt would hide a job forever after a
  failed save. Peeked jobs never enter it — they weren't written.
- **Selectors are measured, not guessed.** The card markup in `content.js`
  (`CARD_TITLE_SELECTORS`, `CARD_STATE_SELECTORS`) came from a live Playwright probe. Two
  measured facts that are easy to get wrong: the title link's `innerText` is DOUBLED by a
  visually-hidden span (read the `<strong>`), and state labels are `<span>`s inside
  `li.job-card-container__footer-item`. Match them ANCHORED (`/^promoted\b/`) so a job
  titled "Promoted Content Manager" is never misread. Re-probe with
  `__liCopyNext.probeCards()` after any LinkedIn markup change.

## Hard invariants (enforce in code; assert in tests)

1. One input event → exactly one semantic action. Action *n+1* never starts before
   *n*'s full timing budget elapses. No batching, concurrency, pipelining, or one
   input fanning out into many calls. **Sole exception:** the opt-in **auto-run**
   (v1.3) may fan one input out into a *bounded, attended, human-paced* sequence over
   the current page — but each internal step still runs strictly serially (action
   *n+1* waits out *n*'s full budget), and it honors caps, a visible Stop, tab-hidden
   pause, and checkpoint halt. No other path may loop.
2. ESL multipliers stay **on the reading and text-entry stages only**. They must
   NOT bleed into pointing/motor timing — L2 status barely affects motor.
3. The simulator must **never** produce any of these bot tells:
   - constant / near-zero-variance intervals; periodic (evenly spaced) idle
   - sustained sub-human reaction floors (repeated <80–100 ms decisions)
   - reading time uncorrelated with on-screen text volume
   - zero errors / zero corrections, ever
   - instant retries after failure; **unbounded** continuous runtime; no long idle
     (the auto-run is *bounded* by hard job + time caps, so this still holds)
   - identical mouse paths or exact-center clicks; identical typing rhythm across
     fields
   - **a filter that is free or perfect**: rejecting a card in ~0 ms, or skipping 100% of
     a category (promoted / off-target) with no exceptions, forever. Every skip costs a
     sampled glance, and the peek probabilities keep the rate off 100% (v1.5).

---

## Coding conventions

- **All priors live in `config.py`.** Every magic number carries a comment noting
  it is a prior to be replaced by fitted distributions when real telemetry exists.
  No literals scattered through logic.
- Keep the engine deterministic under a fixed seed (thread the RNG explicitly;
  don't call global `random`).
- Type-hint everything; events are dataclasses.
- Engine has zero Playwright / IO dependencies so it stays unit-testable without a
  browser.

---

## Testing

pytest, **no browser required**, validating the pure engine statistically:

- CV of inter-action intervals falls in ~0.5–1.0
- autocorrelation of the interval series is positive
- idle events are non-periodic
- error + correction events actually occur over a session
- no sub-floor reaction times (no repeated <80–100 ms decisions)
- strict serial ordering and 1:1 event-to-action mapping hold
- fatigue: late-session intervals are drifted up vs early-session

---

## Demo (`examples/fill_form.py`)

Runnable async demo: launch Playwright **headed and slow enough to watch**,
navigate to a local example HTML form, fill it as one simulated ESL session —
including at least one visible **typo + correction** and one **long idle** — then
close. Emit a timestamped event log and a matplotlib plot of inter-action intervals
over the session so fatigue drift and runs are visible.

---

## Calibration

The numbers here are **priors**, not truth. If real interaction telemetry for the
target user exists, fit the per-stage distributions (especially `r_read`, the
inter-keystroke log-normal params, and idle arrival/duration) and replace the
priors in `config.py`. A calibrated model is far more faithful than any default.
Keep the ESL multipliers confined to the reading and text-entry stages during
calibration too.

---

## When starting fresh

Propose the module structure, the `Event` dataclass schema, and the `config`
schema first. Then implement engine → Playwright driver → tests → demo, in that
order.
