/*
 * Playwright harness: loads the unpacked extension into a real MICROSOFT EDGE window
 * (channel: 'msedge'), opens LinkedIn Jobs, waits for YOU to log in, then verifies that
 * both triggers (Alt+C and the floating button) copy the current job and advance to the
 * next — and that BOTH saved-search buttons (past 24h / past week) land on real
 * Saudi-Arabia HSE results inside their recency window.
 *
 * NOTE: this uses its own persistent Playwright profile (see userDataDir), NOT your
 * everyday Edge profile — so the FIRST run needs a manual login. It persists after that.
 *
 * Run:  npm run test:e2e
 * Results are written to test/results.json and printed to the console.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Load the pure targeting module the same way the Node unit tests do, so this harness
// asserts against the ACTIVE profile instead of a hardcoded query. Switching profiles in
// extension/targeting.js must not break the e2e.
(0, eval)(fs.readFileSync(new URL('../extension/targeting.js', import.meta.url), 'utf8'));
const TGT = globalThis.__liTargeting;
const PROFILE = TGT.activeProfile();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const extPath = path.join(projectRoot, 'extension');
// Persistent browser profile so you only log in once. Override with PW_PROFILE.
// Defaults to a portable OS-temp location (no hardcoded per-user path).
const userDataDir =
  process.env.PW_PROFILE ||
  path.join(os.tmpdir(), 'linkedin-jobs-copy-next', 'pw-profile');
const resultsPath = path.join(__dirname, 'results.json');
// Where the extension's downloads land during this test. We point Chrome here via CDP
// (browser-wide, so it catches the service worker's chrome.downloads call) and then
// assert a jobs-md/*.md file actually appears — the wiring a Node unit test can't cover.
const mdDir = path.join(os.tmpdir(), 'linkedin-jobs-copy-next', 'e2e-downloads');

const JOBS_URL = 'https://www.linkedin.com/jobs/collections/recommended/';
const LOGIN_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes to log in

const SEL = {
  DESC: [
    '#job-details',
    '.jobs-description__content .jobs-box__html-content',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    'article.jobs-description__container',
    '.jobs-description__content',
    '.jobs-description__text',
  ],
  TITLE: [
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    'h1.jobs-unified-top-card__job-title',
    '.jobs-details-top-card__job-title',
    'h1',
  ],
  COMPANY: [
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
    '.jobs-details-top-card__company-url',
  ],
  CARDS: ['li[data-occludable-job-id]', '.scaffold-layout__list-item', '.jobs-search-results__list-item'],
};

const log = (...a) => console.log('[test]', ...a);
const results = { startedAt: new Date().toISOString(), steps: [], diag: null, verdict: {} };
const save = () => {
  try { fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2)); }
  catch (e) { console.log('save err', String(e)); }
};

// List saved .md files. Check both <mdDir>/jobs-md (real Chrome honors the subfolder) and
// <mdDir> root (CDP's setDownloadBehavior flattens the name to download.md in this harness).
function listSavedMd() {
  const out = [];
  for (const dir of [path.join(mdDir, 'jobs-md'), mdDir]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const p = path.join(dir, f);
        try { if (fs.statSync(p).isFile()) out.push({ file: f, p, mtime: fs.statSync(p).mtimeMs }); } catch (_) {}
      }
    } catch (_) {}
  }
  return out;
}
// Wait for a .md that appeared at/after `sinceMs` (i.e. saved by the trigger we just fired).
async function waitForSavedMd(page, sinceMs, timeoutMs = 9000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const hit = listSavedMd().filter((x) => x.mtime >= sinceMs - 1500).sort((a, b) => b.mtime - a.mtime)[0];
    if (hit) { try { return { file: hit.file, content: fs.readFileSync(hit.p, 'utf8') }; } catch (_) {} }
    await page.waitForTimeout(400);
  }
  return null;
}

// SPA re-renders (the advance click) can destroy the execution context mid-evaluate.
// Retry transient failures so the harness rides through LinkedIn's navigations.
async function evalSafe(page, fn, arg, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn, arg); }
    catch (e) {
      if (i === tries - 1) throw e;
      const transient = /context was destroyed|Execution context|Target closed|navigation/i.test(String(e));
      await page.waitForTimeout(transient ? 500 : 300);
    }
  }
}

async function waitForDescription(page, minLen = 200, timeoutMs = 12000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const len = await page
      .evaluate((sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return (el.innerText || '').trim().length; } return 0; }, SEL.DESC)
      .catch(() => 0);
    if (len >= minLen) return len;
    await page.waitForTimeout(400);
  }
  return 0;
}

async function runTrigger(page, label, fire) {
  await page.bringToFront();
  await evalSafe(page, () => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  const descLen = await waitForDescription(page); // let the job description finish rendering
  log(`${label}: description length before trigger = ${descLen}`);
  const before = await evalSafe(page, () => new URLSearchParams(location.search).get('currentJobId'));
  const expFrag = await evalSafe(page, (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) { const tx = (el.innerText || '').replace(/\s+/g, ' ').trim(); if (tx) return tx.slice(0, 80); }
    }
    return '';
  }, SEL.DESC);
  await evalSafe(page, (l) => { try { navigator.clipboard.writeText('__RESET_' + l + '__'); } catch (e) {} }, label);

  const t0 = Date.now();
  await fire();
  // Copy is immediate; the advance is intentionally delayed (human pacing). evalSafe rides
  // through the SPA re-render the advance triggers instead of crashing the whole run.
  await page.waitForTimeout(800);
  const clip = await evalSafe(page, () => navigator.clipboard.readText().then((t) => t).catch((e) => 'ERR:' + e));

  // Wait out the humanized delay: poll up to 22s for the job id to change.
  let after = before;
  while (Date.now() - t0 < 22000) {
    after = await evalSafe(page, () => new URLSearchParams(location.search).get('currentJobId'));
    if (after && after !== before) break;
    await page.waitForTimeout(400);
  }
  const advanceMs = Date.now() - t0;

  // Verify the structured .md actually hit disk via the service worker.
  const md = await waitForSavedMd(page, t0);
  const mdValid = md
    ? /^# /.test(md.content) && md.content.includes('**Company:**') &&
      md.content.includes('### Role Summary') && md.content.includes('### Key Responsibilities') &&
      md.content.includes('### Requirements & Qualifications')
    : false;

  const normClip = (typeof clip === 'string' ? clip : '').replace(/\s+/g, ' ').trim();
  const frag = expFrag.slice(0, 40);
  const copied = frag.length >= 20 ? normClip.includes(frag) : normClip.length > 40 && !normClip.startsWith('__RESET');
  const advanced = !!before && !!after && before !== after;
  const r = {
    step: label, before, after, advanced, copied, advanceMs,
    clipLen: typeof clip === 'string' ? clip.length : 0,
    expFrag, clipSample: normClip.slice(0, 180),
    mdSaved: !!md, mdValid, mdFile: md ? md.file : null, mdSample: md ? md.content.slice(0, 320) : '',
  };
  results.steps.push(r); save();
  log(`${label} =>`, JSON.stringify({ copied, advanced, advanceMs, mdSaved: r.mdSaved, mdValid, mdFile: r.mdFile, clipLen: r.clipLen }));
  await page.waitForTimeout(900); // let the busy lock release before the next trigger
  return r;
}

let context;
try {
  log('extension:', extPath);
  log('profile:', userDataDir);
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'msedge', // drive real Microsoft Edge, not Playwright's bundled Chromium
    viewport: null,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--start-maximized'],
  });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.linkedin.com' });
  } catch (e) { log('grant permissions err (non-fatal):', String(e)); }

  const page = context.pages()[0] || (await context.newPage());

  // Route ALL downloads (including the extension service worker's) to a known, clean dir
  // so we can verify the .md save. Browser-domain command => browser-wide.
  try { fs.rmSync(mdDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.mkdirSync(mdDir, { recursive: true }); } catch (_) {}
  try {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: mdDir, eventsEnabled: true });
    } catch (_) {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: mdDir });
    }
    log('downloads routed to', mdDir);
  } catch (e) { log('setDownloadBehavior err (non-fatal):', String(e)); }

  // Surface what the extension is doing: content-script logs, page errors, and the
  // service worker (background.js) that performs the actual chrome.downloads save.
  page.on('console', (m) => { const t = m.text(); if (/copy\+next|li-cn|jobs-md|download|save/i.test(t)) log('PAGE:', m.type(), t); });
  page.on('pageerror', (e) => log('PAGE error:', String(e)));
  context.on('serviceworker', (w) => log('SW registered:', w.url()));

  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto err:', String(e)));
  for (const w of context.serviceWorkers()) log('SW present:', w.url());

  let windowClosed = false;
  context.on('close', () => { windowClosed = true; });
  page.on('close', () => { windowClosed = true; });

  log('>>> Please LOG IN in the opened browser window, then open a Jobs search / the "Jobs" tab.');
  log(`>>> I will auto-detect when job listings appear (waiting up to ${Math.round(LOGIN_TIMEOUT_MS / 60000)} minutes)...`);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let cards = 0;
  let lastUrl = '';
  let ticks = 0;
  while (Date.now() < deadline) {
    if (windowClosed || page.isClosed()) { windowClosed = true; break; }
    try {
      cards = await page
        .evaluate((sels) => { for (const s of sels) { const n = document.querySelectorAll(s).length; if (n) return n; } return 0; }, SEL.CARDS)
        .catch(() => 0);
      const url = page.url();
      // Log only when the URL changes or every ~1 min, to avoid flooding the log.
      if (url !== lastUrl || ticks % 12 === 0) log(`poll: cards=${cards} url=${url}`);
      lastUrl = url;
      ticks++;
      if (cards > 0) break;
      // If logged in but not on a jobs list (e.g. feed), nudge to Jobs. Never interrupt auth pages.
      if (!/\/jobs\//.test(url) && !/(login|checkpoint|authwall|uas\/login|signup)/i.test(url)) {
        await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await page.waitForTimeout(5000);
    } catch (e) {
      if (/closed/i.test(String(e))) { windowClosed = true; break; }
      throw e;
    }
  }
  results.steps.push({ step: 'login-wait', cards, url: windowClosed ? '(window closed)' : page.url() });
  save();
  if (windowClosed) throw new Error('The browser window was closed before a signed-in Jobs page appeared — please keep it open and log in.');
  if (!cards) throw new Error('No job cards detected before timeout — probably not logged in / not on a jobs page.');

  // Make sure a job is open in the right-hand pane.
  let curId = await page.evaluate(() => new URLSearchParams(location.search).get('currentJobId'));
  if (!curId) {
    log('No job open yet; clicking the first card.');
    await page.evaluate((sels) => {
      let li; for (const s of sels) { li = document.querySelector(s); if (li) break; }
      if (li) { const a = li.querySelector('a.job-card-container__link, a.job-card-list__title, a[href*="/jobs/view/"], a'); (a || li).click(); }
    }, SEL.CARDS);
    await page.waitForTimeout(2500);
    curId = await page.evaluate(() => new URLSearchParams(location.search).get('currentJobId'));
  }
  log('current job id:', curId);

  // Wait for the extension to inject its UI and for the description to render,
  // so the diagnostics reflect a ready page (not a mid-load snapshot).
  await page.waitForSelector('#li-cn-btn', { timeout: 15000 }).catch(() => log('WARN: extension button (#li-cn-btn) not found in time'));
  await waitForDescription(page);

  // Diagnostics: which selectors actually match on the live page.
  const diag = await page.evaluate((sel) => {
    const probe = (arr) => arr.map((s) => { try { return { s, n: document.querySelectorAll(s).length }; } catch (e) { return { s, err: String(e) }; } });
    const firstText = (arr) => { for (const s of arr) { const el = document.querySelector(s); if (el) return { s, len: (el.innerText || '').length, sample: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 150) }; } return null; };
    return {
      btnPresent: !!document.getElementById('li-cn-btn'),
      desc: firstText(sel.DESC), descProbe: probe(sel.DESC),
      title: firstText(sel.TITLE), company: firstText(sel.COMPANY),
      cardsProbe: probe(sel.CARDS),
    };
  }, SEL);
  results.diag = diag; save();
  log('diagnostics:', JSON.stringify(diag, null, 2));

  // Test 1: keyboard shortcut (copy + humanized advance).
  const kb = await runTrigger(page, 'keyboard', async () => { await page.keyboard.press('Alt+KeyC'); });
  // Test 2: floating button (copy + humanized advance).
  const bt = await runTrigger(page, 'button', async () => {
    await page.click('#li-cn-btn', { timeout: 5000 }).catch((e) => log('button click err:', String(e)));
  });

  // Test 3: both saved-search buttons (HSE · Saudi Arabia · past 24h and past week).
  // Week runs first and MUST return results; the 24h window is reported but never
  // failed on an empty day — zero fresh postings in 24h is a fact about the market,
  // not a bug in the filter.
  const windows = [
    { name: 'week', sel: '#li-cn-search-week', tpr: 'r604800', maxAgeH: 24 * 7, requireNonEmpty: true },
    { name: '24h', sel: '#li-cn-search', tpr: 'r86400', maxAgeH: 24, requireNonEmpty: false },
  ];
  // Location assertions only mean something when the profile PINS a country. The
  // go-to-market profile is deliberately Worldwide, so there is nothing to assert —
  // we report the spread instead of failing on it.
  const GEO_EXPECT = {
    hse: {
      label: 'Saudi Arabia',
      re: /saudi arabia|riyadh|jeddah|jiddah|dammam|khobar|dhahran|jubail|yanbu|makkah|mecca|medina|madinah|tabuk|abha|neom|ksa\b/i,
      forbid: /pakistan|karachi|lahore|islamabad/i,
    },
  };
  const geoExpect = GEO_EXPECT[PROFILE.key] || null;
  const searchResults = {};

  for (const w of windows) {
    await page.waitForSelector(w.sel, { timeout: 15000 }).catch(() => log(`WARN: ${w.sel} not present`));
    await page.click(w.sel, { timeout: 5000 }).catch((e) => log(`${w.name} search click err:`, String(e)));

    // Wait for the SPA to land on the built search URL (carrying this window's f_TPR).
    let url = page.url();
    const st0 = Date.now();
    while (Date.now() - st0 < 15000) {
      url = page.url();
      if (new RegExp(`f_TPR=${w.tpr}`).test(url)) break;
      await page.waitForTimeout(400);
    }

    // Every assertion derived from the active profile — no hardcoded query.
    const decodedKw = decodeURIComponent((url.match(/[?&]keywords=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
    const urlOk =
      decodedKw === PROFILE.keywords &&
      new RegExp(`f_TPR=${w.tpr}`).test(url) &&
      (PROFILE.geoId ? new RegExp(`geoId=${PROFILE.geoId}\\b`).test(url) : true) &&
      (PROFILE.sortByDate ? /sortBy=DD/.test(url) : true) &&
      // 'any' must NOT emit a workplace filter; anything else must.
      (PROFILE.workplaceType === 'any' ? !/f_WT=/.test(url) : /f_WT=/.test(url));

    // Read the result cards: how many, where, and how old.
    let cards = { count: 0, rows: [], banner: '', empty: false };
    try {
      await page.waitForSelector(
        'li[data-occludable-job-id], .scaffold-layout__list-item, .jobs-search-no-results-banner',
        { timeout: 20000 }
      );
      await page.waitForTimeout(2500); // let the lazy list settle
      cards = await page.evaluate(() => {
        const els = [...document.querySelectorAll('li[data-occludable-job-id], .scaffold-layout__list-item')];
        const banner = document.querySelector('.jobs-search-results-list__subtitle, small.jobs-search-results-list__text');
        return {
          count: els.length,
          empty: !!document.querySelector('.jobs-search-no-results-banner, .jobs-search-results-list__no-results'),
          banner: banner ? (banner.innerText || '').replace(/\s+/g, ' ').trim() : '',
          // Drop not-yet-rendered (occluded/lazy) cards: they have no text, so counting
          // them as "off-location" or undated would misreport the result set.
          rows: els.slice(0, 25).map((li) => {
            const text = (li.innerText || '').replace(/\s+/g, ' ').trim();
            const m = text.match(/(\d+)\s*(minute|hour|day|week|month)s?\s*ago/i);
            return { text, ageNum: m ? Number(m[1]) : null, ageUnit: m ? m[2].toLowerCase() : null };
          }).filter((r) => r.text.length > 0),
        };
      });
    } catch (e) { log(`${w.name} cards read err:`, String(e)); }

    // Age in hours, so we can assert every card really is inside the window.
    const H = { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720 };
    const ages = cards.rows.map((r) => (r.ageNum != null ? r.ageNum * H[r.ageUnit] : null));
    const dated = ages.filter((h) => h != null);
    const overWindow = dated.filter((h) => h > w.maxAgeH);
    const ksaCount = geoExpect ? cards.rows.filter((r) => geoExpect.re.test(r.text)).length : cards.rows.length;
    const pakistanCount = geoExpect ? cards.rows.filter((r) => geoExpect.forbid.test(r.text)).length : 0;
    const offLocation = geoExpect ? cards.rows.filter((r) => !geoExpect.re.test(r.text)).map((r) => r.text.slice(0, 90)) : [];

    const r = {
      step: `search-${w.name}`,
      urlOk, url,
      // cardCount = every <li> in the list (matches LinkedIn's own "N results" banner);
      // renderedCards = the subset with text, which the counts below are computed over.
      cardCount: cards.count, renderedCards: cards.rows.length,
      banner: cards.banner, noResultsBanner: cards.empty,
      ksaCount, pakistanCount,
      datedCards: dated.length, maxAgeHours: dated.length ? Math.max(...dated) : null,
      withinWindow: overWindow.length === 0, overWindowHours: overWindow,
      // Non-fatal: LinkedIn also surfaces region-wide REMOTE postings in a country search.
      offLocation,
      sample: cards.rows.slice(0, 6).map((x) => x.text.slice(0, 110)),
      // Verdict for this window. Week must be non-empty; 24h may legitimately be empty.
      ok: urlOk && overWindow.length === 0 && pakistanCount === 0 &&
        (w.requireNonEmpty ? cards.count > 0 && ksaCount > 0 : true),
    };
    searchResults[w.name] = r;
    results.steps.push(r); save();
    log(`search-${w.name} =>`, JSON.stringify({
      ok: r.ok, urlOk, cards: r.cardCount, ksaCount, pakistanCount,
      maxAgeHours: r.maxAgeHours, withinWindow: r.withinWindow, banner: r.banner,
    }));
    log(`  ages(h):`, JSON.stringify(ages));
    log(`  sample:`, JSON.stringify(r.sample, null, 1));
    if (offLocation.length) log(`  off-location (non-fatal, LinkedIn region-wide remote):`, JSON.stringify(offLocation));
  }

  // Test 4: the two search SHORTCUTS (the buttons above prove the URLs; this proves the
  // bindings). Fired in the order week -> 24h so each press must CHANGE f_TPR — pressing
  // the shortcut for the window you're already on would pass without proving anything.
  // Caveat: Playwright's synthetic Alt+Shift can't detect a Windows *language-switch*
  // hotkey collision; if you add a second keyboard layout, rebind in SHORTCUTS.
  const shortcuts = [
    { name: 'Alt+Shift+G', keys: 'Alt+Shift+KeyG', tpr: 'r604800' },
    { name: 'Alt+G', keys: 'Alt+KeyG', tpr: 'r86400' },
  ];
  const shortcutResults = {};
  for (const s of shortcuts) {
    await page.bringToFront();
    await evalSafe(page, () => { const a = document.activeElement; if (a && a.blur) a.blur(); });
    await page.waitForSelector('#li-cn-search', { timeout: 15000 }).catch(() => log('WARN: panel missing before shortcut'));
    await page.keyboard.press(s.keys);
    let url = page.url();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      url = page.url();
      if (new RegExp(`f_TPR=${s.tpr}`).test(url)) break;
      await page.waitForTimeout(400);
    }
    const ok = new RegExp(`f_TPR=${s.tpr}`).test(url) && /geoId=100459316/.test(url);
    shortcutResults[s.name] = { ok, url };
    results.steps.push({ step: `shortcut-${s.name}`, ok, url });
    save();
    log(`shortcut ${s.name} =>`, JSON.stringify({ ok, expected: s.tpr }));
  }

  // Test 5: card triage against the LIVE DOM. This is the check a Node unit test
  // structurally cannot make. `window.__liCopyNext` lives in the content script's
  // ISOLATED world and is unreachable from page.evaluate, so we verify the two things
  // that are observable from the page: (a) the selectors the extension classifies with
  // still match real markup, and (b) the extension's own skip marks land on the DOM.
  //
  // The recommended collection is used because it is dense with sponsored cards
  // (measured 16/24 promoted), so "0 promoted found" there is a real failure signal
  // rather than an empty sample.
  const triage = { probe: null, marks: null };
  try {
    await page.goto('https://www.linkedin.com/jobs/collections/recommended/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('li[data-occludable-job-id], .scaffold-layout__list-item', { timeout: 25000 });
    await page.waitForTimeout(2000);
    // The list is virtualized — force the cards to render before reading them.
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const li = document.querySelector('li[data-occludable-job-id]');
      let sc = li ? li.parentElement : null;
      while (sc && sc !== document.body && sc.scrollHeight <= sc.clientHeight + 4) sc = sc.parentElement;
      for (let i = 0; i < 12; i++) { (sc && sc !== document.body ? sc : window).scrollBy(0, 500); await sleep(400); }
    });
    await page.waitForTimeout(1200);

    triage.probe = await page.evaluate(() => {
      const lis = [...document.querySelectorAll('li[data-occludable-job-id], .scaffold-layout__list-item')];
      const labelsOf = (li) => [...li.querySelectorAll('.job-card-container__footer-item, .job-card-container__footer-job-state, .job-card-list__footer-wrapper li, .job-card-container__footer-wrapper li')]
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
      const rows = lis.map((li) => {
        const strong = li.querySelector('a.job-card-container__link strong, a.job-card-list__title strong');
        const labels = labelsOf(li);
        return {
          rendered: !!(li.innerText || '').trim(),
          title: strong ? (strong.innerText || '').replace(/\s+/g, ' ').trim() : null,
          promoted: labels.some((l) => /^promoted\b/.test(l)),
          viewed: labels.some((l) => /^viewed\b/.test(l)),
          labelled: labels.length > 0,
        };
      }).filter((r) => r.rendered);
      return {
        rendered: rows.length,
        withTitle: rows.filter((r) => r.title).length,
        withFooterLabels: rows.filter((r) => r.labelled).length,
        promoted: rows.filter((r) => r.promoted).length,
        viewed: rows.filter((r) => r.viewed).length,
        sampleTitles: rows.slice(0, 5).map((r) => r.title),
      };
    });
    log('triage probe =>', JSON.stringify(triage.probe));

    // Wiring check: start a SHORT auto-run and confirm the extension actually dims and
    // badges the cards it steps over, then stop it with Esc.
    await page.bringToFront();
    await evalSafe(page, () => { const a = document.activeElement; if (a && a.blur) a.blur(); });
    await page.keyboard.press('Alt+KeyA');
    const t0 = Date.now();
    let marked = 0;
    while (Date.now() - t0 < 75000) {
      marked = await page.evaluate(() => document.querySelectorAll('.li-cn-skip[data-li-cn-skip]').length).catch(() => 0);
      if (marked > 0) break;
      await page.waitForTimeout(1500);
    }
    triage.marks = await page.evaluate(() => ({
      skipped: [...document.querySelectorAll('.li-cn-skip[data-li-cn-skip]')].map((el) => el.getAttribute('data-li-cn-skip')),
      saved: document.querySelectorAll('.li-cn-saved').length,
    }));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    log('triage marks =>', JSON.stringify(triage.marks));
  } catch (e) {
    triage.error = String(e).slice(0, 300);
    log('triage probe err:', String(e).slice(0, 200));
  }
  results.steps.push({ step: 'triage', ...triage });
  save();

  results.verdict = {
    profile: PROFILE.key,
    profileLabel: PROFILE.label,
    buttonPresent: diag.btnPresent,
    descriptionFound: !!diag.desc,
    keyboardCopy: kb.copied, keyboardAdvance: kb.advanced, keyboardDelayMs: kb.advanceMs,
    buttonCopy: bt.copied, buttonAdvance: bt.advanced, buttonDelayMs: bt.advanceMs,
    humanPacing: kb.advanceMs > 600 || bt.advanceMs > 600,
    // Saved search, per recency window.
    searchWeekOk: searchResults.week.ok,
    searchWeekCards: searchResults.week.cardCount,
    searchWeekOnLocationCards: searchResults.week.ksaCount,
    searchWeekWithinWindow: searchResults.week.withinWindow,
    search24hOk: searchResults['24h'].ok,
    search24hCards: searchResults['24h'].cardCount, // 0 is acceptable on a quiet day
    search24hOnLocationCards: searchResults['24h'].ksaCount,
    search24hWithinWindow: searchResults['24h'].withinWindow,
    // Only meaningful when the profile pins a country (see GEO_EXPECT).
    geoAsserted: !!geoExpect,
    searchForbiddenLocationCards: searchResults.week.pakistanCount + searchResults['24h'].pakistanCount,
    shortcutAltG: shortcutResults['Alt+G'].ok,
    shortcutAltShiftG: shortcutResults['Alt+Shift+G'].ok,
    // Triage: selector health + proof the skip marks reach the DOM.
    triageTitlesRead: triage.probe ? triage.probe.withTitle : 0,
    triageFooterLabelsRead: triage.probe ? triage.probe.withFooterLabels : 0,
    triagePromotedDetected: triage.probe ? triage.probe.promoted : 0,
    triageViewedDetected: triage.probe ? triage.probe.viewed : 0,
    triageCardsMarkedSkipped: triage.marks ? triage.marks.skipped.length : 0,
    triageSkipReasons: triage.marks ? [...new Set(triage.marks.skipped)] : [],
    markdownSaved: kb.mdSaved || bt.mdSaved,
    markdownValid: kb.mdValid || bt.mdValid,
    markdownFiles: listSavedMd().map((x) => x.file),
  };
  results.finishedAt = new Date().toISOString();
  save();
  log('VERDICT:', JSON.stringify(results.verdict, null, 2));
  const sample = [kb, bt].find((x) => x && x.mdSample);
  if (sample) log(`\n----- SAVED .md (${sample.mdFile}) -----\n${sample.mdSample}\n-----------------------------`);
  log('saved .md dir:', path.join(mdDir, 'jobs-md'));
} catch (e) {
  results.error = String((e && e.stack) || e);
  save();
  log('FATAL:', String(e));
} finally {
  if (context) await context.close().catch(() => {});
  log('done — results at', resultsPath);
}
