/*
 * humanize.js — pure human-timing engine (NO DOM, NO Playwright).
 *
 * A small JS port of the two most load-bearing techniques from CLAUDE.md, applied
 * to the extension's single automated action (advance-to-next-job):
 *
 *   Technique 1 — TempoState: a latent tempo evolving as an AR(1) / Ornstein–
 *     Uhlenbeck process, multiplying every interval. Yields inter-action intervals
 *     with CV ~0.5–1.0 that are POSITIVELY AUTOCORRELATED (runs of fast/slow),
 *     never below a human reaction floor. Defeats the "constant/near-zero-variance"
 *     and "sub-human reaction floor" bot tells.
 *
 *   Technique 2 — Content-scaled think-time (READ + DECIDE): the pause before
 *     advancing scales with the CURRENT job's word count (reading-speed prior x an
 *     L2 `r_read` multiplier, which per CLAUDE.md stays confined to the reading
 *     stage), plus a log-normal deliberation pause. Defeats the "reading time
 *     uncorrelated with on-screen text volume" bot tell.
 *
 * Invariant honored: one input -> one action; this engine only emits the delay to
 * wait before that single action. It never loops or fans out.
 *
 * The engine is deterministic under a fixed seed (RNG threaded explicitly, never
 * the global Math.random once seeded), so it can be unit-tested without a browser.
 */
