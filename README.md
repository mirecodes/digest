# Paper Digest

Turn research-paper PDFs into:

- a **source-verified report**, saved as `<name> [summary].md` (Korean, then English), where every fact cites `[E#, p.N]` and a
  script checks each citation against the extracted text;
- a **side-by-side reader** (local web app): the PDF on the left, a full translation on the right with page-synced
  scrolling, highlights of key sentences, and figure notes.

The reading and writing is done by an AI coding agent of your choice: **Claude Code, Codex CLI (ChatGPT) or Gemini
CLI**. You bring your own account or API key. The project never stores or sends keys itself.

## Requirements

- macOS or Linux, Python 3.10+
- Node.js 20+ (for the reader web app)
- One of the agent CLIs below, logged in

## Quick start

```bash
git clone <this repo> paper-digest && cd paper-digest
cp ~/Downloads/some-paper.pdf src/   # subfolders in src/ are kept in the output
./run.sh                             # sets up on the first run, then opens http://127.0.0.1:8765
```

`./run.sh` is the only command needed day to day. It:

1. runs `scripts/setup.sh` when `.venv` or the reader build is missing, and rebuilds the reader when its sources
   changed (e.g. after `git pull`);
2. checks that the AI agent CLI is installed (`scripts/internal/agent.sh --check`; it does not check the login).
   Without it you can still read, but **Process** fails, so install and log in first (next section);
3. starts the reader. New PDFs in `src/` are moved into the output folder right away (renamed, text extracted). To
   process papers, click **Select** above the list, tick papers, a folder or **Select all**, and pick a step in
   **Process ▾**. Ctrl+C stops it.

Options go to `scripts/viewer.sh`: `./run.sh --port 8800`, `./run.sh --no-open`.

Step by step, or without the reader:

```bash
scripts/setup.sh                    # .venv, Python packages, reader build
scripts/internal/selftest.sh        # must print [selftest] PASS
# pick and log in to an AI (next section), then:
scripts/internal/agent.sh --check   # shows the backend, its version and how to log in
cp ~/Downloads/some-paper.pdf src/
scripts/digest.sh                   # report for every new PDF in src/
scripts/viewer.sh                   # opens http://127.0.0.1:8765
```

## Choose your AI

Set the backend in `configs/cfg.yaml`:

```yaml
agent:
  backend: claude    # claude | codex | gemini
  model: ""          # empty = the CLI's default; otherwise any model name that CLI accepts
  effort: ""         # empty = the CLI's default; claude: low … max, codex: minimal … high (Gemini: none)
```

These are defaults. In the reader's library page, **Model** and **Effort** (above the paper list) choose them for the
next Process runs, e.g. `claude-opus-5-5` with `high` for a hard paper, or `claude-sonnet-5-5` with `medium`. The
model box suggests Claude's current models; for Codex or Gemini type any model name your account can use (or list
yours under `agent.models` in `cfg.yaml`). If your plan or key cannot use a model, the job log shows the CLI's
error. The choice is remembered in your browser.

For a single terminal run without editing the file, use environment variables:
`PAPER_AGENT=gemini scripts/digest.sh`, or `PAPER_AGENT_MODEL=claude-opus-5-5 PAPER_AGENT_EFFORT=high scripts/annotate.sh -n "<name>"`.

