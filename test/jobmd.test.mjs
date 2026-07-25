/*
 * Unit test for the pure job->Markdown formatter (extension/jobmd.js) — NO browser.
 * Loads the browser-global module by eval (same trick as engine.test.mjs) and feeds
 * realistic + deliberately messy postings through the SAME classifier the extension
 * runs live, asserting the exact template and section routing.
 *
 * Run: node test/jobmd.test.mjs
 */
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../extension/jobmd.js', import.meta.url), 'utf8');
(0, eval)(code);
const M = globalThis.__liJobMd;

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// Extract one template section's body (boundary-safe — does NOT bleed into the next ###).
function section(md, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = md.match(new RegExp('### ' + esc + '\\n([\\s\\S]*?)(?=\\n### |$)'));
  return m ? m[1].trim() : '';
}

// ---------- 1. Well-structured posting ----------
const structured = M.formatJobMarkdown({
  title: 'Senior GTM Manager (Remote)',
  company: 'Acme Cloud',
  location: 'United States (Remote)',
  url: 'https://www.linkedin.com/jobs/view/4455/',
  description: `About the job
Acme Cloud is hiring a GTM Manager to lead our go-to-market motion across North America.
You will own pipeline strategy and partner with sales.

Responsibilities:
- Build and execute the GTM strategy
- Partner with Sales and Marketing leadership
- Own quarterly pipeline targets

Requirements:
- 5+ years in B2B SaaS GTM
- Strong analytical skills
- Excellent written English`,
});

check('template: title is an H1', structured.startsWith('# Senior GTM Manager (Remote)\n'));
check('template: Company line exact', structured.includes('\n**Company:** Acme Cloud\n'));
check('template: Location line exact', structured.includes('\n**Location:** United States (Remote)\n'));
check('template: URL line exact', structured.includes('\n**URL:** https://www.linkedin.com/jobs/view/4455/\n\n'));
check('template: has all three section headers',
  structured.includes('### Role Summary') &&
  structured.includes('### Key Responsibilities') &&
  structured.includes('### Requirements & Qualifications'));
check('summary captured the About paragraph', /go-to-market motion/.test(section(structured, 'Role Summary')));
check('responsibilities routed correctly (and requirements did NOT leak in)',
  /- Build and execute the GTM strategy/.test(section(structured, 'Key Responsibilities')) &&
  /- Own quarterly pipeline targets/.test(section(structured, 'Key Responsibilities')) &&
  !/5\+ years/.test(section(structured, 'Key Responsibilities')));
check('requirements routed correctly',
  /- 5\+ years in B2B SaaS GTM/.test(section(structured, 'Requirements & Qualifications')) &&
  /- Excellent written English/.test(section(structured, 'Requirements & Qualifications')));

// ---------- 2. Alternate phrasing (no literal "Responsibilities"/"Requirements") ----------
const altPhrasing = M.formatJobMarkdown({
  title: 'Product Designer',
  company: 'Beta Labs',
  location: 'Berlin, Germany',
  url: 'https://x/1',
  description: `The opportunity:
Join a small team shaping our design system.

What you'll do:
- Design end-to-end flows
- Run usability tests

What we're looking for:
- 3+ years product design
- Figma expertise`,
});
check('alt: "What you\'ll do" -> Key Responsibilities',
  section(altPhrasing, 'Key Responsibilities') === '- Design end-to-end flows\n- Run usability tests');
check('alt: "What we\'re looking for" -> Requirements',
  section(altPhrasing, 'Requirements & Qualifications') === '- 3+ years product design\n- Figma expertise');
check('alt: "The opportunity" -> Role Summary', /design system/.test(section(altPhrasing, 'Role Summary')));

// ---------- 3. Messy, header-less posting (prose + loose bullets) ----------
const messy = M.formatJobMarkdown({
  title: 'Growth Marketer',
  company: 'Gamma',
  location: 'Remote',
  url: 'https://x/2',
  description: `We are a fast-growing startup looking for a hands-on growth marketer.
- Run paid acquisition experiments
- Manage the content calendar`,
});
check('messy: prose becomes the Role Summary', /Role Summary\n[\s\S]*fast-growing startup/.test(messy));
check('messy: loose bullets fall into Key Responsibilities',
  /Key Responsibilities\n- Run paid acquisition experiments\n- Manage the content calendar/.test(messy));
