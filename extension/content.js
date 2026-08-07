/*
 * LinkedIn Jobs: Copy + Next  (content script / the "driver")
 * Runs on https://www.linkedin.com/jobs/*
 *
 * Actions (each is triggered by ONE of your inputs — one input -> one action):
 *   • Alt+C  or  📋 Copy + Next   — copy the current job (title, company, location,
 *                                   link, description) to the clipboard, then, after a
 *                                   human-paced delay, advance to the next job.
 *   • Alt+G        or  🔎 <profile> · 24h   — jump to a LinkedIn Jobs search pre-filtered
 *                                   to your saved query, posted in the past 24 hours.
 *   • Alt+Shift+G  or  🔎 <profile> · Week  — the same query over the past week.
 *                                   (Active profile lives in targeting.js; default is
 *                                   go-to-market roles, newest first.)
 *
 * This file is only the thin DRIVER. It owns no numbers and no policy:
 *   • humanize.js  — how long everything takes (autocorrelated tempo, content-scaled
 *                    think-time, glance cost, peek dwell).
 *   • targeting.js — which search to open, and whether a given card is worth opening
 *                    (promoted / already saved / already viewed / off-target).
 *   • jobmd.js     — how a job becomes a Markdown card.
 * The driver measures the DOM, asks those modules, sleeps, then acts.
 */
