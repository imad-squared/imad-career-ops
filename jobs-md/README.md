# jobs-md

Each job you copy with **Copy + Next** (`Alt + C` or the 📋 button) is also saved here as a
structured Markdown file:

```
# [Exact Job Title]
**Company:** [Company Name]
**Location:** [City, Country or Remote]
**URL:** [Link to the posting]

### Role Summary
…

### Key Responsibilities
- …

### Requirements & Qualifications
- …
```

## Where the files actually go

A browser extension can only write to your **Downloads** folder, so the extension saves to
**`Downloads/jobs-md/<slug>-<jobId>.md`** — not directly into this repo folder. Copy or move
them here (or anywhere) as you like. Files are named `{slug}-{jobId}.md` and re-copying the same
job **overwrites** its file rather than creating duplicates.

The section split (Role Summary / Key Responsibilities / Requirements) is a **heuristic** parse of
the posting's own headings and bullet lists; boilerplate tails (benefits, EEO, how-to-apply) are
dropped from the clean card. The full untouched text is still what lands on your clipboard.

> Committed job files are git-ignored (see `.gitignore`) so your personal job pipeline never gets
> pushed. Only this README is tracked.
