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

  async function goToNextJob() {
    let cards = getCards();
    if (!cards.length) return { ok: false, reason: 'no-cards' };
    const idx = findCurrentIndex(cards);
    if (idx === -1) return { ok: false, reason: 'current-not-found' };

    const nextIdx = idx + 1;
    if (nextIdx >= cards.length) {
      cards[cards.length - 1].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(700);
      cards = getCards();
    }
    if (nextIdx < cards.length) {
      const target = cards[nextIdx];
      target.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      (target.clickable || target.el).click();
      return { ok: true, id: target.id };
    }
    const nextPage = firstEl(NEXT_PAGE_SELECTORS);
    if (nextPage && !nextPage.disabled) {
      nextPage.click();
      return { ok: true, page: true };
    }
    return { ok: false, reason: 'end-of-list' };
  }

  function buildClipboardText() {
    const desc = getDescription();
    if (!desc) return null;
    const title = cleanInline(textFrom(TITLE_SELECTORS));
    const company = cleanInline(textFrom(COMPANY_SELECTORS));
    const location = cleanInline(textFrom(LOCATION_SELECTORS));
    const url = jobUrl();
    const headerLine = title && company ? `${title} — ${company}` : title || company || '';
    const header = [headerLine, location, url].filter(Boolean).join('\n');
    return { text: (header ? header + '\n\n' : '') + desc, wordCount: countWords(desc) };
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

  let busy = false;
  async function handleCopyAndNext() {
    // Invariant: one input -> one action. A new trigger is refused until the
    // previous action's full (human) timing budget has elapsed.
    if (busy) { toast('⏳ Still on the previous job…'); return; }
    busy = true;
    setCopyBtnBusy(true);
    try {
      const built = buildClipboardText();
      if (!built) { toast('⚠️ No job description found on the page', true); return; }

      const copied = await copyToClipboard(built.text); // clipboard is ready immediately

      // Technique 1 + 2 live here: the engine returns a human-paced, content-scaled,
      // autocorrelated delay to wait before advancing.
      const delay = humanizer.advanceDelayMs({
        wordCount: built.wordCount,
        optionCount: 2, // go / no-go on this job
        consequence: 'navigate',
      }).ms;

      if (!copied) { toast('⚠️ Copy failed', true); }
      else toast(`Copied ✓ · advancing in ${(delay / 1000).toFixed(1)}s`);

      await sleep(delay);

      const res = await goToNextJob();
      if (res.ok) toast(res.page ? '→ next page' : '→ next job');
      else toast('Copied ✓ (no next job to advance to)');
    } catch (e) {
      toast('⚠️ ' + (e && e.message ? e.message : e), true);
    } finally {
      busy = false;
      setCopyBtnBusy(false);
    }
  }

  // ===== UI: floating buttons + toast ===================================
  let copyBtn = null;
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

    panel.appendChild(searchBtn);
    panel.appendChild(copyBtn);
    document.body.appendChild(panel);
  }

  function setCopyBtnBusy(isBusy) {
    if (!copyBtn) return;
    copyBtn.disabled = isBusy;
    copyBtn.textContent = isBusy ? '⏳ advancing…' : copyBtn.dataset.label;
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
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return; // never hijack a shortcut while you're typing in a field
      if (matches(e, SHORTCUTS.copyNext)) { e.preventDefault(); e.stopPropagation(); handleCopyAndNext(); }
      else if (matches(e, SHORTCUTS.search)) { e.preventDefault(); e.stopPropagation(); handleSearch(); }
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
    getDescription,
    getCards: () => getCards().map((c) => ({ id: c.id })),
    getCurrentJobId,
    actor: humanizer.actor,
    version: '1.1.0',
  };
})();