(function () {
  'use strict';

  // ===== ALL PRIORS LIVE HERE ==========================================
  // Every number is a PRIOR to be replaced by fitted distributions once real
  // interaction telemetry exists (see CLAUDE.md "Calibration").
  const CONFIG = {
    // -- Technique 1: TempoState (AR(1) in log-space, so tempo stays positive) --
    TEMPO_PHI: 0.85, // prior: autocorrelation. Higher = longer fast/slow runs.
    TEMPO_SIGMA_STAT: 0.62, // prior: stationary sd of log-tempo -> tempo CV ~= 0.68.
    MICROBREAK_PROB: 0.06, // prior: chance an action carries a heavy-tailed pause.
    MICROBREAK_MIN_MS: 2000, // prior
    MICROBREAK_MAX_MS: 9000, // prior

    // -- Technique 2: content-scaled READ + DECIDE --
    // A verification skim, not a full re-read (the human already read it before
    // pressing). Grows ~linearly with words but caps, so long JDs stay usable.
    VERIFY_PER_WORD_MS: 7, // prior: ms of pre-move skim per word of description.
    VERIFY_CAP_MS: 6000, // prior: ceiling on the skim component.
    DECIDE_MEDIAN_MS: 550, // prior: median log-normal deliberation pause.
    DECIDE_SIGMA: 0.5, // prior: log-normal sigma (heavy right tail).
    HICK_A_MS: 120, // prior: Hick's law intercept.
    HICK_B_MS: 90, // prior: Hick's law slope (ms per bit).

    // -- Motor (Fitts-ish). NOT ESL-scaled per CLAUDE.md invariant #2 --
    MOTOR_BASE_MS: 180, // prior
    MOTOR_JITTER_MS: 90, // prior

    // -- Global pace knob: scale ALL delays. 1.0 = default; 0.5 = twice as fast;
    //    2.0 = twice as slow. The one number to turn if the pace feels off. --
    PACE_MULTIPLIER: 1.0, // prior / user preference

    // -- Bounds --
    REACTION_FLOOR_MS: 350, // prior: floor, well above the sub-human 80–100 ms tell.
    ACTION_CAP_MS: 13000, // prior: cap on the action pause (before any micro-break).
    GRAND_CAP_MS: 20000, // prior: absolute ceiling including a micro-break.

    // -- Consequence weight on the DECIDE stage (submit/delete > navigate) --
    CONSEQUENCE: { navigate: 1.0, submit: 1.6, destructive: 2.2 },

    // -- ActorProfile trait ranges, sampled once per session (seedable) --
    ACTOR: {
      TEMPO_MIN: 0.7, TEMPO_MAX: 1.4, // baseline tempo scalar T
      RREAD_MIN: 1.1, RREAD_MAX: 1.8, // L2 reading multiplier (reading stage only)
      DELIB_MIN: 0.7, DELIB_MAX: 1.3, // deliberateness D
    },

    // -- BATCH: pacing for the OPT-IN auto-run (walk the current page of jobs). This is
    //    the SessionEnvelope layer from CLAUDE.md — a person browsing a list dwells on
    //    each posting, takes irregular multi-second-to-minute breaks, and never machine-
    //    guns. Every number is a prior. Gaps are deliberately generous (browsing, not a
    //    committed keypress) so the run stays firmly human-paced. --
    BATCH: {
      GAP_MULTIPLIER: 1.7, // browse dwell runs a bit longer than a committed advance
      LONGIDLE_PROB: 0.20, // per job: chance of a heavy-tailed "distraction" idle
      LONGIDLE_MEDIAN_MS: 17000, // prior: median long idle (~17 s)
      LONGIDLE_SIGMA: 0.75, // heavy right tail — occasional minute-plus idle
      LONGIDLE_CAP_MS: 120000, // ceiling on a single idle (2 min)
      MIN_GAP_MS: 6000, // never faster than 6 s between jobs in a batch
      MAX_GAP_MS: 90000, // ceiling on a single inter-job gap
      MODALITY_KEYBOARD_PROB: 0.45, // fraction of advances that add keyboard-style events
      MAX_JOBS: 40, // hard cap on jobs processed per auto-run
      MAX_SESSION_MS: 900000, // hard cap on auto-run duration (15 min)
    },
  };

  // ===== RNG (mulberry32) + samplers, all threaded explicitly ==========
  function mulberry32(a) {
    let s = a >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const lognormal = (rng, median, sigma) => median * Math.exp(sigma * gauss(rng));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  /**
   * @param {number} [seed] optional integer seed. Omit for a fresh "person" per session.
   */
  function createHumanizer(seed) {
    const s = (seed === undefined ? Math.floor(Math.random() * 4294967296) : seed) >>> 0;
    const rng = mulberry32(s);
    const A = CONFIG.ACTOR;

    // ActorProfile: sampled once, fixed for the session.
    const T = A.TEMPO_MIN + rng() * (A.TEMPO_MAX - A.TEMPO_MIN);
    const rRead = A.RREAD_MIN + rng() * (A.RREAD_MAX - A.RREAD_MIN);
    const D = A.DELIB_MIN + rng() * (A.DELIB_MAX - A.DELIB_MIN);

    // TempoState: start from the stationary distribution.
    let logTempo = gauss(rng) * CONFIG.TEMPO_SIGMA_STAT;

    function advanceDelayMs({ wordCount = 0, optionCount = 2, consequence = 'navigate' } = {}) {
      // --- Technique 1: AR(1) tempo update (multiplies everything) ---
      const innov = Math.sqrt(1 - CONFIG.TEMPO_PHI * CONFIG.TEMPO_PHI) * CONFIG.TEMPO_SIGMA_STAT;
      logTempo = CONFIG.TEMPO_PHI * logTempo + innov * gauss(rng);
      const tempo = T * Math.exp(logTempo);

      // --- Technique 2: content-scaled READ (skim) + DECIDE ---
      const verifyMs = Math.min(CONFIG.VERIFY_CAP_MS, CONFIG.VERIFY_PER_WORD_MS * Math.max(0, wordCount) * rRead);
      const hickMs = CONFIG.HICK_A_MS + CONFIG.HICK_B_MS * Math.log2(Math.max(1, optionCount) + 1);
      const consequenceW = CONFIG.CONSEQUENCE[consequence] ?? 1.0;
      const decideMs = lognormal(rng, CONFIG.DECIDE_MEDIAN_MS, CONFIG.DECIDE_SIGMA) * D * consequenceW;

      // --- Motor (not ESL-scaled) ---
      const motorMs = CONFIG.MOTOR_BASE_MS + Math.abs(gauss(rng)) * CONFIG.MOTOR_JITTER_MS;

      let action = CONFIG.PACE_MULTIPLIER * tempo * (verifyMs + decideMs + hickMs + motorMs);
      action = clamp(action, CONFIG.REACTION_FLOOR_MS, CONFIG.ACTION_CAP_MS);

      // Occasional heavy-tailed micro-break — part of Technique 1's "runs & pauses".
      let microbreakMs = 0;
      if (rng() < CONFIG.MICROBREAK_PROB) {
        microbreakMs = CONFIG.MICROBREAK_MIN_MS + rng() * (CONFIG.MICROBREAK_MAX_MS - CONFIG.MICROBREAK_MIN_MS);
      }
      const total = Math.min(CONFIG.GRAND_CAP_MS, action + microbreakMs);

      return { ms: total, tempo, components: { verifyMs, decideMs, hickMs, motorMs, microbreakMs } };
    }

    // Inter-job gap for the auto-run: a content-scaled browse dwell (reuses Techniques 1+2
    // via advanceDelayMs, so tempo stays autocorrelated across the run) PLUS an occasional
    // heavy-tailed long idle. Returns the total gap and its parts (for logging/UI).
    function batchGapMs({ wordCount = 0 } = {}) {
      const B = CONFIG.BATCH;
      const base = advanceDelayMs({ wordCount, optionCount: 2, consequence: 'navigate' }).ms * B.GAP_MULTIPLIER;
      let idle = 0;
      if (rng() < B.LONGIDLE_PROB) idle = Math.min(B.LONGIDLE_CAP_MS, lognormal(rng, B.LONGIDLE_MEDIAN_MS, B.LONGIDLE_SIGMA));
      const ms = clamp(base + idle, B.MIN_GAP_MS, B.MAX_GAP_MS + B.LONGIDLE_CAP_MS);
      return { ms, base, idle };
    }

    // Vary the input modality between advances (mix clicks + keyboard-style events).
    function nextModality() {
      return rng() < CONFIG.BATCH.MODALITY_KEYBOARD_PROB ? 'keyboard' : 'click';
    }

    return {
      advanceDelayMs,
      batchGapMs,
      nextModality,
      seed: s,
      actor: { T, rRead, D },
    };
  }

  const api = { createHumanizer, CONFIG };
  // Works in the extension's isolated world (globalThis === that window) and in Node.
  if (typeof globalThis !== 'undefined') globalThis.__liHumanize = api;
})();