| | Claude | ChatGPT / OpenAI | Gemini |
|---|---|---|---|
| CLI | [Claude Code](https://claude.com/claude-code) | [Codex CLI](https://github.com/openai/codex) | [Gemini CLI](https://github.com/google-gemini/gemini-cli) |
| Install | `npm install -g @anthropic-ai/claude-code` (or `curl -fsSL https://claude.ai/install.sh \| bash`) | `npm install -g @openai/codex` | `npm install -g @google/gemini-cli` |
| Log in with a subscription | run `claude` once and log in (Claude Pro/Max) | `codex login` (ChatGPT Plus/Pro) | run `gemini` once, "Login with Google" |
| …or with an API key | `export ANTHROPIC_API_KEY=...` | `printenv OPENAI_API_KEY \| codex login --with-api-key` | `export GEMINI_API_KEY=...` |
| `backend:` | `claude` | `codex` | `gemini` |
| Model examples | `claude-opus-5-5`, `claude-sonnet-5-5` (or `opus`, `sonnet`) | see `codex --help` / OpenAI docs | see Gemini CLI docs |
| Effort | `--effort` low, medium, high, xhigh, max | `model_reasoning_effort` minimal, low, medium, high | not supported |

Keys belong in your shell profile (e.g. `~/.zshrc`) or the CLI's own login store, **never in `cfg.yaml`**, which is
committed. API-key usage is billed per token by your provider, and a full paper (report, translation and figure notes)
is a long agent session. Check your provider's usage page after the first paper. One 9-page paper took about 5
minutes to annotate with Claude Code.

### What the agent is allowed to do

`scripts/internal/agent.sh` starts the CLI headless (no questions asked), with permissions limited to what the job
needs:

| Backend | Command | Permissions |
|---|---|---|
| claude | `claude -p /<skill> …` | file edits auto-accepted; shell **only** `scripts/internal/*`; output folder added |
| codex | `codex exec …` | `workspace-write` sandbox (writes only inside the project and the output folder), network on for arXiv/Crossref lookups, never asks for approval |
| gemini | `gemini -p …` | edits auto-approved; shell **only** `scripts/internal/` (`configs/gemini-policy.toml`); output folder included |

To see the exact command without running anything, use `scripts/internal/agent.sh --dry-run paper-digest '-n "x.pdf"'`.

### How the three backends share one workflow

The procedure lives in plain-markdown skills: `.claude/skills/paper-digest/SKILL.md` (the report) and
`.claude/skills/paper-annotate/SKILL.md` (translation, highlights, figure notes). Project rules are in `CLAUDE.md`.
Claude Code runs a skill as a slash command. Codex and Gemini are told to read the same skill file and follow it.
Correctness never depends on the model: `verify.sh` and `verify_annotations.sh` check every quote, citation, page
number and translated block, and a step counts as done only when they report no ERROR. The skills were developed
with Claude, so another model may need more fix-up rounds, but it cannot slip in unverified citations.

## Using it

### Terminal

| Task | Command |
|---|---|
| Report for new PDFs in `src/` (up to `max_papers`) | `scripts/digest.sh` |
| …for one paper | `scripts/digest.sh -n "my-paper.pdf"` |
| Reader annotations (translation, highlights, figure notes); no summary needed | `scripts/annotate.sh -n "<paper folder name or src/ PDF>"` |
| …only some parts | `scripts/annotate.sh -n "<name>" --only translation,highlights,figures` |
| Continue a run that was cut off, keeping the finished work | add `--resume` to `digest.sh -n …` or `annotate.sh -n …` |
| Start the reader | `scripts/viewer.sh` |
| List all papers and their state | `scripts/internal/registry.sh` |

With Claude Code you can also type `/paper-digest` or `/paper-annotate -n NAME` inside a session.

### Reader

`scripts/viewer.sh` lists every paper as a tree that follows `src/`. On start it moves every new PDF into the
output folder (named, copied, text extracted), one after another; when that takes more than a moment a bar under
the search shows how far it got. A PDF it cannot prepare (e.g. scanned) stays marked **New**. Click a folder to
collapse it; the browser remembers which folders are closed.

To process papers, click **Select** at the top right of the list. Circles appear on the right: one per paper, one
per folder (every paper inside it), and **Select all**. Selected rows turn light blue. Then pick a step in
**Process ▾** (the number next to each step is how many selected papers still need it):

- **Run all**: summary (if missing), then the missing translation and annotation;
- **Summary**: evidence and the verified report;
- **Translation**: every block of the paper in `target_lang`;
- **Annotation**: highlights and figure notes.

Each step runs on its own, in any order: every job first prepares the paper (copies the PDF, extracts the text,
registers it), which is instant when already done. The papers queue in list order, `parallel` of them run at once,
papers whose step is already done are skipped, and each job's log streams under its row. **Done** leaves select mode.

The four icons on each row turn from grey to blue as the paper gets there: copied into the output folder,
translated, highlighted, figures explained (hover for the counts). While jobs run, a bar under the search shows how
many of the queued papers are done and about how long the rest will take (estimated from the jobs that finished).

If a run is cut off, its log shows **Failed** (the agent stopped, e.g. the connection to the AI dropped) or **Stopped
while running** (the viewer was closed or crashed; this shows up the next time it starts). Click **Resume**: it runs
the same step with the same model and effort, keeping what was already finished (translated pages, verified
evidence, figure notes) and doing only the rest.

**Open** shows the PDF and its translation side by side:

- **Highlights**: the paper's argument, tinted on the PDF by category (problem, contribution, insight, method,
  result, limitation): the agent first writes a reading map (problem, gap, each contribution with how it works and
  what shows it works, limits), then marks the one sentence that states each point. Hover one for its note. Toggle them with the **Highlights** button or `H`, and filter by category in
  the sidebar's Highlights tab.
