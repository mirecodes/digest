---
name: paper-annotate
description: Prepare a digested paper for the interactive viewer — full translation per layout block (target_lang in configs/cfg.yaml), auto-highlights, and figure/table explanations — then verify and build viewer.json. Use with `/paper-annotate -n NAME [--only PARTS]`.
argument-hint: -n NAME [--only translation,highlights,figures] [--resume]
---

# Paper Annotate

Input: `$ARGUMENTS`
- `-n NAME`: one paper folder — its path, its folder name, its path relative to the output root, or its PDF
  (found by content in the registry). A bare name without `-n` means the same.
- `--only PARTS`: comma-separated subset of `translation`, `highlights`, `figures`. Do only those parts (redo
  them even if complete). Without `--only`: every part that is not complete yet (see step 1).
- `--resume`: an earlier run was cut off (connection lost, viewer closed); continue it instead of redoing finished
  work. In the parts to do (the `--only` ones, else the incomplete ones), first run
  `scripts/internal/verify_annotations.sh "<paper>"` and keep what passes: every `pNNN.<lang>.md` with no ERROR
  (translate only the missing or failing pages, reusing glossary.md if it exists), highlights.md if it has no
  ERROR and at least 8 H blocks, and each F block without an ERROR (write only the missing or failing ones).

All commands go through `scripts/internal/*.sh` (project `.venv`). Paths contain spaces: always quote them.
Shell state does not carry over between commands: write the full quoted path in each one, never a variable set
earlier. The rules here are all you need to pass the checks; do not read `functions/` to work out their messages.
Do the work yourself in this session, without subagents.
Below, `<paper>` is the paper folder, `<work>` is `<paper>/.work`, `<name>` is the folder name, and `<lang>` is
the target language code printed by layout.sh (e.g. `ko`). "Target language" means that language.

Core rule: **evidence first.** Translations must be faithful, highlights must be verbatim quotes, and every
number in a figure note carries a marker. The scripts check this; a step is not done while they report ERRORs.
Write only these files: `<work>/translate/glossary.md`, `<work>/translate/pNNN.<lang>.md`, `<work>/highlights.md`,
`<work>/figure_notes.md`. Never edit the report, evidence.md, pages.md, the PDF, or anything in `layout/`.

## Preconditions
- `<work>/pages.md` exists. Every part runs on its own: the paper only needs to be prepared (copied, extracted,
  registered), which the viewer and `scripts/annotate.sh` do before calling this skill
  (`scripts/internal/prepare.sh --ensure -n "<PDF>"`). The digest (report, evidence.md) is **not** required.
- If the digest exists, use it as context. If it does not: read pages.md alone; in figure notes cite numbers from the
  text with `[p.N]` (the page in pages.md) instead of `[E#, p.N]`.

## Steps

Parts: **translation** = steps 3–5, **highlights** = step 6, **figures** = step 7. Steps 1, 2, 8, 9, 10 always run
(step 2 reads only what the selected parts need: every part needs the whole paper text).

### 1. Resolve, lay out, pick the parts
Run `scripts/internal/layout.sh "NAME"` with the `-n` value. It prints `[layout] folder: <paper>` — use that path
from now on — then `[layout] target_lang: <lang>` and `[layout] pages=… blocks=… figures=… low_conf=…`. If it
reports that the name matches 0 or several folders (or is not prepared yet), stop and report.
Without `--only`, run `scripts/internal/verify_annotations.sh "<paper>"` and skip parts that are already complete:
translation `N/N`, highlights with at least 8 H blocks (an older highlights.md without H blocks is not complete),
figure notes `N/N`. If all three are complete, go to step 9.

