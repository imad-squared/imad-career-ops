/*
 * Unit test for the pure targeting module — NO browser required.
 *
 * Covers the two accuracy layers and the triage that feeds the auto-run:
 *   - the built search URL for each profile / recency window
 *   - title relevance (include, exclude, and the fail-open cases)
 *   - decideCard: promoted / already-saved / viewed / off-target, and the peeks
 *   - the seen-set pruning policy
 *
 * Run: node test/targeting.test.mjs
 */
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../extension/targeting.js', import.meta.url), 'utf8');
(0, eval)(code);
const T = globalThis.__liTargeting;

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// ===== Layer 1: the search URL ==========================================
const gtm = T.getProfile('gtm');
const hse = T.getProfile('hse');

const gtmDay = T.buildSearchUrl(gtm, T.RECENCY.day);
const gtmWeek = T.buildSearchUrl(gtm, T.RECENCY.week);

check('gtm: active profile is the go-to-market one', T.activeProfile().key === 'gtm', T.activeProfile().key);
check('gtm url: 24h window sets f_TPR=r86400', /[?&]f_TPR=r86400\b/.test(gtmDay));
check('gtm url: week window sets f_TPR=r604800', /[?&]f_TPR=r604800\b/.test(gtmWeek));
check('gtm url: sorted newest-first', /[?&]sortBy=DD\b/.test(gtmDay));
check("gtm url: workplaceType 'any' emits NO f_WT", !/f_WT=/.test(gtmDay));
check('gtm url: geo is pinned (an unset geo is not neutral — LinkedIn goes sticky)',
  /[?&]geoId=92000000\b/.test(gtmDay) && /location=Worldwide/.test(gtmDay));
