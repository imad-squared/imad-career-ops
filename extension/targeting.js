/*
 * targeting.js — pure targeting & card-triage module (NO DOM, NO chrome.*).
 *
 * Third pure module in the same pattern as humanize.js / jobmd.js: it assigns
 * globalThis.__liTargeting so the content script uses it AND a Node test can
 * eval-load the file with no browser.
 *
 * Division of labour, kept strict:
 *   • targeting.js decides WHAT to do with a card (open / peek / skip, and why)
 *     and WHICH search URL to open.
 *   • humanize.js decides HOW LONG each of those takes.
 *   • content.js only measures the DOM and executes. It invents no delays and
 *     makes no targeting decisions of its own.
 *
 * Two accuracy layers, deliberately split (this is the crux of "targeted"):
 *   1. SERVER-SIDE recall — a boolean-OR keyword query. LinkedIn matches the
 *      posted title verbatim AND does its own undocumented semantic expansion,
 *      but it also searches the DESCRIPTION, so a keyword query alone always
 *      leaks off-target postings (a job that merely *mentions* "revenue
 *      operations" matches). Broad here is fine — recall is the job.
 *   2. CLIENT-SIDE precision — `relevanceOf()` re-checks the card TITLE against
 *      an include/exclude pair. Precise, visible, and reversible: nothing is
 *      hidden, cards are only dimmed and skipped, and every skip carries a
 *      reason. Doing exclusion here rather than with a boolean NOT in the query
 *      matters — a server-side NOT also matches description text and would
 *      silently drop good jobs.
 */
