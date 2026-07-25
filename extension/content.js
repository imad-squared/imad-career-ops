/*
 * LinkedIn Jobs: Copy + Next  (content script / the "driver")
 * Runs on https://www.linkedin.com/jobs/*
 *
 * Actions (each is triggered by ONE of your inputs — one input -> one action):
 *   • Alt+C  or  📋 Copy + Next   — copy the current job (title, company, location,
 *                                   link, description) to the clipboard, then, after a
 *                                   human-paced delay, advance to the next job.
 *   • Alt+G  or  🔎 GTM · Remote · 24h — jump to a LinkedIn Jobs search pre-filtered to
 *                                   your saved query (default: GTM, Remote, past 24h).
 *
 * Human pacing (the delay before advancing) comes from humanize.js — a pure timing
 * engine that ports the two most load-bearing techniques from CLAUDE.md: autocorrelated
 * tempo (Technique 1) and content-scaled think-time (Technique 2). This file is only the
 * thin driver: it measures the DOM, asks the engine for a delay, sleeps, then acts.
 */
(() => {
  'use strict';
  if (window.__liCopyNextLoaded) return;
  window.__liCopyNextLoaded = true;

  // ===== Saved search (edit these to change what Alt+G opens) ===========
  const SEARCH = {
    keywords: 'GTM',
    workplaceType: 'remote', // 'remote' | 'onsite' | 'hybrid' | 'any'
    postedWithin: '24h', // '24h' | 'week' | 'month' | 'any'
    // LinkedIn defaults the location to your profile region (Pakistan) unless told
    // otherwise. Set location + geoId to override it. '' leaves LinkedIn's default.
    location: 'Worldwide',
    geoId: '92000000', // LinkedIn geoId: 92000000 = Worldwide
    sortByDate: true, // most recent first (good for a 24h window)
  };

  // ===== Keyboard shortcuts (matched on e.code, layout-independent) ======
  const SHORTCUTS = {
    copyNext: { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyC', label: 'Alt + C' },
    search: { alt: true, ctrl: false, shift: false, meta: false, code: 'KeyG', label: 'Alt + G' },
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

  // Advance to the next job. allowPaginate=false (auto-run scope = current page) stops at the
  // page boundary instead of clicking "next page". modality varies the input event stream.
  async function advanceOnce(allowPaginate = true, modality = 'click') {
    let cards = getCards();
    if (!cards.length) return { ok: false, reason: 'no-cards' };
    const idx = findCurrentIndex(cards);
    if (idx === -1) return { ok: false, reason: 'current-not-found' };

    const nextIdx = idx + 1;
    if (nextIdx >= cards.length) {
      cards[cards.length - 1].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(600 + Math.random() * 500);
      cards = getCards();
    }
    if (nextIdx < cards.length) {
      const target = cards[nextIdx];
      target.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(120 + Math.random() * 200); // settle micro-pause before activating
      activate(target.clickable || target.el, modality);
      return { ok: true, id: target.id };
    }
    if (!allowPaginate) return { ok: false, reason: 'end-of-page' };
    const nextPage = firstEl(NEXT_PAGE_SELECTORS);
    if (nextPage && !nextPage.disabled) {
      activate(nextPage, 'click');
      return { ok: true, page: true };
    }
    return { ok: false, reason: 'end-of-list' };
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
        if (resp && resp.ok) console.info('[Copy+Next] saved', resp.path);
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

  function buildSearchUrl() {
    const p = new URLSearchParams();
    p.set('keywords', SEARCH.keywords);
    const wt = { onsite: '1', remote: '2', hybrid: '3' }[SEARCH.workplaceType];
    if (wt) p.set('f_WT', wt);
    const tpr = { '24h': 'r86400', week: 'r604800', month: 'r2592000' }[SEARCH.postedWithin];
    if (tpr) p.set('f_TPR', tpr);
    if (SEARCH.location) p.set('location', SEARCH.location);
    if (SEARCH.geoId) p.set('geoId', SEARCH.geoId);
    if (SEARCH.sortByDate) p.set('sortBy', 'DD');
    return 'https://www.linkedin.com/jobs/search/?' + p.toString();
  }

  function handleSearch() {
    toast(`🔎 Searching: ${SEARCH.keywords} · ${SEARCH.workplaceType} · ${SEARCH.postedWithin}`);
    location.assign(buildSearchUrl());
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

  const auto = { running: false, count: 0, saved: 0, misses: 0 };
  let busy = false;

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
      if (!r.copied) toast('⚠️ Copy failed', true);
      else toast(`Copied ✓ · advancing in ${(delay / 1000).toFixed(1)}s`);

      await sleep(delay);

      const res = await advanceOnce(true, 'click');
      if (res.ok) toast(res.page ? '→ next page' : '→ next job');
      else toast('Copied ✓ (no next job to advance to)');
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

  function startAuto() {
    if (auto.running) return;
    if (busy) { console.warn('[Copy+Next] auto refused: an action is in progress'); toast('⏳ Finish the current action first'); return; }
    if (isBlockedPage()) { console.warn('[Copy+Next] auto refused: verification/checkpoint page'); toast('⚠️ Not on a normal jobs page — auto-run refused', true); return; }
    if (!getCards().length) { console.warn('[Copy+Next] auto refused: no job cards found'); toast('⚠️ No job list detected — open a Jobs search first', true); return; }
    auto.running = true; auto.count = 0; auto.saved = 0; auto.misses = 0;
    setAutoBtn(true);
    console.info('[Copy+Next] auto-run started');
    toast('▶ Auto-run started — Stop with the button, Esc, or Alt+A');
    runAutoLoop();
  }

  function stopAuto(silent) {
    const was = auto.running;
    auto.running = false;
    setAutoBtn(false);
    if (was && !silent) toast(`⏹ Auto-run stopped — ${auto.saved} saved this run`);
  }

  function toggleAuto() { if (auto.running) stopAuto(); else startAuto(); }

  async function runAutoLoop() {
    const B = (globalThis.__liHumanize && globalThis.__liHumanize.CONFIG.BATCH) || { MAX_JOBS: 40, MAX_SESSION_MS: 900000 };
    const started = Date.now();
    let expectedId = getCurrentJobId(); // the job currently open (already loaded)
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

        const r = await copyAndSaveCurrent();
        if (!r) {
          if (++auto.misses >= 3) { toast('⏹ Auto-run: no job description (3×) — stopping', true); break; }
          await interruptibleSleep(3000 + Math.random() * 5000);
          continue;
        }
        auto.misses = 0; auto.count++; if (r.copied) auto.saved++;

        const gap = humanizer.batchGapMs ? humanizer.batchGapMs({ wordCount: r.wordCount }) : { ms: 8000, idle: 0 };
        toast(`▶ ${auto.saved} saved · next in ${Math.round(gap.ms / 1000)}s${gap.idle ? ' (taking a break)' : ''} · Esc to stop`);
        maybeFidget();
        await interruptibleSleep(gap.ms); if (!auto.running) break;

        const res = await advanceOnce(false, humanizer.nextModality ? humanizer.nextModality() : 'click');
        if (!res.ok) {
          toast(res.reason === 'end-of-page'
            ? `⏹ Auto-run done — reached end of page (${auto.saved} saved)`
            : `⏹ Auto-run: can't advance (${res.reason}) — ${auto.saved} saved`);
          break;
        }
        expectedId = res.id; // next loop waits until THIS job is the one actually loaded
      }
    } catch (e) {
      toast('⏹ Auto-run error: ' + (e && e.message ? e.message : e), true);
    } finally {
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

    const searchBtn = document.createElement('button');
    searchBtn.id = 'li-cn-search';
    searchBtn.type = 'button';
    searchBtn.className = 'li-cn-btn li-cn-btn--secondary';
    searchBtn.textContent = `🔎 ${SEARCH.keywords} · ${SEARCH.workplaceType} · ${SEARCH.postedWithin}`;
    searchBtn.title = `Open a LinkedIn Jobs search for this saved query  (${SHORTCUTS.search.label})`;
    searchBtn.addEventListener('click', (e) => { e.preventDefault(); handleSearch(); });

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
    const s = document.getElementById('li-cn-search');
    if (s) s.disabled = running;
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
      else if (matches(e, SHORTCUTS.search)) { e.preventDefault(); e.stopPropagation(); handleSearch(); }
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
    version: '1.3.0',
  };
})();
