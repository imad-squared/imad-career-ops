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

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}  (seed sample actor: ${JSON.stringify(h.actor, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v)})`);
process.exit(failures === 0 ? 0 : 1);