- **Figure notes**: click a figure for a floating explanation; click it again, click elsewhere, or press `Esc` to
  close. The sidebar's Figures tab lists them all.
- **Pane split**: drag the line between the panes; it snaps to 1/3, 1/2 and 2/3 (arrow keys jump between them).
  With the PDF wider than 2/3, two-column pages of the translation switch to one column in a larger font.
- Keys: `H` highlights, `T` translation pane, `S` sync, `[` sidebar, `J`/`K` next/previous page, `/` search.

## Configuration (`configs/cfg.yaml`)

| Key | Meaning | Default |
|---|---|---|
| `out_dir` | where paper folders go (absolute, `~`, or relative to the project), e.g. an Obsidian vault folder | `out/` |
| `target_lang` | language of reader translations and figure notes (`ko`, `ja`, `de`, …); each language keeps its own files | `ko` |
| `agent.backend` / `agent.model` / `agent.effort` | AI coding agent, model and effort, see above (the reader can change model and effort per run) | `claude` / CLI default / CLI default |
| `title_words` | words kept from a long title in the folder name | 5 |
| `max_papers` | papers per run without `-n` (0 = no limit) | 5 |
| `parallel` | reader jobs that run at once (1–10); each is a separate AI session, so more uses your rate limit faster | 3 |
| `viewer.host` / `viewer.port` | reader address | `127.0.0.1` / `8765` |
| `viewer.auto_annotate` | run `annotate.sh` automatically after `digest.sh` | `false` |

The report is always Korean, then English. `target_lang` only affects the reader annotations.

## Files

```text
src/                                   your PDFs (subfolders allowed); never modified
<out_dir>/.paper-registry.yaml         every paper by PDF content hash: src/ path, folder, state (rebuilt from disk)
<out_dir>/<subfolders>/<Short Title (Year)>/   <subfolders> mirror src/; move a PDF in src/ and its folder follows
  <Short Title (Year)>.pdf             copy of the PDF
  <Short Title (Year)> [summary].md   the report
  .work/                               hidden working files: pages.md (citation basis), evidence.md, layout/,
                                       translate/pNNN.<lang>.md, highlights.md, figure_notes.md, viewer.json
```

The folder name comes from arXiv, then Crossref, then the PDF metadata. A paper is recognised by its content, so a
renamed or duplicate PDF is not processed twice. Deleting a paper folder makes the paper "new" again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[agent] ERROR: the … CLI is not installed` | install and log in as shown in the message, then `scripts/internal/agent.sh --check` |
| Job fails right after starting with an auth error | log in again with the CLI (`claude`, `codex login`, `gemini`) or check the API key variable |
| "The viewer server is out of date" / *Method Not Allowed* | an old `scripts/viewer.sh` is still running; stop it (Ctrl+C) and start it again |
| `address already in use` on port 8765 | update and run `scripts/viewer.sh` again: it stops a leftover viewer on that port, or moves to the next free port if another program uses it (printed at start). Or set `viewer.port` in `cfg.yaml` |
| `skip (PDF looks scanned …)` | the PDF has no text layer; run OCR first (e.g. `ocrmypdf in.pdf out.pdf`) |
| `skip (already digested …)` | nothing to do; delete the paper folder to redo it |
| "Not downloaded from iCloud" in the reader | open the folder in Finder and download the PDF |

## Development

- `scripts/internal/selftest.sh`: Python pipeline, registry, server, annotation checks (no AI calls)
- `scripts/internal/viewer_test.sh [--e2e]`: reader unit tests and Playwright end-to-end tests (`scripts/setup.sh --with-e2e` once)
- Design notes: `implementation.md`, `docs/viewer-plan.md`, `docs/decisions.md` (Korean)
