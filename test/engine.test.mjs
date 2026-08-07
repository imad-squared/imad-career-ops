/*
 * Statistical unit test for the pure timing engine — NO browser required.
 * Validates the properties CLAUDE.md's "Testing" section calls for:
 *   - CV of inter-action intervals ~ 0.5–1.0
 *   - positive lag-1 autocorrelation (runs, not iid jitter)
 *   - no sub-human reaction floor
 *   - reading/think time correlates with on-screen text volume
 *   - determinism under a fixed seed
 *
 * Run: node test/engine.test.mjs
 */
import { readFileSync } from 'node:fs';

// Load the browser-less engine by evaluating it in global scope (it assigns
// globalThis.__liHumanize). No DOM, no Playwright involved.
const code = readFileSync(new URL('../extension/humanize.js', import.meta.url), 'utf8');
(0, eval)(code);
const H = globalThis.__liHumanize;

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function autocorr1(a) {
  const m = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) den += (a[i] - m) ** 2;
  for (let i = 1; i < a.length; i++) num += (a[i] - m) * (a[i - 1] - m);
  return num / den;
}

// --- Series with a FIXED word count: variance/autocorrelation come from tempo ---
const N = 4000;
const h = H.createHumanizer(12345);
const series = [];
for (let i = 0; i < N; i++) series.push(h.advanceDelayMs({ wordCount: 300, optionCount: 2 }).ms);

const cv = sd(series) / mean(series);
const ac = autocorr1(series);
const minMs = Math.min(...series);

check('CV of inter-action intervals in ~[0.5, 1.0]', cv >= 0.5 && cv <= 1.0, `CV=${cv.toFixed(3)}`);
check('positive lag-1 autocorrelation (runs, not iid)', ac > 0.1, `r1=${ac.toFixed(3)}`);
check('no sub-human reaction floor', minMs >= H.CONFIG.REACTION_FLOOR_MS - 1, `min=${Math.round(minMs)}ms`);
check('median interval is a slow, human pace (1–8 s)', (() => {
  const s = [...series].sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)];
  return med >= 1000 && med <= 8000;
})(), `median=${Math.round([...series].sort((a, b) => a - b)[Math.floor(N / 2)])}ms`);

// --- Content scaling: same seed, only word count differs (RNG stays in lockstep) ---
function meanFor(words) {
  const hh = H.createHumanizer(999);
  const xs = [];
  for (let i = 0; i < 2000; i++) xs.push(hh.advanceDelayMs({ wordCount: words, optionCount: 2 }).ms);
  return mean(xs);
}
const short = meanFor(40);
const long = meanFor(700);
check('think-time scales with description length', long > short * 1.3, `mean(40w)=${Math.round(short)}ms  mean(700w)=${Math.round(long)}ms`);

// --- Determinism under a fixed seed ---
const a = H.createHumanizer(42), b = H.createHumanizer(42);
let identical = true;
for (let i = 0; i < 500; i++) if (a.advanceDelayMs({ wordCount: 250 }).ms !== b.advanceDelayMs({ wordCount: 250 }).ms) { identical = false; break; }
check('deterministic under a fixed seed', identical);

// --- Batch (auto-run) inter-job gaps: human-paced, bounded, occasionally long-idle ---
const hb = H.createHumanizer(777);
const gaps = [], idles = [];
for (let i = 0; i < 3000; i++) { const g = hb.batchGapMs({ wordCount: 300 }); gaps.push(g.ms); if (g.idle > 0) idles.push(g.idle); }
const gapMedian = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
check('batch gap never below the configured floor', Math.min(...gaps) >= H.CONFIG.BATCH.MIN_GAP_MS - 1, `min=${Math.round(Math.min(...gaps))}ms`);
check('batch gap median is a slow human browse pace (7–40 s)', gapMedian >= 7000 && gapMedian <= 40000, `median=${Math.round(gapMedian)}ms`);
check('batch produces occasional heavy-tailed long idles', idles.length > 300 && Math.max(...idles) > 30000, `n_idle=${idles.length} maxIdle=${Math.round(Math.max(...idles) / 1000)}s`);
const g1 = H.createHumanizer(5).batchGapMs({ wordCount: 250 }).ms, g2 = H.createHumanizer(5).batchGapMs({ wordCount: 250 }).ms;
check('batch gap deterministic under a fixed seed', g1 === g2);
const modA = H.createHumanizer(9), modB = H.createHumanizer(9);
let modSame = true, sawKb = false, sawClick = false;
for (let i = 0; i < 200; i++) { const m = modA.nextModality(); if (m !== modB.nextModality()) modSame = false; if (m === 'keyboard') sawKb = true; if (m === 'click') sawClick = true; }
check('modality mixes both keyboard and click, deterministically', modSame && sawKb && sawClick);

// --- Glance / peek: the cost of passing over a card the filter rejected ---
// A skip must never be free (a 0 ms rejection is a new bot tell) and never uniform.
const hg = H.createHumanizer(2468);
const glances = [];
for (let i = 0; i < 3000; i++) glances.push(hg.glanceMs().ms);
const gMed = [...glances].sort((a, b) => a - b)[Math.floor(glances.length / 2)];
check('glance is never free and never sub-human', Math.min(...glances) >= H.CONFIG.SKIP.GLANCE_MIN_MS - 1, `min=${Math.round(Math.min(...glances))}ms`);
check('glance is bounded', Math.max(...glances) <= H.CONFIG.SKIP.GLANCE_MAX_MS + 1, `max=${Math.round(Math.max(...glances))}ms`);
check('glance median is a plausible eye-flick (0.3–2 s)', gMed >= 300 && gMed <= 2000, `median=${Math.round(gMed)}ms`);
check('glance has real variance (not a constant)', sd(glances) / mean(glances) > 0.2, `CV=${(sd(glances) / mean(glances)).toFixed(2)}`);
check('a run of 5 skips is seconds, not a machine burst', gMed * 5 >= 1500, `5x median=${Math.round(gMed * 5)}ms`);

// Glances share the SAME latent tempo as advances, so a slow stretch slows skips too.
const hmix = H.createHumanizer(1357);
const mixed = [];
for (let i = 0; i < 3000; i++) mixed.push(i % 2 ? hmix.glanceMs().ms : hmix.glanceMs().ms);
check('glance series is positively autocorrelated (shares the AR(1) tempo)', autocorr1(mixed) > 0.1, `r1=${autocorr1(mixed).toFixed(3)}`);

const hp = H.createHumanizer(864);
const peekShort = mean(Array.from({ length: 1500 }, () => hp.peekDwellMs({ wordCount: 30 }).ms));
const hp2 = H.createHumanizer(864);
const peekLong = mean(Array.from({ length: 1500 }, () => hp2.peekDwellMs({ wordCount: 900 }).ms));
check('peek dwell scales with the post it is skimming', peekLong > peekShort * 1.15, `30w=${Math.round(peekShort)}ms 900w=${Math.round(peekLong)}ms`);
check('peek dwell is bounded and never instant',
  peekShort >= H.CONFIG.SKIP.PEEK_MIN_MS - 1 && peekLong <= H.CONFIG.SKIP.PEEK_CAP_MS + 1);

const r1 = H.createHumanizer(31), r2 = H.createHumanizer(31);
let randSame = true;
for (let i = 0; i < 200; i++) if (r1.rand() !== r2.rand()) { randSame = false; break; }
check('exposed rand() is seeded and deterministic (peeks are reproducible)', randSame);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}  (seed sample actor: ${JSON.stringify(h.actor, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v)})`);
process.exit(failures === 0 ? 0 : 1);