check('gtm url: keywords are a quoted boolean OR', (() => {
  const kw = decodeURIComponent((gtmDay.match(/[?&]keywords=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
  return kw.includes(' OR ') && kw.includes('"GTM Manager"') && kw.includes('"Go-to-Market Manager"');
})());

check('hse url: the previous default is preserved byte-for-byte',
  (() => {
    const u = T.buildSearchUrl(hse, T.RECENCY.day);
    const kw = decodeURIComponent((u.match(/[?&]keywords=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
    return /geoId=100459316\b/.test(u) && /location=Saudi\+Arabia/.test(u) && /sortBy=DD/.test(u) &&
      !/f_WT=/.test(u) && kw.includes('"EHS Manager"') && kw.includes('"HSE Manager"');
  })());

// ===== Layer 2: title relevance =========================================
const rel = (title, p = gtm) => T.relevanceOf(title, p);

check('relevance: a plain GTM title is kept', rel('Go-to-Market Manager').ok);
check('relevance: a real posting seen live is kept',
  rel('Senior Data Centre AI Software Product Strategy & GTM Lead').ok);
check('relevance: product marketing counts as GTM', rel('Senior Product Marketing Manager').ok);
check('relevance: revops counts as GTM', rel('Revenue Operations Manager').ok);
// The single biggest false positive: GTM is also GOOGLE TAG MANAGER.
check('relevance: "Google Tag Manager Specialist" is dropped',
  !rel('Google Tag Manager Specialist').ok, rel('Google Tag Manager Specialist').reason);
check('relevance: an analytics role tagged GTM/GA4 is dropped',
  !rel('Digital Analytics Manager (GTM, GA4)').ok);
check('relevance: frontline quota sales is dropped', !rel('Sales Development Representative').ok);
check('relevance: an unrelated title is dropped (not merely un-matched)',
  !rel('Senior Backend Engineer').ok, rel('Senior Backend Engineer').reason);
// Fail-open cases: never let the filter silently eat a whole page.
check('relevance: an empty title fails OPEN', rel('').ok);
check("relevance: a profile with mode 'off' keeps everything",
  rel('Senior Backend Engineer', hse).ok && rel('Google Tag Manager Specialist', hse).ok);

// ===== Triage ===========================================================
const seen = new Set(['111']);
const never = () => 1; // rand that never triggers a peek
const always = () => 0; // rand that always triggers a peek
const d = (card, rand = never, s = seen) => T.decideCard(card, { seen: s, profile: gtm, rand });

check('triage: a clean on-target card is opened',
  d({ id: '1', title: 'Go-to-Market Manager' }).action === 'open');
check('triage: a promoted card is skipped',
  (() => { const r = d({ id: '2', title: 'Go-to-Market Manager', promoted: true }); return r.action === 'skip' && r.reason === 'promoted'; })());
check('triage: a promoted card is occasionally peeked instead (never a perfect 100%)',
  (() => { const r = d({ id: '2', title: 'Go-to-Market Manager', promoted: true }, always); return r.action === 'peek' && r.reason === 'promoted-peek'; })());
check('triage: an already-saved job is skipped',
  (() => { const r = d({ id: '111', title: 'Go-to-Market Manager' }); return r.action === 'skip' && r.reason === 'seen'; })());
check('triage: an already-saved job is NEVER peeked, even on a peek roll',
  d({ id: '111', title: 'Go-to-Market Manager', promoted: true }, always).reason === 'seen');
check('triage: a LinkedIn-"Viewed" card is skipped',
  d({ id: '3', title: 'Go-to-Market Manager', viewed: true }).reason === 'viewed');
check('triage: an off-target title is skipped',
  d({ id: '4', title: 'Google Tag Manager Specialist' }).reason === 'off-target');
check('triage: an off-target title is occasionally peeked',
  d({ id: '4', title: 'Google Tag Manager Specialist' }, always).reason === 'off-target-peek');
// The virtualization case: LinkedIn's list is lazy, so an off-screen <li> has an id but
// no text. Guessing from a blank card would skip the entire page.
check('triage: an unrendered card fails OPEN, never skipped on no evidence',
  (() => { const r = d({ id: '5', unknown: true }); return r.action === 'open' && r.reason === 'unknown'; })());
check('triage: an unrendered PROMOTED-looking card still fails open',
  d({ id: '6', unknown: true, promoted: true }).action === 'open');

// Determinism: same card + same injected rand => same decision, every time.
check('triage: deterministic under an injected rand', (() => {
  const seq = [0.9, 0.01, 0.5, 0.02];
  const run = () => { let i = 0; const r = () => seq[i++ % seq.length];
    return ['a', 'b', 'c', 'd'].map((id) => T.decideCard({ id, title: 'Growth Marketing Manager', promoted: true }, { seen, profile: gtm, rand: r }).action).join(','); };
  return run() === run();
})());

// Skipping must be *possible* to disable wholesale.
check('triage: SKIP toggles are honored', (() => {
  const off = { promoted: false, seen: false, viewed: false, offTarget: false, PROMOTED_PEEK_PROB: 0, OFFTARGET_PEEK_PROB: 0 };
  return T.decideCard({ id: '111', title: 'Google Tag Manager Specialist', promoted: true, viewed: true },
    { seen, profile: gtm, skip: off, rand: never }).action === 'open';
})());

// ===== Seen-set pruning =================================================
check('seen: pruning keeps the newest N and drops the oldest', (() => {
  const map = {};
  for (let i = 0; i < 50; i++) map['j' + i] = { at: 1000 + i };
  const out = T.pruneSeen(map, 10);
  return Object.keys(out).length === 10 && out.j49 && out.j40 && !out.j39 && !out.j0;
})());
check('seen: pruning is a no-op below the cap', Object.keys(T.pruneSeen({ a: { at: 1 } }, 10)).length === 1);
check('seen: pruning survives junk input', (() => {
  const out = T.pruneSeen({ a: null, b: { at: 5 }, c: {} }, 2);
  return Object.keys(out).length === 2;
})());

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
