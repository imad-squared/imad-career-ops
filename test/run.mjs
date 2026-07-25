/*
 * Playwright harness: loads the unpacked extension into a real Chromium window,
 * opens LinkedIn Jobs, waits for YOU to log in, then verifies that both triggers
 * (Alt+C and the floating button) copy the current job and advance to the next.
 *
 * Run:  npm test
 * Results are written to test/results.json and printed to the console.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

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

  // Test 3: saved-search navigation (GTM · Remote · past 24h).
  const beforeUrl = page.url();
  await page.click('#li-cn-search', { timeout: 5000 }).catch((e) => log('search click err:', String(e)));
  let searchUrl = beforeUrl;
  const st0 = Date.now();
  while (Date.now() - st0 < 12000) {
    searchUrl = page.url();
    if (/[?&]keywords=GTM/i.test(searchUrl)) break;
    await page.waitForTimeout(400);
  }
  const searchOk =
    /[?&]keywords=GTM/i.test(searchUrl) && /f_WT=2/.test(searchUrl) &&
    /f_TPR=r86400/.test(searchUrl) && /geoId=92000000/.test(searchUrl);

  // Read the locations of the first result cards to confirm the Pakistan default is gone.
  let sampleLocations = [];
  try {
    await page.waitForSelector('li[data-occludable-job-id], .scaffold-layout__list-item', { timeout: 12000 });
    await page.waitForTimeout(1800);
    sampleLocations = await page.evaluate(() => {
      const out = [];
      const els = document.querySelectorAll('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
      for (const el of els) { const t = (el.innerText || '').trim(); if (t) out.push(t); if (out.length >= 8) break; }
      return out;
    });
  } catch (e) { log('locations read err:', String(e)); }
  const pakistanCount = sampleLocations.filter((s) => /pakistan/i.test(s)).length;

  results.steps.push({ step: 'search', ok: searchOk, url: searchUrl, sampleLocations, pakistanCount });
  save();
  log('search =>', JSON.stringify({ ok: searchOk, url: searchUrl, pakistanCount, sampleLocations }));

  results.verdict = {
    buttonPresent: diag.btnPresent,
    descriptionFound: !!diag.desc,
    keyboardCopy: kb.copied, keyboardAdvance: kb.advanced, keyboardDelayMs: kb.advanceMs,
    buttonCopy: bt.copied, buttonAdvance: bt.advanced, buttonDelayMs: bt.advanceMs,
    humanPacing: kb.advanceMs > 600 || bt.advanceMs > 600,
    searchNavigates: searchOk,
    searchPakistanCards: pakistanCount,
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