(() => {
  'use strict';
  if (window.__liCopyNextLoaded) return;
  window.__liCopyNextLoaded = true;

  // ===== Targeting (which search, and which cards are worth opening) =========
  // The saved-search profiles, the recency windows and every triage decision live in
  // targeting.js (pure, unit-tested). Edit THAT file to retarget; this file only
  // measures the DOM and executes. The stub keeps the copy path alive if the module
  // somehow failed to load — degrading to "open everything", never to a crash.
  const TGT = globalThis.__liTargeting || {
    RECENCY: { day: { key: '24h', tpr: 'r86400', label: '24h' }, week: { key: 'week', tpr: 'r604800', label: 'Week' } },
    activeProfile: () => ({ label: 'Search', keywords: '', workplaceType: 'any', location: '', geoId: '', sortByDate: true }),
    buildSearchUrl: () => location.href,
    decideCard: () => ({ action: 'open', reason: 'eligible' }),
    pruneSeen: (m) => m,
    REASON_LABEL: {},
    SKIP: { SEEN_MAX: 2000 },
  };
  const RECENCY = TGT.RECENCY;
  const SEARCH = TGT.activeProfile();

  // ===== Keyboard shortcuts (matched on e.code, layout-independent) ======
  const SHORTCUTS = {
    copyNext: { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyC', label: 'Alt + C' },
    // Two windows on two distinct inputs (one input -> one action; no cycling toggle).
    searchDay: { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyG', label: 'Alt + G' },
    searchWeek: { alt: true, ctrl: false, shift: true, meta: false, code: 'KeyG', label: 'Alt + Shift + G' },
    auto: { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyA', label: 'Alt + A' },
  };
  // ======================================================================

  const DESC_SELECTORS = [
    '#job-details',
    '.jobs-description__content .jobs-box__html-content',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    'article.jobs-description__container',
    '.jobs-description__content',
    '.jobs-description__text',
  ];
  const TITLE_SELECTORS = [
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    'h1.jobs-unified-top-card__job-title',
    '.jobs-details-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title h1',
    'h1',
  ];
  const COMPANY_SELECTORS = [
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
    '.jobs-details-top-card__company-url',
  ];
  const LOCATION_SELECTORS = [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.jobs-unified-top-card__subtitle-primary-grouping',
    '.job-details-jobs-unified-top-card__tertiary-description-container',
  ];
  const SEE_MORE_SELECTORS = [
    '.jobs-description__footer-button',
    'button.show-more-less-html__button--more',
    'footer button.artdeco-button--tertiary',
  ];
  const NEXT_PAGE_SELECTORS = [
    'button[aria-label="View next page"]',
    '.jobs-search-pagination__button--next',
    '.artdeco-pagination__button--next',
  ];
  const CARD_SELECTORS = [
    'li[data-occludable-job-id]',
    '.scaffold-layout__list-item',
    '.jobs-search-results__list-item',
  ];
  // MEASURED against the live signed-in DOM (throwaway Playwright probe, 2026-08-07),
  // not guessed. The title link's innerText is DOUBLED — LinkedIn renders a
  // visually-hidden duplicate ("Foo" + "Foo with verification") — so read the <strong>,
  // which carries the clean title on its own.
  const CARD_TITLE_SELECTORS = [
    'a.job-card-container__link strong',
    'a.job-card-list__title strong',
    '.job-card-list__title--link strong',
    'a.job-card-container__link',
  ];
  // Every card state label ("Promoted", "Viewed", "Easy Apply", the posting age, the
  // location…) is rendered as one of these footer items. Measured shape:
  //   <li class="job-card-container__footer-item inline-flex align-items-center">
  //     <span>Promoted</span>
  //   </li>
  const CARD_STATE_SELECTORS = [
    '.job-card-container__footer-item',
    '.job-card-container__footer-job-state',
    '.job-card-list__footer-wrapper li',
    '.job-card-container__footer-wrapper li',
  ];
  // Anchored, so a job actually TITLED "Promoted Content Manager" or a company called
  // "Viewed" can never be mistaken for a state label.
  const PROMOTED_RE = /^promoted\b/;
  const VIEWED_RE = /^viewed\b/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The pure timing engine (loaded by humanize.js just before this script).
  // Fall back to a simple jittered delay if it is somehow unavailable.
  const humanizer =
    globalThis.__liHumanize && globalThis.__liHumanize.createHumanizer
      ? globalThis.__liHumanize.createHumanizer()
      : { advanceDelayMs: () => ({ ms: 900 + Math.random() * 1800, tempo: 1, components: {} }) };

  function firstEl(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  const cleanInline = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cleanBlock = (s) =>
    (s || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const countWords = (s) => ((s || '').match(/\S+/g) || []).length;
  const textFrom = (selectors) => {
    const el = firstEl(selectors);
    return el ? el.innerText : '';
  };

  function tryExpandDescription() {
    const btn = firstEl(SEE_MORE_SELECTORS);
    if (btn) {
      const t = (btn.innerText || '').toLowerCase();
      if (t.includes('more') || t.includes('see')) {
        try { btn.click(); } catch (_) {}
      }
    }
  }

  function getDescription() {
    tryExpandDescription();
    const el = firstEl(DESC_SELECTORS);
    return el ? cleanBlock(el.innerText) : '';
  }

  function getCurrentJobId() {
    const p = new URLSearchParams(location.search).get('currentJobId');
    if (p) return p;
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    return m ? m[1] : null;
  }

  function jobUrl() {
    const id = getCurrentJobId();
    return id ? `https://www.linkedin.com/jobs/view/${id}/` : location.href;
  }

  function extractIdFromCard(li) {
    const a = li.querySelector('a[href*="currentJobId="], a[href*="/jobs/view/"]');
    if (a) {
      const href = a.getAttribute('href') || '';
      const q = href.match(/currentJobId=(\d+)/);
      if (q) return q[1];
      const v = href.match(/\/jobs\/view\/(\d+)/);
      if (v) return v[1];
    }
    return null;
  }

  function getCards() {
    let lis = [];
    for (const sel of CARD_SELECTORS) {
      lis = Array.from(document.querySelectorAll(sel));
      if (lis.length) break;
    }
    return lis.map((li) => {
      const id =
        li.getAttribute('data-occludable-job-id') ||
        li.getAttribute('data-job-id') ||
        (li.querySelector('[data-job-id]') && li.querySelector('[data-job-id]').getAttribute('data-job-id')) ||
        extractIdFromCard(li);
      const clickable =
        li.querySelector('a.job-card-container__link') ||
        li.querySelector('a.job-card-list__title') ||
        li.querySelector('a[href*="/jobs/view/"]') ||
        li.querySelector('a[href*="currentJobId="]') ||
        li.querySelector('div.job-card-container--clickable') ||
        li.querySelector('[role="link"]') ||
        li.querySelector('a') ||
        li;
      return { id: id ? String(id) : null, el: li, clickable };
    });
  }

  function findCurrentIndex(cards) {
    const currentId = getCurrentJobId();
    let idx = -1;
    if (currentId) idx = cards.findIndex((c) => c.id && c.id === currentId);
    if (idx === -1) {
      idx = cards.findIndex(
        (c) =>
          c.el.classList.contains('jobs-search-results-list__list-item--active') ||
          c.el.querySelector('.job-card-container--active') ||
          c.el.querySelector('[aria-current="page"]')
      );
    }
    return idx;
  }

  function findCardById(id) {
    if (!id) return null;
    return getCards().find((c) => c.id && c.id === String(id)) || null;
  }

  // The state labels on one card, lower-cased. Falls back to whole-card lines if the
  // footer selectors ever go stale (LinkedIn renames classes freely) — line 0 and 1 are
  // skipped because they are the doubled title.
  function cardLabels(li) {
    const labels = new Set();
    for (const sel of CARD_STATE_SELECTORS) {
      let els = [];
      try { els = li.querySelectorAll(sel); } catch (_) { continue; }
      for (const el of els) {
        const t = cleanInline(el.innerText).toLowerCase();
        if (t && t.length <= 48) labels.add(t);
      }
    }
    if (!labels.size) {
      const lines = (li.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      for (const l of lines.slice(2)) if (l.length <= 48) labels.add(l.toLowerCase());
    }
    return labels;
  }

  // Strip LinkedIn's repeated-prefix artefact. The bare title link reads
  // "Commissioning Manager Commissioning Manager with verification" — the duplicate is a
  // prefix, not an exact halving, so look for the longest immediately-repeated run of
  // words rather than splitting down the middle.
  function undouble(t) {
    const w = t.split(' ');
    for (let k = Math.floor(w.length / 2); k >= 1; k--) {
      if (w.slice(0, k).join(' ') === w.slice(k, 2 * k).join(' ')) return w.slice(0, k).join(' ');
    }
    return t;
  }

  function cardTitle(li) {
    const el = firstEl(CARD_TITLE_SELECTORS, li);
    // The <strong> (preferred) is already clean; only the bare-link fallback is doubled.
    if (el) { const t = cleanInline(el.innerText); if (t) return undouble(t); }
    const line = (li.innerText || '').split('\n').map((s) => s.trim()).find(Boolean);
    return line || '';
  }

  // Read one card into the plain object targeting.js triages. `unknown: true` means the
  // card had not rendered — LinkedIn's list is VIRTUALIZED, so an off-screen <li> carries
  // its job id but no text at all. Never guess from a blank card.
  function readCard(li) {
    const id =
      li.getAttribute('data-occludable-job-id') ||
      li.getAttribute('data-job-id') ||
      extractIdFromCard(li);
    if (!(li.innerText || '').trim()) return { id: id ? String(id) : null, unknown: true };
    const labels = Array.from(cardLabels(li));
    return {
      id: id ? String(id) : null,
      title: cardTitle(li),
      promoted: labels.some((l) => PROMOTED_RE.test(l)),
      viewed: labels.some((l) => VIEWED_RE.test(l)),
      unknown: false,
    };
  }

  // Bring an occluded card into view and wait for its text, so it can be classified.
  // Scrolling to look at a card before deciding is also what a person does, so this
  // costs nothing behaviorally.
  async function ensureCardReadable(li, timeoutMs = 1600) {
    if ((li.innerText || '').trim()) return true;
    try { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    let waited = 0;
    while (waited < timeoutMs) {
      await sleep(150);
      waited += 150;
      if ((li.innerText || '').trim()) return true;
    }
    return false;
  }

  // Dim a card we stepped over and badge it with the reason (or clear the mark).
  function markCard(el, reason) {
    if (!el || !el.classList) return;
    if (!reason) { el.classList.remove('li-cn-skip'); el.removeAttribute('data-li-cn-skip'); return; }
    el.classList.add('li-cn-skip');
    el.setAttribute('data-li-cn-skip', (TGT.REASON_LABEL && TGT.REASON_LABEL[reason]) || reason);
  }
  function markSaved(id) {
    const c = findCardById(id);
    if (c && c.el && c.el.classList) { c.el.classList.remove('li-cn-skip'); c.el.classList.add('li-cn-saved'); }
  }

  // ===== Seen set: jobs already written to disk ==========================
  // Persisted in chrome.storage.local so it survives reloads and whole sessions. A job
  // enters it ONLY when the service worker confirms the .md actually downloaded — an
  // attempted-but-failed save must not make a job invisible forever.
  const SEEN_KEY = 'liCnSeen';
  const seen = new Set();
  let seenLoaded = false;
  const seenReady = new Promise((resolve) => {
    if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)) { seenLoaded = true; resolve(); return; }
    try {
      chrome.storage.local.get(SEEN_KEY, (obj) => {
        if (!chrome.runtime.lastError && obj && obj[SEEN_KEY]) {
          for (const k of Object.keys(obj[SEEN_KEY])) seen.add(String(k));
        }
        seenLoaded = true;
        console.info('[Copy+Next] seen list loaded:', seen.size, 'jobs');
        resolve();
      });
    } catch (_) { seenLoaded = true; resolve(); }
  });

  function rememberSeen(job) {
    if (!job || !job.jobId) return;
    const id = String(job.jobId);
    seen.add(id);
    markSaved(id);
    if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)) return;
    try {
      chrome.storage.local.get(SEEN_KEY, (obj) => {
        if (chrome.runtime.lastError) return;
        const map = (obj && obj[SEEN_KEY]) || {};
        map[id] = { at: Date.now(), title: job.title || '', company: job.company || '' };
        chrome.storage.local.set({ [SEEN_KEY]: TGT.pruneSeen(map, TGT.SKIP && TGT.SKIP.SEEN_MAX) }, () => {
          if (chrome.runtime.lastError) console.warn('[Copy+Next] seen save:', chrome.runtime.lastError.message);
        });
      });
    } catch (_) {}
  }

  function forgetSeen() {
    seen.clear();
    try { chrome.storage.local.remove(SEEN_KEY, () => {}); } catch (_) {}
    for (const c of getCards()) if (c.el && c.el.classList) c.el.classList.remove('li-cn-saved');
    toast('🧹 Cleared the already-saved list');
  }

  // Deliver a real activation (navigation always needs a trusted-equivalent click; synthetic
  // KeyboardEvents can't trigger default actions), but vary the surrounding event stream:
  // 'keyboard' adds focus + Enter key events, 'click' adds a little pointer movement.
  function activate(el, modality) {
    try {
      if (modality === 'keyboard') {
        if (el.focus) el.focus();
        const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opt));
        el.dispatchEvent(new KeyboardEvent('keyup', opt));
      } else {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (r) {
          const x = r.left + r.width * (0.35 + Math.random() * 0.3);
          const y = r.top + r.height * (0.35 + Math.random() * 0.3);
          for (const t of ['mousemove', 'mouseover', 'mousemove']) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x + (Math.random() * 6 - 3), clientY: y + (Math.random() * 6 - 3) }));
          }
        }
      }
    } catch (_) {}
    try { el.click(); } catch (_) {}
  }

  const skipCfg = () =>
    (globalThis.__liHumanize && globalThis.__liHumanize.CONFIG.SKIP) ||
    { SCAN_CAP_MS: 25000, MANUAL_SCAN_CAP_MS: 1800 };

  /**
   * Scan forward from `startIdx` for the next card worth opening, stepping over the
   * ones targeting.js rejects (promoted / already saved / already viewed / off-target).
   *
   * This is where the "human-mimicking neglect" actually lives. A person does not click
   * every card and bounce straight back out of the sponsored ones — they run their eye
   * down the list, register the little "Promoted" tag, and click the one that looks
   * worth reading. So a skipped card is never opened at all, but it is never free
   * either: each one costs a `glanceMs()` from the engine, so a run of five rejects
   * takes a few seconds of scrolling and looking, not a machine-speed burst.
   */
  async function pickNextTarget(startIdx, opts) {
    const { manual = false } = opts || {};
    const K = skipCfg();
    const cap = manual ? K.MANUAL_SCAN_CAP_MS : K.SCAN_CAP_MS;
    const pace = (ms) => (manual ? sleep(ms) : interruptibleSleep(ms));
    const rand = humanizer.rand || Math.random;
    const skipped = [];
    let spent = 0;
    let nudged = false;
    let i = startIdx + 1;

    for (;;) {
      if (!manual && !auto.running) return { stopped: true, skipped };
      let cards = getCards();
      if (i >= cards.length) {
        if (nudged) return { end: true, skipped };
        // The list is lazy: scroll the tail into view once, then re-query.
        nudged = true;
        const last = cards[cards.length - 1];
        if (last && last.el) { try { last.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
        await pace(600 + Math.random() * 500);
        cards = getCards();
        if (i >= cards.length) return { end: true, skipped };
      }

      let entry = cards[i];
      await ensureCardReadable(entry.el);
      // Re-resolve by id: scrolling a virtualized list can replace the element.
      if (entry.id) entry = findCardById(entry.id) || entry;

      const card = readCard(entry.el);
      const decision = TGT.decideCard(card, { seen, profile: SEARCH, rand });

      if (decision.action !== 'skip') {
        markCard(entry.el, null);
        return {
          index: i, entry, card, skipped,
          // A "peek" is only meaningful to the auto-run (open but don't save). On the
          // manual path there is no save loop, so it collapses to a plain open.
          action: manual && decision.action === 'peek' ? 'open' : decision.action,
          reason: decision.reason,
        };
      }

      markCard(entry.el, decision.reason);
      skipped.push({ id: card.id, title: card.title, reason: decision.reason });
      if (spent < cap) {
        const g = humanizer.glanceMs ? humanizer.glanceMs().ms : 450 + Math.random() * 500;
        const take = Math.min(g, cap - spent);
        spent += take;
        await pace(take);
      }
      i++;
    }
  }

  // Advance to the next job WORTH opening. allowPaginate=false (auto-run scope = current
  // page) stops at the page boundary instead of clicking "next page". modality varies the
  // input event stream.
  async function advanceOnce(allowPaginate = true, modality = 'click', opts = {}) {
    const cards = getCards();
    if (!cards.length) return { ok: false, reason: 'no-cards', skipped: [] };
    const idx = findCurrentIndex(cards);
    if (idx === -1) return { ok: false, reason: 'current-not-found', skipped: [] };

    const pick = await pickNextTarget(idx, opts);
    if (pick.stopped) return { ok: false, reason: 'stopped', skipped: pick.skipped };
    if (pick.end) {
      if (!allowPaginate) return { ok: false, reason: 'end-of-page', skipped: pick.skipped };
      const nextPage = firstEl(NEXT_PAGE_SELECTORS);
      if (nextPage && !nextPage.disabled) {
        activate(nextPage, 'click');
        return { ok: true, page: true, skipped: pick.skipped };
      }
      return { ok: false, reason: 'end-of-list', skipped: pick.skipped };
    }

    const target = pick.entry;
    try { target.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    await sleep(120 + Math.random() * 200); // settle micro-pause before activating
    const live = (target.id && findCardById(target.id)) || target;
    activate(live.clickable || live.el, modality);
    return { ok: true, id: live.id, action: pick.action, reason: pick.reason, skipped: pick.skipped };
  }

  // Collect everything about the current job ONCE (incl. the live description element,
  // which the Markdown formatter parses into sections). Returns null if no description.
  function collectJob() {
    tryExpandDescription();
    const el = firstEl(DESC_SELECTORS);
    const description = el ? cleanBlock(el.innerText) : '';
    if (!description) return null;
    // The primary-description container is "Location · N ago · N applicants" — keep only
    // the first segment so the .md Location isn't polluted with posting metadata.
    const rawLocation = cleanInline(textFrom(LOCATION_SELECTORS));
    return {
      el,
      title: cleanInline(textFrom(TITLE_SELECTORS)),
      company: cleanInline(textFrom(COMPANY_SELECTORS)),
      location: rawLocation.split('·')[0].trim(),
      url: jobUrl(),
      description,
      wordCount: countWords(description),
      jobId: getCurrentJobId(),
    };
  }

  function buildClipboardText(job) {
    const j = job || collectJob();
    if (!j) return null;
    const headerLine = j.title && j.company ? `${j.title} — ${j.company}` : j.title || j.company || '';
    const header = [headerLine, j.location, j.url].filter(Boolean).join('\n');
    return { text: (header ? header + '\n\n' : '') + j.description, wordCount: j.wordCount };
  }

  // Save the current job as a structured Markdown file. Content scripts can't call
  // chrome.downloads, so we hand the formatted text to the service worker (background.js),
  // which writes it to Downloads/jobs-md/. Non-blocking; failure only toasts, never stops
  // the copy/advance (one input -> one action still holds).
  function saveJobAsMarkdown(job) {
    const fmt = globalThis.__liJobMd;
    if (!fmt || !job) return;
    if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage)) return;
    let markdown, filename;
    try {
      markdown = fmt.formatJobMarkdown({
        title: job.title, company: job.company, location: job.location, url: job.url,
        description: job.description, // parsed from innerText (LinkedIn DOM is non-semantic)
      });
      filename = fmt.buildFilename(job.title, job.jobId, job.company);
    } catch (e) {
      toast('⚠️ .md format failed: ' + (e && e.message ? e.message : e), true);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'li-cn-save-job', filename, markdown }, (resp) => {
        if (chrome.runtime.lastError) { console.warn('[Copy+Next] save msg error:', chrome.runtime.lastError.message); return; }
        // Remember the job ONLY once the download is confirmed. Recording on the
        // attempt would make a job that failed to save invisible to every later run.
        if (resp && resp.ok) { console.info('[Copy+Next] saved', resp.path); rememberSeen(job); }
        else if (resp) { console.warn('[Copy+Next] save failed:', resp.error); toast('⚠️ .md save failed: ' + resp.error, true); }
        else console.warn('[Copy+Next] save: no response from service worker');
      });
    } catch (_) { /* messaging unavailable — skip silently */ }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (__) {
        return false;
      }
    }
  }

  // Build the saved-search URL for one recency window (defaults to 24h). The query
  // itself is assembled by targeting.js, so it can be unit-tested without a browser.
  const buildSearchUrl = (recency) => TGT.buildSearchUrl(SEARCH, recency || RECENCY.day);

  function handleSearch(recency) {
    const r = recency || RECENCY.day;
    toast(`🔎 Searching: ${SEARCH.label} · past ${r.label}`);
    location.assign(buildSearchUrl(r));
  }

  // Copy the CURRENT job to the clipboard + save its .md. Shared by the manual button and
  // the auto-run. Returns null when there is no job description on the page.
  async function copyAndSaveCurrent() {
    const job = collectJob();
    if (!job) return null;
    const built = buildClipboardText(job);
    const copied = await copyToClipboard(built.text); // clipboard is ready immediately
    saveJobAsMarkdown(job); // structured .md -> Downloads/jobs-md (non-blocking)
    return { job, wordCount: built.wordCount, copied };
  }

  const auto = { running: false, starting: false, count: 0, saved: 0, misses: 0, peeked: 0, skips: {} };
  let busy = false;

  const tallySkips = (list) => { for (const s of list || []) auto.skips[s.reason] = (auto.skips[s.reason] || 0) + 1; };
  const skipTotal = () => Object.values(auto.skips).reduce((a, b) => a + b, 0);
  const skipSummary = () =>
    Object.entries(auto.skips)
      .map(([r, n]) => `${n} ${(TGT.REASON_LABEL && TGT.REASON_LABEL[r]) || r}`)
      .join(', ');

  async function handleCopyAndNext() {
    // Invariant: one input -> one action. A new trigger is refused until the
    // previous action's full (human) timing budget has elapsed.
    if (auto.running) { toast('⏸ Auto-run is active — Stop it first'); return; }
    if (busy) { toast('⏳ Still on the previous job…'); return; }
    busy = true;
    setCopyBtnBusy(true);
    try {
      const r = await copyAndSaveCurrent();
      if (!r) { toast('⚠️ No job description found on the page', true); return; }

      // Technique 1 + 2 live here: the engine returns a human-paced, content-scaled,
      // autocorrelated delay to wait before advancing.
      const delay = humanizer.advanceDelayMs({ wordCount: r.wordCount, optionCount: 2, consequence: 'navigate' }).ms;
      // An explicit keypress always wins — a job you already saved is re-saved (the
      // filename is idempotent, so it just overwrites) — but say so, so the duplicate
      // isn't a surprise. Only the AUTO-run silently skips what's already on disk.
      const dup = r.job && r.job.jobId && seen.has(String(r.job.jobId)) ? ' (already saved — re-saved)' : '';
      if (!r.copied) toast('⚠️ Copy failed', true);
      else toast(`Copied ✓${dup} · advancing in ${(delay / 1000).toFixed(1)}s`);

      await sleep(delay);

      // Manual advance skips the same cards the auto-run would, so Alt+C lands on the
      // next job actually worth reading. The scan is capped tight (MANUAL_SCAN_CAP_MS)
      // so one keypress still feels like one keypress.
      const res = await advanceOnce(true, 'click', { manual: true });
      const past = res.skipped && res.skipped.length ? ` (past ${res.skipped.length} skipped)` : '';
      if (res.ok) toast((res.page ? '→ next page' : '→ next job') + past);
      else toast('Copied ✓ (no next job to advance to)' + past);
    } catch (e) {
      toast('⚠️ ' + (e && e.message ? e.message : e), true);
    } finally {
      busy = false;
      setCopyBtnBusy(false);
    }
  }

  // ===== Auto-run: walk the CURRENT page of jobs, saving each as .md ==========
  // OPT-IN, bounded, attended. A deliberate, documented exception to one-input->one-action
  // (see CLAUDE.md "Auto-run"), kept in the human-paced regime by: engine-timed gaps + heavy-
  // tailed long idles, hard job & time caps, a visible Stop (button / Esc / Alt+A), pausing
  // while the tab is hidden, and auto-halt on a checkpoint/verification page or repeated
  // misses. It NEVER paginates — scope is the current page only.
  function isVisible(el) {
    if (!el) return false;
    const r = el.getClientRects();
    return r && r.length > 0 && el.offsetParent !== null;
  }
  function isBlockedPage() {
    if (/checkpoint|authwall|challenge|captcha|uas\/login|add-phone|security-verification|\/verify/i.test(location.href)) return true;
    // Only a VISIBLE captcha/challenge counts — LinkedIn preloads hidden challenge widgets
    // on normal pages, and treating those as "blocked" would refuse every auto-run.
    const el = document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], .challenge-dialog, [data-test-checkpoint]');
    return isVisible(el);
  }

  async function waitWhileHidden() {
    while (auto.running && document.hidden) await sleep(1000);
  }

  // Don't trust a fixed wait after advancing: LinkedIn can keep the PREVIOUS description
  // in #job-details while the URL already flipped to the next job, which would save the old
  // content under the new job's filename. Wait until the URL id matches the job we advanced
  // to AND its description is populated. Interruptible; doesn't count time while tab hidden.
  async function waitForJobReady(expectedId, timeoutMs = 12000) {
    let waited = 0;
    while (auto.running && waited < timeoutMs) {
      if (document.hidden) { await sleep(500); continue; }
      const idOk = !expectedId || getCurrentJobId() === String(expectedId);
      const el = firstEl(DESC_SELECTORS);
      const len = el ? (el.innerText || '').trim().length : 0;
      if (idOk && len >= 120) return true;
      await sleep(300);
      waited += 300;
    }
    return false;
  }

  // Sleep that aborts promptly on Stop and does NOT tick down while the tab is hidden
  // (so long idles don't elapse in a background tab).
  async function interruptibleSleep(ms) {
    let remain = ms;
    while (auto.running && remain > 0) {
      if (document.hidden) { await sleep(500); continue; }
      const chunk = Math.min(400, remain);
      await sleep(chunk);
      remain -= chunk;
    }
  }

  // A person skims as they dwell — occasionally scroll the description or the list a little.
  function maybeFidget() {
    if (Math.random() < 0.5) return;
    try {
      const pane = firstEl(DESC_SELECTORS);
      const by = 80 + Math.random() * 260;
      if (pane && Math.random() < 0.6) pane.scrollBy({ top: by, behavior: 'smooth' });
      else window.scrollBy({ top: by * (Math.random() < 0.5 ? 1 : -1), behavior: 'smooth' });
    } catch (_) {}
  }

  async function startAuto() {
    if (auto.running || auto.starting) return;
    if (busy) { console.warn('[Copy+Next] auto refused: an action is in progress'); toast('⏳ Finish the current action first'); return; }
    if (isBlockedPage()) { console.warn('[Copy+Next] auto refused: verification/checkpoint page'); toast('⚠️ Not on a normal jobs page — auto-run refused', true); return; }
    if (!getCards().length) { console.warn('[Copy+Next] auto refused: no job cards found'); toast('⚠️ No job list detected — open a Jobs search first', true); return; }
    // chrome.storage is async: without this the FIRST run of a session would skip
    // nothing, because the already-saved list hadn't arrived yet.
    auto.starting = true;
    try {
      if (!seenLoaded) { toast('… loading your already-saved list'); await seenReady; }
    } finally { auto.starting = false; }
    if (auto.running) return;
    auto.running = true; auto.count = 0; auto.saved = 0; auto.misses = 0; auto.peeked = 0; auto.skips = {};
    setAutoBtn(true);
    console.info('[Copy+Next] auto-run started;', seen.size, 'jobs already saved');
    toast(`▶ Auto-run started (${seen.size} already saved) — Stop with the button, Esc, or Alt+A`);
    runAutoLoop();
  }

  function stopAuto(silent) {
    const was = auto.running;
    auto.running = false;
    setAutoBtn(false);
    if (was && !silent) toast(`⏹ Auto-run stopped — ${auto.saved} saved, ${skipTotal()} skipped`);
  }

  function toggleAuto() { if (auto.running) stopAuto(); else startAuto(); }

  async function runAutoLoop() {
    const B = (globalThis.__liHumanize && globalThis.__liHumanize.CONFIG.BATCH) || { MAX_JOBS: 40, MAX_SESSION_MS: 900000 };
    const started = Date.now();
    let expectedId = getCurrentJobId(); // the job currently open (already loaded)
    // When the scan lands on a "peek", the NEXT iteration opens that job but must not
    // save it — it's a card we deliberately decided wasn't for us.
    let peekReason = null;
    await interruptibleSleep(1500 + Math.random() * 2500); // orientation pause on landing
    try {
      while (auto.running) {
        if (auto.count >= B.MAX_JOBS) { toast(`⏹ Auto-run: job cap reached (${B.MAX_JOBS})`); break; }
        if (Date.now() - started > B.MAX_SESSION_MS) { toast('⏹ Auto-run: time cap reached'); break; }
        if (isBlockedPage()) { toast('⏹ Auto-run: stopped at a verification/checkpoint page', true); break; }
        await waitWhileHidden(); if (!auto.running) break;

        // Gate on readiness so we never read a stale (previous) description after an advance.
        const ready = await waitForJobReady(expectedId);
        if (!auto.running) break;
        if (!ready) {
          if (++auto.misses >= 3) { toast('⏹ Auto-run: job never finished loading (3×) — stopping', true); break; }
          await interruptibleSleep(2000 + Math.random() * 4000); // wait, don't tight-retry
          continue;
        }

        let gapMs;
        const openId = getCurrentJobId();
        if (!peekReason && openId && seen.has(String(openId))) {
          // The job already open when the run STARTED never went through the scan, so
          // triage it here too — otherwise the first job of every run gets re-saved.
          auto.skips.seen = (auto.skips.seen || 0) + 1;
          auto.misses = 0;
          auto.count++; // counts against MAX_JOBS: this branch still navigates
          markSaved(openId);
          toast('↷ already saved — moving on');
          gapMs = humanizer.glanceMs ? humanizer.glanceMs().ms : 700;
        } else if (peekReason) {
          // A peek: open it, skim it, move on. Nothing is saved and nothing enters the
          // seen list — we didn't write it, so a later run is free to reconsider it.
          const j = collectJob();
          const d = humanizer.peekDwellMs ? humanizer.peekDwellMs({ wordCount: j ? j.wordCount : 0 }).ms : 3000;
          auto.peeked++;
          auto.misses = 0;
          auto.count++; // counts against MAX_JOBS: a peek is a real page load
          toast(`👀 skimming a ${peekReason === 'promoted-peek' ? 'promoted' : 'off-target'} post — not saving`);
          gapMs = d;
        } else {
          const r = await copyAndSaveCurrent();
          if (!r) {
            if (++auto.misses >= 3) { toast('⏹ Auto-run: no job description (3×) — stopping', true); break; }
            await interruptibleSleep(3000 + Math.random() * 5000);
            continue;
          }
          auto.misses = 0; auto.count++; if (r.copied) auto.saved++;
          const gap = humanizer.batchGapMs ? humanizer.batchGapMs({ wordCount: r.wordCount }) : { ms: 8000, idle: 0 };
          gapMs = gap.ms;
          toast(`▶ ${auto.saved} saved · next in ${Math.round(gap.ms / 1000)}s${gap.idle ? ' (taking a break)' : ''} · Esc to stop`);
        }

        maybeFidget();
        await interruptibleSleep(gapMs); if (!auto.running) break;

        const res = await advanceOnce(false, humanizer.nextModality ? humanizer.nextModality() : 'click');
        tallySkips(res.skipped);
        if (!res.ok) {
          if (res.reason === 'stopped') break;
          toast(res.reason === 'end-of-page'
            ? `⏹ Auto-run done — end of page · ${auto.saved} saved, ${skipTotal()} skipped`
            : `⏹ Auto-run: can't advance (${res.reason}) — ${auto.saved} saved`);
          break;
        }
        peekReason = res.action === 'peek' ? res.reason : null;
        expectedId = res.id; // next loop waits until THIS job is the one actually loaded
      }
    } catch (e) {
      toast('⏹ Auto-run error: ' + (e && e.message ? e.message : e), true);
    } finally {
      // A page where EVERYTHING was filtered out looks identical to a broken run, so
      // say which filter ate it and how to turn that filter off.
      // Keyed on SAVED, not on count — count now includes peeks and already-saved jobs,
      // so a page that produced no new .md would otherwise stop explaining itself.
      if (!auto.saved && skipTotal()) {
        console.info('[Copy+Next] auto-run skipped everything:', JSON.stringify(auto.skips));
        toast(`⏹ Nothing new here — skipped ${skipSummary()}. Loosen SKIP in targeting.js or clear the saved list.`, true);
      } else if (skipTotal()) {
        console.info(`[Copy+Next] auto-run: ${auto.saved} saved, ${auto.peeked} peeked, skipped ${JSON.stringify(auto.skips)}`);
      }
      stopAuto(true);
    }
  }

  // ===== UI: floating buttons + toast ===================================
  let copyBtn = null;
  let autoBtn = null;
  function injectUI() {
    if (document.getElementById('li-cn-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'li-cn-panel';

    // One button per recency window — each click is one input -> one navigation.
    const mkSearchBtn = (id, recency, shortcut) => {
      const b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.className = 'li-cn-btn li-cn-btn--secondary';
      b.textContent = `🔎 ${SEARCH.label} · ${recency.label}`;
      b.title = `Open a LinkedIn Jobs search for this saved query, posted in the past ${recency.label}  (${shortcut.label})`;
      b.addEventListener('click', (e) => { e.preventDefault(); handleSearch(recency); });
      return b;
    };
    const searchBtn = mkSearchBtn('li-cn-search', RECENCY.day, SHORTCUTS.searchDay);
    const searchWeekBtn = mkSearchBtn('li-cn-search-week', RECENCY.week, SHORTCUTS.searchWeek);

    copyBtn = document.createElement('button');
    copyBtn.id = 'li-cn-btn';
    copyBtn.type = 'button';
    copyBtn.className = 'li-cn-btn li-cn-btn--primary';
    copyBtn.dataset.label = '📋 Copy + Next';
    copyBtn.textContent = copyBtn.dataset.label;
    copyBtn.title = `Copy this job's description and go to the next job  (${SHORTCUTS.copyNext.label})`;
    copyBtn.addEventListener('click', (e) => { e.preventDefault(); handleCopyAndNext(); });

    autoBtn = document.createElement('button');
    autoBtn.id = 'li-cn-auto';
    autoBtn.type = 'button';
    autoBtn.className = 'li-cn-btn li-cn-btn--auto';
    autoBtn.dataset.label = '▶ Auto page';
    autoBtn.dataset.title = `Auto-save every job on THIS page as .md, human-paced. Stop anytime (${SHORTCUTS.auto.label} / Esc)`;
    autoBtn.textContent = autoBtn.dataset.label;
    autoBtn.title = autoBtn.dataset.title;
    autoBtn.addEventListener('click', (e) => { e.preventDefault(); toggleAuto(); });

    panel.appendChild(searchBtn);
    panel.appendChild(searchWeekBtn);
    panel.appendChild(copyBtn);
    panel.appendChild(autoBtn);
    document.body.appendChild(panel);
  }

  function setCopyBtnBusy(isBusy) {
    if (!copyBtn) return;
    copyBtn.disabled = isBusy;
    copyBtn.textContent = isBusy ? '⏳ advancing…' : copyBtn.dataset.label;
  }

  // Reflect auto-run state on the button, and lock the other controls while it runs.
  function setAutoBtn(running) {
    if (autoBtn) {
      autoBtn.classList.toggle('li-cn-btn--running', running);
      autoBtn.textContent = running ? '⏹ Stop' : autoBtn.dataset.label;
      autoBtn.title = running ? 'Stop the auto-run (or press Esc / Alt+A)' : autoBtn.dataset.title;
    }
    if (copyBtn) copyBtn.disabled = running;
    for (const id of ['li-cn-search', 'li-cn-search-week']) {
      const s = document.getElementById(id);
      if (s) s.disabled = running;
    }
  }

  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.getElementById('li-cn-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'li-cn-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('li-cn-toast--error', !!isError);
    el.classList.add('li-cn-toast--show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('li-cn-toast--show'), 2400);
  }

  function matches(e, sc) {
    return (
      e.altKey === sc.alt && e.ctrlKey === sc.ctrl && e.shiftKey === sc.shift &&
      e.metaKey === sc.meta && e.code === sc.code
    );
  }

  document.addEventListener(
    'keydown',
    (e) => {
      // Esc always stops an auto-run — even while focused in a field — so there's always
      // an instant kill switch.
      if (e.code === 'Escape' && auto.running) { stopAuto(); return; }
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return; // never hijack a shortcut while you're typing in a field
      if (matches(e, SHORTCUTS.copyNext)) { e.preventDefault(); e.stopPropagation(); handleCopyAndNext(); }
      // matches() compares every modifier exactly, so Alt+G and Alt+Shift+G never collide.
      else if (matches(e, SHORTCUTS.searchDay)) { e.preventDefault(); e.stopPropagation(); handleSearch(RECENCY.day); }
      else if (matches(e, SHORTCUTS.searchWeek)) { e.preventDefault(); e.stopPropagation(); handleSearch(RECENCY.week); }
      else if (matches(e, SHORTCUTS.auto)) { e.preventDefault(); e.stopPropagation(); toggleAuto(); }
    },
    true
  );

  if (document.body) injectUI();
  else document.addEventListener('DOMContentLoaded', injectUI);

  // Exposed for manual debugging in the extension's console context.
  window.__liCopyNext = {
    handleCopyAndNext,
    handleSearch,
    buildSearchUrl,
    SEARCH,
    RECENCY,
    searchUrls: () => ({ day: buildSearchUrl(RECENCY.day), week: buildSearchUrl(RECENCY.week) }),
    buildClipboardText,
    collectJob,
    saveJobAsMarkdown,
    jobMd: () => { const j = collectJob(); return j && globalThis.__liJobMd ? globalThis.__liJobMd.formatJobMarkdown(j) : null; },
    startAuto,
    stopAuto,
    toggleAuto,
    isAutoRunning: () => auto.running,
    getDescription,
    getCards: () => getCards().map((c) => ({ id: c.id })),
    getCurrentJobId,
    actor: humanizer.actor,
    // --- targeting / triage -------------------------------------------------
    targeting: TGT,
    // Classify every card on the page exactly as the auto-run would. The one call to
    // make in the console after a LinkedIn markup change: if `promoted` and `viewed`
    // come back all-false on a page that visibly has them, the selectors have drifted.
    probeCards: () =>
      getCards().map((c) => {
        const card = readCard(c.el);
        return { ...card, decision: TGT.decideCard(card, { seen, profile: SEARCH, rand: Math.random }) };
      }),
    seen: {
      size: () => seen.size,
      has: (id) => seen.has(String(id)),
      list: () => Array.from(seen),
      clear: forgetSeen,
      loaded: () => seenLoaded,
    },
    version: '1.5.0',
  };
})();