(() => {
  'use strict';

  // ===== Which saved search Alt+G / Alt+Shift+G open ====================
  // Switch targets by changing ACTIVE below — profiles are otherwise independent.
  const ACTIVE = 'gtm';

  // The two recency windows. LinkedIn's f_TPR is "posted within the last N
  // seconds", so r86400 = 24h and r604800 = 7 days.
  const RECENCY = {
    day: { key: '24h', tpr: 'r86400', label: '24h' },
    week: { key: 'week', tpr: 'r604800', label: 'Week' },
  };

  const PROFILES = {
    // ---- Go-to-market roles ------------------------------------------------
    gtm: {
      key: 'gtm',
      label: 'GTM',
      // Quoted phrases so each stays intact; unquoted, "GTM Manager" also matches
      // any manager posting that merely mentions GTM. Same reasoning as the HSE
      // profile: LinkedIn's semantic expansion is undocumented and can change, so
      // the explicit list is the guarantee, not an optimisation.
      keywords:
        '("Go-to-Market Manager" OR "Go To Market Manager" OR "Go-to-Market Lead" OR "Head of Go-to-Market" OR "GTM Manager" OR "GTM Lead" OR "GTM Strategy" OR "Revenue Operations Manager" OR "RevOps" OR "Head of Growth" OR "Growth Marketing Manager" OR "Product Marketing Manager" OR "Demand Generation Manager" OR "Sales Enablement Manager")',
      workplaceType: 'any', // 'remote' | 'onsite' | 'hybrid' | 'any' — 'any' omits f_WT
      // Worldwide, deliberately. Leaving the geo UNSET is not neutral: LinkedIn then
      // reuses a sticky/profile location, so the same query silently returns a
      // different country depending on what you searched last (measured — an unset
      // GTM search came back all-Saudi right after the HSE searches). Pinning
      // Worldwide makes the query deterministic without inventing a country
      // preference; GTM roles are also the kind that are frequently remote.
      //
      // Every id below was read back from LinkedIn's OWN location typeahead, never
      // guessed (the README's recipe). To pin a country, swap BOTH fields:
      //   Worldwide 92000000 · Pakistan 101022442 · Saudi Arabia 100459316
      location: 'Worldwide',
      geoId: '92000000',
      sortByDate: true, // newest first — what makes a 24h window useful
      relevance: {
        // 'skip' = dim + step over off-target cards; 'off' = keep every result.
        mode: 'skip',
        // Title must look like a go-to-market role…
        include:
          /\b(go[\s-]?to[\s-]?market|gtm|revenue operations|rev[\s-]?ops|product marketing|growth marketing|demand gen(eration)?|sales enablement|head of growth|growth (lead|manager|director)|partnerships? (manager|lead|director|head)|revenue (marketing|enablement|lead))\b/i,
        // …and must not be one of the recurring false positives. "GTM" is also the
        // abbreviation for GOOGLE TAG MANAGER, which is the single biggest source of
        // junk in this search; the rest are frontline-quota sales titles that a
        // keyword match on "growth"/"revenue" drags in.
        exclude:
          /\b(google tag manager|tag manager|ga4|adwords|sales development representative|sdr|business development (executive|representative)|bde|telesales|tele[\s-]?caller|field sales|door[\s-]?to[\s-]?door|commission[\s-]?only|insurance advisor|real estate|relationship manager)\b/i,
      },
    },

    // ---- Health & safety roles in Saudi Arabia (the previous default) -------
    // Kept byte-for-byte so switching ACTIVE back to 'hse' restores the exact
    // search that shipped in v1.4. Its relevance filter is OFF by default, so the
    // result set is unchanged; flip mode to 'skip' to try the title filter.
    hse: {
      key: 'hse',
      label: 'HSE · KSA',
      keywords:
        '("HSE Manager" OR "EHS Manager" OR "HSE Lead" OR "EHS Lead" OR "Health and Safety Manager" OR "Health & Safety Manager" OR "Safety Manager" OR "HSE Supervisor")',
      workplaceType: 'any',
      location: 'Saudi Arabia',
      geoId: '100459316', // resolved live from LinkedIn's typeahead — see README
      sortByDate: true,
      relevance: {
        mode: 'off',
        include:
          /\b(hse|ehs|hseq|qhse|sheq|health\s*(and|&)\s*safety|safety|occupational health|loss prevention|process safety)\b/i,
        exclude:
          /\b(cyber ?security|information security|infosec|network security|security (guard|officer)|patient safety)\b/i,
      },
    },
  };

  // ===== Triage priors ==================================================
  // Every number is a PRIOR (CLAUDE.md "Calibration"). The peek probabilities are
  // the load-bearing ones: a filter that rejects 100% of promoted cards, forever,
  // is itself a machine signature. Real people click a sponsored post now and
  // then, and occasionally open something that looked off-target. A peek opens the
  // job and dwells on it but never saves it and never enters the seen list.
  const SKIP = {
    promoted: true, // step over "Promoted" (sponsored) cards
    seen: true, // step over jobs this tool has already written to disk
    viewed: true, // step over jobs LinkedIn itself marks "Viewed"
    offTarget: true, // step over titles the profile's relevance filter rejects
    PROMOTED_PEEK_PROB: 0.08, // prior: curiosity rate on a sponsored card
    OFFTARGET_PEEK_PROB: 0.04, // prior: "hmm, let me just check" rate
    SEEN_MAX: 2000, // prior: cap on remembered job ids (oldest pruned first)
  };

  const REASONS = {
    ELIGIBLE: 'eligible',
    UNKNOWN: 'unknown',
    PROMOTED: 'promoted',
    SEEN: 'seen',
    VIEWED: 'viewed',
    OFF_TARGET: 'off-target',
    PROMOTED_PEEK: 'promoted-peek',
    OFF_TARGET_PEEK: 'off-target-peek',
  };

  // Human-readable one-liners for the toast / the badge on a dimmed card.
  const REASON_LABEL = {
    [REASONS.PROMOTED]: 'Promoted',
    [REASONS.SEEN]: 'Already saved',
    [REASONS.VIEWED]: 'Viewed',
    [REASONS.OFF_TARGET]: 'Off-target',
    [REASONS.PROMOTED_PEEK]: 'Promoted (peek)',
    [REASONS.OFF_TARGET_PEEK]: 'Off-target (peek)',
  };

  const getProfile = (key) => PROFILES[key] || PROFILES[ACTIVE];
  const activeProfile = () => getProfile(ACTIVE);

  // ===== Layer 1: the search URL ========================================
  function buildSearchUrl(profile, recency) {
    const p = profile || activeProfile();
    const r = recency || RECENCY.day;
    const q = new URLSearchParams();
    q.set('keywords', p.keywords);
    const wt = { onsite: '1', remote: '2', hybrid: '3' }[p.workplaceType];
    if (wt) q.set('f_WT', wt); // 'any' -> omitted, so every workplace type comes back
    if (r.tpr) q.set('f_TPR', r.tpr);
    // geoId is the filter LinkedIn actually honors; the location text drives the UI.
    if (p.location) q.set('location', p.location);
    if (p.geoId) q.set('geoId', p.geoId);
    if (p.sortByDate) q.set('sortBy', 'DD');
    return 'https://www.linkedin.com/jobs/search/?' + q.toString();
  }

  // ===== Layer 2: title relevance =======================================
  // Fails OPEN on anything it cannot judge (no title, no configured filter): the
  // cost of opening one extra job is trivial, the cost of silently skipping a whole
  // page is not.
  function relevanceOf(title, profile) {
    const p = profile || activeProfile();
    const rel = p.relevance;
    if (!rel || rel.mode !== 'skip') return { ok: true, reason: 'relevance-off' };
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) return { ok: true, reason: 'no-title' };
    if (rel.exclude && rel.exclude.test(t)) return { ok: false, reason: 'excluded' };
    if (rel.include && !rel.include.test(t)) return { ok: false, reason: 'not-included' };
    return { ok: true, reason: 'included' };
  }

  /**
   * The single triage decision for one job card.
   *
   * @param {{id?:string, title?:string, promoted?:boolean, viewed?:boolean, unknown?:boolean}} card
   *        `unknown: true` means the card had not rendered yet (LinkedIn's list is
   *        virtualized, so an off-screen <li> carries its id but no text).
   * @param {{seen?:{has:Function}, profile?:object, skip?:object, rand?:Function}} ctx
   *        `rand` is threaded in (never global Math.random) so the peek decisions
   *        are reproducible under a seed, per CLAUDE.md.
   * @returns {{action:'open'|'peek'|'skip', reason:string}}
   */
  function decideCard(card, ctx) {
    const c = card || {};
    const o = ctx || {};
    const profile = o.profile || activeProfile();
    const skip = o.skip || SKIP;
    const rand = typeof o.rand === 'function' ? o.rand : Math.random;
    const seen = o.seen;

    // Unrendered card: we genuinely don't know what it is. Open it rather than
    // guess — see the fail-open note above.
    if (c.unknown) return { action: 'open', reason: REASONS.UNKNOWN };

    // Already on disk — checked FIRST and never peeked: re-opening a job we've
    // already written has no upside.
    if (skip.seen && seen && c.id && seen.has(String(c.id))) {
      return { action: 'skip', reason: REASONS.SEEN };
    }
    if (skip.promoted && c.promoted) {
      return rand() < skip.PROMOTED_PEEK_PROB
        ? { action: 'peek', reason: REASONS.PROMOTED_PEEK }
        : { action: 'skip', reason: REASONS.PROMOTED };
    }
    if (skip.viewed && c.viewed) return { action: 'skip', reason: REASONS.VIEWED };
    if (skip.offTarget && !relevanceOf(c.title, profile).ok) {
      return rand() < skip.OFFTARGET_PEEK_PROB
        ? { action: 'peek', reason: REASONS.OFF_TARGET_PEEK }
        : { action: 'skip', reason: REASONS.OFF_TARGET };
    }
    return { action: 'open', reason: REASONS.ELIGIBLE };
  }

  // ===== Seen-set housekeeping (pure; the driver owns chrome.storage) ====
  // Shape: { [jobId]: { at: epochMs, title, company } }. Pruned oldest-first so a
  // long-running install can't grow the stored object without bound.
  function pruneSeen(map, max) {
    const limit = max || SKIP.SEEN_MAX;
    const entries = Object.entries(map || {});
    if (entries.length <= limit) return map || {};
    entries.sort((a, b) => (b[1] && b[1].at ? b[1].at : 0) - (a[1] && a[1].at ? a[1].at : 0));
    const out = {};
    for (const [k, v] of entries.slice(0, limit)) out[k] = v;
    return out;
  }

  const api = {
    ACTIVE, PROFILES, RECENCY, SKIP, REASONS, REASON_LABEL,
    getProfile, activeProfile, buildSearchUrl, relevanceOf, decideCard, pruneSeen,
  };
  if (typeof globalThis !== 'undefined') globalThis.__liTargeting = api;
})();