### 2. Read context
Read everything in one turn (consecutive line ranges requested together when a file is too long for one Read):
- The paper text, once. When translation is one of the parts: every `<work>/translate/pNNN.src.md` (the same text as
  pages.md, split into the blocks you translate; the page is the file's number). Otherwise: `<work>/pages.md`.
  Quotes copied from either pass the checks, which compare only letters and digits; a highlight that crosses a block
  boundary, check it in pages.md.
- `<work>/layout/figures.json` and the three templates.
- The report `<name> [summary].md` if it exists: only the `<!-- LANG: <lang> -->` version, or the English one when
  there is none (both say the same; `grep -n "LANG:"` gives the line ranges). Its Glossary section especially.
- `<work>/evidence.md` is not read whole: the report already cites it as `[E#, p.N]`; grep it for a number or an
  E# when a figure note or highlight note needs one.

### 3. Glossary → `<work>/translate/glossary.md`
One line per term: `English → <target-language term>` (keep the English term when it is conventionally
untranslated, e.g. `attention → attention`). Start from the report Glossary if there is one, otherwise from the
paper's own terms. Use it consistently on every page.
If glossary.md exists for another language, rewrite it for `<lang>`.

### 4. Translate page by page → `<work>/translate/pNNN.<lang>.md`
For every `pNNN.src.md`, write `pNNN.<lang>.md` with exactly the same `<!-- BLOCK id -->` markers, same order,
one translation under each marker (template: `templates/translation.md`). Rules:
- Faithful, sentence by sentence. Never summarize, merge, or drop sentences.
- Each translation is one paragraph: no line breaks inside it, even where the source text wrapped (the viewer
  keeps every line break you write).
- Keep math, symbols, variable names, citation numbers like `[12]`, URLs, and all numbers exactly.
  "Figure 3 / Table 2 / Eq. (4)" → the target language's words, keeping the number (ko: "그림 3 / 표 2 / 식 (4)").
- First occurrence of a technical term: `<target term>(English)`. Afterwards the target term only, per the glossary.
- Headings keep their numbering and add the English: `3.1 문제 정식화 (Problem Formulation)`.
- A block may end mid-sentence at a column or page break: end the translation at the matching point so the
  next block continues naturally. Read the neighbouring blocks before translating.
- Captions are translated; author names and affiliations stay as written.

### 5. Check translations
`scripts/internal/verify_annotations.sh "<paper>" --translation`. Fix every ERROR (missing or unknown block
ids). Review each WARN: dropped numbers or citation numbers, untranslated paragraphs, and length ratios outside
0.25–3.0 usually mean a sentence was dropped or summarized. The summary line must read `translation N/N`.

### 6. Highlights → `<work>/highlights.md` (the paper's reading map)
Template: `templates/highlights.md`. Highlights are **not** the evidence: evidence.md is a detailed internal record
for the report and is never highlighted. Highlights are a short, curated map that lets a reader grasp the whole
paper at a glance — the sentences you would mark for a colleague who has ten minutes. A reader who reads only the
highlights, in order, must come away with the paper's whole argument: what problem, why existing work falls short,
what is proposed, how each part works, what shows that it works, and where it stops. Nothing outside that argument
is highlighted. Work in four passes; do not pick sentences before pass 1 is written down.

**Pass 1 — Reading map.** Write it at the top of highlights.md under `## Reading map` (the viewer ignores it; it is
your plan and the reviewer's check). From all of pages.md (and the report if it exists), in your own words, one
line each:
```
- Thesis: <the paper's main claim in one sentence: "X does Y by Z, which W">
- Problem: <the task and why it matters>
- Gap: <what existing approaches do and the specific shortcoming this paper attacks>
- C1: <contribution 1> | how: <the mechanism that makes it work> | shown by: <the experiment or number that supports it>
- C2: … (one line per distinct contribution, as the paper itself lists them, usually 2–4)
- Scope: <assumptions or settings the method relies on> (omit if none worth stating)
- Insight: <why it works, or the takeaway that changes how one thinks about the problem>
- Limits: <limitations or failure cases the authors state> (omit if none)
```
Build the C# lines from the paper's own contribution list (end of the introduction: "our contributions are",
"we propose", "we introduce", "in summary"). Merge items that are the same idea at two levels of detail; drop items
that are only "extensive experiments". For `shown by`, find the experiment that tests that contribution: the main
comparison table or figure for the overall method, an ablation for a component. If the paper never tests a
contribution, write `shown by: not tested`.

**Pass 2 — Find where each line is stated.** For each map line, search the section where the paper states it in
full, then pick the single sentence that states it best:
| map line | look in | cue phrases |
|---|---|---|
| Problem | abstract, first introduction paragraphs | "remains challenging", "the key challenge", "we address" |
| Gap | introduction before the contributions, end of related work | "however", "fail to", "limited to", "require", "in contrast" |
| C# contribution | the contribution list / last introduction paragraph | "we propose", "we introduce", "we present", "our key" |
| C# how | the method section: the opening sentence of the subsection for that part, or the sentence defining it | "the key idea", "consists of", "instead of", "we formulate", "is trained to" |
| C# shown by | the experiments section: the sentence interpreting the main table, the ablation's conclusion | "outperforms", "improves", "compared to", "without", "ablation", numbers with % or × |
| Scope | problem formulation, method assumptions | "we assume", "we consider", "given", "under" |
| Insight | analysis, discussion | "this suggests", "we find that", "because", "this shows" |
| Limits | conclusion, discussion, limitations section | "limitation", "fails when", "future work", "does not" |

The same point usually appears in the abstract, the introduction and the conclusion. Anchor it where it is most
specific: problem, gap and contributions in the introduction (the abstract only if it is the clearest statement);
`how` always in the method section and `shown by` always in the experiments section, so the highlights lead the
reader through the body of the paper, not just its first page. At most 2 highlights in the abstract.

**Pass 3 — Choose.** Keep a sentence only if it passes all four tests:
- *Necessary*: dropping it would leave a map line uncovered. One map line gets one highlight; a C# line gets one
  `contribution`, 1–2 `method` and 1–2 `result` highlights (two only when the second states a distinct part or a
  distinct finding).
- *Specific*: it states a mechanism, a comparison or a number, not a judgement ("achieves impressive results",
  "is an important problem" alone are not highlights).
- *Self-contained*: it makes sense on its own; avoid sentences that start with an unresolved "This"/"It" or that
  depend on a symbol defined elsewhere, unless no better sentence exists.
- *Not redundant*: no two highlights say the same thing.
Never highlight: background facts everyone in the field knows, related-work details about other papers,
signposting ("In Section 3 we …"), setup details (hyperparameters, hardware, dataset sizes) unless they define the
setting, captions, equations, or evidence.md entries copied for their own sake.

**Pass 4 — Audit before verifying.** Read only the notes, top to bottom. They must read as a complete abstract of the
paper; if a step of the argument is missing, go back to pass 2. Then check: every C# has its `contribution`,
`method` and `result` highlight (verify_annotations warns otherwise); the headline result of the main table or
figure is highlighted; method and result highlights come from the body, not the abstract; every highlight belongs
to a map line. Remove any that does not.

Categories (the first five are expected in every paper):
| category | what it captures |
|---|---|
| `problem` | the problem the paper wants to solve, and why it matters |
| `prior_work` | what existing methods do and their specific shortcoming this paper targets |
| `contribution` | what the paper claims to contribute (one H block per distinct contribution) |
| `method` | the core idea of the approach: the mechanism a reader must understand, not implementation detail |
| `result` | the main experimental findings: headline numbers versus baselines, decisive ablations |
| `assumption` | key assumptions or problem settings the method relies on (stated or clearly implied by a sentence) |
| `insight` | the "why it works" or a takeaway that frames the paper (free choice: anything that helps the big picture) |
| `limitation` | limitations or open problems the authors state |

Map lines to categories: Problem → `problem`, Gap → `prior_work`, C# → `contribution` / `method` / `result` with
`claim: C#`, Scope → `assumption`, Insight → `insight`, Limits → `limitation`. The Thesis is usually covered by C1's
contribution highlight; highlight it separately (as `insight`) only when one sentence states the whole claim better.

Rules:
- Write the H blocks in map order: Problem, Gap, Scope, then per contribution its contribution, method and result
  highlights (C1, then C2, …), then Insight and Limits.
- 8–24 H blocks in total (short papers: at most 3 × pages); at most 6 on one page. The count follows from the map;
  never add highlights to reach a number or drop map lines to stay under one.
- `quote`: one sentence (two at most), 40–300 characters, copied **verbatim** from pages.md (original language).
  Prefer the sentence that states the point in general terms over one buried in detail.
- `note_<lang>` (target language) and `note_en`: the one-line summary the reader sees first. Start with the
  role, then the content in your own words, e.g. `풀려는 문제: …`, `기존 방법의 한계: …`, `기여 1: …`,
  `핵심 방법 (기여 1): …`, `주요 결과 (기여 1): …` (`Contribution 1:`, `Method (C1):`, `Result (C1):` in English), so
  the reader sees which contribution a method or result belongs to. Numbers in a note must appear in the quoted
  sentence (or evidence.md, if any); never from memory.

### 7. Figure notes → `<work>/figure_notes.md`
Template: `templates/figure_notes.md`. One F block for **every** figure and table in `layout/figures.json`.
For each: open the PNG `<work>/layout/figures/<fid>.png` with the Read tool, read its caption and the blocks
listed in `refs`, then write a `#### <lang>` section first and a `#### en` section second:
- summary line — `요약:` for Korean, `Summary:` for every other language; one line, ≤ 120 characters (the popover
  headline);
- how to read — axes, legend, symbols;
- 2–4 observations as bullets;
- link to text — which contribution (C#) or claim it supports.
Markers: numbers from the paper text → `[E#, p.N]` when evidence.md has them, otherwise `[p.N]` (page of
pages.md); values read off the image → `[FIG: <fid>]`; computed →
`[CALC: …]`; your judgement → `[INTERP]`; outside knowledge → `[EXT]`. A number without a marker is a warning.
If the crop is wrong or unreadable (e.g. the box misses the legend), write `- status: SKIP` with `- reason: …`;
low-confidence boxes are listed in figures.json (`confidence` < 0.6).

### 8. Verify
`scripts/internal/verify_annotations.sh "<paper>"`, adding `--translation` / `--highlights` / `--figures` for the
parts you did when `--only` was given. Fix ERRORs, at most 3 rounds; if ERRORs remain, report them.
Handle WARNs where they point to a real problem (dropped numbers, duplicates of evidence, density).

### 9. Build the viewer bundle
`scripts/internal/build_viewer.sh "<paper>"`.

### 10. Report back
Briefly: the folder, the parts done, translation done/total, highlight count by category, figure notes OK/SKIP,
verify PASS/FAIL with warning count, and low-confidence figure boxes. Reply in the user's language.

## Headless rules
Same as /paper-digest: under `claude -p`, never ask questions and never pass `--force`; report instead.
