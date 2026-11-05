---
name: research-brief
description: Research a question on the web and return a short brief with sources, not a wall of text.
when:
  - research
  - find out
  - look up
  - latest
  - compare
  - sources
  - cite
  - news about
  - what is the current
tags: [research, web, search, brief]
tools: [web_search, read_url, notch_show]
version: 1.0.0
---

# Research brief

Use when the owner asks to "research", "find out", "compare", "what's the latest on", or asks a factual question whose answer must be current.

## Procedure

1. `web_search` with a **short** query (3–6 words). Do not paste the whole question.
2. Pick the 1–2 most authoritative results. Prefer primary sources, official docs, papers, vendor changelogs.
3. `read_url` on those pages. Never cite a snippet you have not opened if the claim is specific (a version number, a date, a price, an API name).
4. If two sources disagree, say so — do not average them.

## Answer shape

```
<answer in 1–2 sentences>

• <fact> — <source host>
• <fact> — <source host>
```

Rules:

- Maximum 5 bullets. The notch cannot show more.
- Every specific claim needs the host it came from. No host, no claim.
- If the search finds nothing useful, say "Nothing solid came back" and offer a narrower query. Never fill the gap from memory and pass it off as research.
- If the owner is on the phone (WhatsApp), drop the bullets to 2 lines.