check('messy: empty Requirements shows the note (not a crash/blank)',
  new RegExp('Requirements & Qualifications\\n' + M.NA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(messy));

// ---------- 4. Boilerplate tail is dropped from the clean card ----------
const withTail = M.formatJobMarkdown({
  title: 'Data Analyst',
  company: 'Delta',
  location: 'Remote',
  url: 'https://x/3',
  description: `Requirements:
- SQL and Python
- 2+ years analytics

Benefits:
- Unlimited PTO
- Stock options`,
});
check('tail: Benefits bullets are NOT in Requirements',
  /- SQL and Python/.test(withTail) && !/Unlimited PTO/.test(withTail) && !/Stock options/.test(withTail));

// ---------- 5. Filename slug ----------
check('filename: slug + jobId',
  M.buildFilename('Senior GTM Manager (Remote)', '4455306388') === 'senior-gtm-manager-remote-4455306388.md',
  M.buildFilename('Senior GTM Manager (Remote)', '4455306388'));
check('filename: falls back to company when no title',
  M.buildFilename('', '99', 'Acme Cloud') === 'acme-cloud-99.md',
  M.buildFilename('', '99', 'Acme Cloud'));
check('filename: no id still valid', M.buildFilename('Analyst', '') === 'analyst.md');

// ---------- 6. Never throws on empty / garbage input ----------
let robust = true;
try { M.formatJobMarkdown({}); M.formatJobMarkdown({ description: '' }); M.formatJobMarkdown({ title: 'x', description: '\n\n\n' }); }
catch (e) { robust = false; console.log('  threw:', String(e)); }
check('robust: empty/garbage input never throws', robust);

// ---------- 7. REAL LinkedIn innerText fixture (captured live via test/_probe.mjs) ----------
// Curly apostrophes, no bullet markers, LinkedIn's own section headers — the exact kind of
// text the extension passes at runtime. This is the case that the old DOM path got empty.
const realLinkedIn = `About the job

We’re scaling fast and looking for a part-time AI operator who can build high-volume, high-quality AI-generated video content for brands.

This is not a prompt-only role.

You need to ship production-ready assets daily.

What You’ll Be Responsible For:

Producing AI-generated video content (short-form, ads, cinematic, product visuals)
Building repeatable workflows using tools such as:
Runway, Pika, Sora (or equivalent), Midjourney, Stable Diffusion, ComfyUI, After Effects, Premiere
Creating AI product ads, UGC-style content, and social-first creatives
Turning briefs into finished videos within 24–48 hours

This Role Is For You If:

You already generate AI videos at scale
You understand commercial creative, not just “cool visuals”
You move fast and don’t need hand-holding

Requirements:

Proven portfolio of AI-generated video work
Strong understanding of short-form content performance
Basic motion graphics and sound design skills

Compensation:

Full-time role
Performance bonuses tied to volume and results

How to Apply:

Send your portfolio.`;
const real = M.formatJobMarkdown({ title: 'AI & Automations Associate', company: 'Alayd Agency', location: 'Remote', url: 'https://x/9', description: realLinkedIn });
const rSummary = section(real, 'Role Summary');
const rResp = section(real, 'Key Responsibilities');
const rReq = section(real, 'Requirements & Qualifications');
check('real: Role Summary populated (not the fallback note)', /scaling fast/.test(rSummary) && rSummary !== M.NA);
check('real: Key Responsibilities populated from "What You’ll Be Responsible For:"',
  /Producing AI-generated video content/.test(rResp) && /Turning briefs into finished videos/.test(rResp) && rResp !== M.NA);
check('real: bullet ending in a colon stays a bullet (not promoted to a header)',
  /- Building repeatable workflows using tools such as:/.test(rResp));
check('real: "…design skills" bullet not mistaken for a Skills header',
  /- Basic motion graphics and sound design skills/.test(rReq));
check('real: Requirements populated (incl. "This Role Is For You If")',
  /Proven portfolio of AI-generated video work/.test(rReq) && /You already generate AI videos at scale/.test(rReq));
check('real: Compensation/How-to-Apply boilerplate dropped',
  !/Full-time role/.test(real) && !/Send your portfolio/.test(real) && !/Performance bonuses/.test(real));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
