/*
 * jobmd.js — pure job-to-Markdown formatter. Mirrors humanize.js's pattern: assigns
 * globalThis.__liJobMd so the content script uses it AND a Node test loads it via eval.
 *
 * Pipeline (ONE path — the tested path IS the run path):
 *   description innerText --textToBlocks--> [{kind,text}] --classifySections--> sections
 *   sections + header fields --formatJobMarkdown--> Markdown (exact template)
 *
 * We parse the description's innerText, NOT the DOM: LinkedIn's #job-details markup is
 * non-semantic (no <ul><li>; content in divs/spans/<br>), so DOM structure is unreliable,
 * but innerText renders each list item / paragraph on its own line either way.
 *
 * Header detection (the crux): a line is a section header iff it matches a known section
 * keyword AND it either ends with ":" or is a bare known label ("About the job"). Keywords
 * pick the BUCKET; the colon/bare-label test decides HEADER-HOOD. This keeps real bullets
 * that merely contain a keyword ("...sound design skills") or merely end with a colon
 * ("Building workflows using tools such as:") as content, not headers.
 */
(() => {
  'use strict';

  // ===== Priors: section-header keyword maps (bucket assignment only) ====
  // Substring, case-insensitive. Safe to be generous because only lines that already pass
  // the colon/bare-label gate are ever classified as headers. Order in classifyHeading is
  // DROP -> REQ -> RESP -> SUMMARY (so "not for you if" drops before "for you if" -> req).
  const DROP_RE =
    /benefits?|perks?|compensation|salary|pay range|pay and benefits|what we offer|what you'?ll get|equal[- ]?(?:employment )?opportunit|eeo\b|accommodation|diversity|inclusion|how to apply|to apply|apply now|application process|hiring process|interview process|next steps|not for you if|about the company|our offer|why work (?:with|at|for)/i;
  const REQ_RE =
    /requirement|qualification|skills?|must[- ]?have|nice[- ]?to[- ]?have|about you|who you are|your (?:experience|background|profile)|what (?:we|we'?re|we are) (?:look|seek|want)|what you (?:bring|have|need)|you (?:have|bring|should|will need)|minimum|preferred|proficien|competenc|expertise|education|for you if|is this you|ideal (?:candidate|profile)|we'?d love/i;
  const RESP_RE =
    /responsibilit|what you'?ll (?:do|be)|what you will (?:do|be)|you'?ll be responsible|responsible for|duties|day[- ]to[- ]day|in this role|your (?:role|impact|day)|how you'?ll|you will\b|key deliverable|scope of|objectives?|what the (?:role|job)/i;
  const SUMMARY_RE =
    /about the (?:job|role|position)|about (?:us|the team|the company|our)|^about$|overview|role summary|^summary$|who we are|the opportunity|our (?:team|company|mission|story)|company description|introduction|the mission|why (?:join|us)|the role/i;

  // Known headers that appear WITHOUT a trailing colon (exact, normalized-lowercase).
  const BARE_LABELS = new Set([
    'about the job', 'about', 'about us', 'overview', 'summary', 'role summary',
    'responsibilities', 'key responsibilities', 'requirements', 'qualifications',
    'requirements and qualifications', 'benefits', 'perks', 'duties', 'skills', 'who we are',
  ]);

  const normalizeInline = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // Map a header line to a bucket, or null if no known keyword. (Called only on lines that
  // will be treated as headers, so substring matching can't hurt real bullets.)
  function classifyHeading(text) {
    // Normalize curly apostrophes -> straight so "What You’ll Do:" matches you'?ll etc.
    const t = normalizeInline(text).replace(/:$/, '').toLowerCase().replace(/[‘’]/g, "'");
    if (!t) return null;
    if (DROP_RE.test(t)) return 'drop';
    if (REQ_RE.test(t)) return 'requirements';
    if (RESP_RE.test(t)) return 'responsibilities';
    if (SUMMARY_RE.test(t)) return 'summary';
    return null;
  }

  // A line is a section header iff it names a known section AND looks like a header
  // (ends with ":" or is a bare known label) — never a mid-description sentence.
  function isHeadingText(text) {
    const t = normalizeInline(text);
    if (!t || t.length > 90) return false;
    if (!classifyHeading(t)) return false;
    const bare = t.replace(/:$/, '').trim().toLowerCase();
    return /:$/.test(t) || BARE_LABELS.has(bare);
  }

  // ===== innerText -> blocks: one block per non-empty line =============
  // LinkedIn puts each paragraph AND each list item on its own line, so a line is the
  // atomic unit. kind: 'heading' (section switch), 'bullet' (had a marker), else 'para'.
  const BULLET_RE = /^\s*(?:[•·▪◦‣∙*+]|[-–—]|\d+[.)]|[a-z][.)])\s+/i;
  function textToBlocks(text) {
    const out = [];
    const lines = (text || '').replace(/\r/g, '').split('\n');
    for (const raw of lines) {
      let line = raw.trim();
      if (!line) continue;
      const isBullet = BULLET_RE.test(line);
      if (isBullet) line = line.replace(BULLET_RE, '').trim();
      if (!line) continue;
      if (!isBullet && isHeadingText(line)) { out.push({ kind: 'heading', text: normalizeInline(line) }); continue; }
      out.push({ kind: isBullet ? 'bullet' : 'para', text: normalizeInline(line) });
    }
    return out;
  }

  // ===== classify blocks -> the three template sections =================
  function classifySections(blocks) {
    const summaryParas = [], summaryBullets = [], respItems = [], reqItems = [];
    let bucket = 'summary'; // text before the first recognized header is overview
    for (const b of blocks) {
      if (b.kind === 'heading') {
        const c = classifyHeading(b.text);
        if (c) bucket = c; // summary | responsibilities | requirements | drop
        continue;          // header text itself is not emitted
      }
      if (bucket === 'drop') continue;
      if (bucket === 'responsibilities') respItems.push(b.text);
      else if (bucket === 'requirements') reqItems.push(b.text);
      else if (b.kind === 'bullet') summaryBullets.push(b.text);
      else summaryParas.push(b.text);
    }
    // Fallbacks so no card comes out empty when a posting isn't cleanly sectioned:
    let responsibilities = respItems;
    if (!responsibilities.length && summaryBullets.length) responsibilities = summaryBullets.slice();
    let summary = summaryParas.slice();
    if (!summary.length && summaryBullets.length && responsibilities !== summaryBullets) summary = summaryBullets.slice();
    return { summary, responsibilities, requirements: reqItems };
  }

  // ===== render exact template ==========================================
  const NA = '_Not clearly delineated in this posting — see the clipboard copy for the full text._';
  function renderList(items) {
    const seen = new Set(), out = [];
    for (const it of items) {
      const t = normalizeInline(it);
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push('- ' + t);
    }
    return out.length ? out.join('\n') : NA;
  }

  function formatJobMarkdown(job) {
    const title = normalizeInline(job.title) || 'Untitled role';
    const company = normalizeInline(job.company) || '—';
    const location = normalizeInline(job.location) || '—';
    const url = normalizeInline(job.url) || '—';
    const blocks = job.blocks || textToBlocks(job.description || '');
    const sec = classifySections(blocks);
    const summary = sec.summary.length ? sec.summary.join('\n\n') : NA;
    return (
      `# ${title}\n` +
      `**Company:** ${company}\n` +
      `**Location:** ${location}\n` +
      `**URL:** ${url}\n\n` +
      `### Role Summary\n${summary}\n\n` +
      `### Key Responsibilities\n${renderList(sec.responsibilities)}\n\n` +
      `### Requirements & Qualifications\n${renderList(sec.requirements)}\n`
    );
  }

  // ===== filename: {slug}-{jobId}.md, idempotent per job ================
  function slugify(s) {
    return normalizeInline(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '');
  }
  function buildFilename(title, jobId, company) {
    const base = slugify(title) || slugify(company) || 'job';
    const id = jobId ? String(jobId).replace(/[^a-z0-9]/gi, '') : '';
    return (id ? `${base}-${id}` : base) + '.md';
  }

  const api = {
    formatJobMarkdown, classifySections, textToBlocks,
    isHeadingText, classifyHeading, slugify, buildFilename, NA,
  };
  if (typeof globalThis !== 'undefined') globalThis.__liJobMd = api;
})();
