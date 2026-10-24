import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getConfig, getPrepare, listJobs, listPapers, startJob } from "../api/client";
import { navigate } from "../App";
import { t, type Key } from "../i18n";
import {
  CheckIcon, ChevronDownIcon, FigureIcon, FileIcon, FolderIcon, HighlightIcon, PreparedIcon, SelectModeIcon, TranslateIcon,
} from "../reader/icons";
import type { Action, AgentChoice, AgentConfig, JobInfo, PaperEntry, PrepareState } from "../types";
import { runProgress } from "./progress";

const POLL_MS = 1000;
const COLLAPSED_KEY = "paper-viewer:collapsed";
const READ_KEY = "paper-viewer:read";
const finished = (j: JobInfo) => j.status !== "queued" && j.status !== "running";
const resumable = (j: JobInfo) => !!j.id && (j.status === "failed" || j.status === "interrupted");
// jobs name their paper by the PDF hash, which survives the folder being made or moved
const jobKey = (p: PaperEntry) => p.sha ?? p.id;

/** A folder of the library tree (folder_rel without its last part). */
type Folder = { name: string; path: string; dirs: Folder[]; papers: PaperEntry[] };
function buildTree(papers: PaperEntry[]): Folder {
  const root: Folder = { name: "", path: "", dirs: [], papers: [] };
  for (const p of papers) {
    const parts = p.folder_rel.split("/").slice(0, -1);
    let node = root;
    parts.forEach((name, i) => {
      let child = node.dirs.find((d) => d.name === name);
      if (!child) node.dirs.push((child = { name, path: parts.slice(0, i + 1).join("/"), dirs: [], papers: [] }));
      node = child;
    });
    node.papers.push(p);
  }
  return root;
}
const allPapers = (f: Folder): PaperEntry[] => [...f.papers, ...f.dirs.flatMap(allPapers)];

/** Circle-check select control; null = some of a folder's papers are selected. */
function SelectCircle({ state, label, onChange }: { state: boolean | null; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === null ? "mixed" : state}
      aria-label={label}
      className="select-circle"
      onClick={() => onChange(state !== true)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {state === false ? (
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
        ) : (
          <>
            <circle cx="12" cy="12" r="10" fill="currentColor" />
            <path d={state ? "M7.5 12.5l3 3 6-6.5" : "M8 12h8"} fill="none" stroke="#fff" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </svg>
    </button>
  );
}

const ACTIONS: { action: Action; label: Key; hint: Key }[] = [
  { action: "all", label: "action_all", hint: "action_all_hint" },
  { action: "digest", label: "action_digest", hint: "action_digest_hint" },
  { action: "translation", label: "action_translation", hint: "action_translation_hint" },
  { action: "annotation", label: "action_annotation", hint: "action_annotation_hint" },
];

const complete = (c: { done: number; total: number }) => c.total > 0 && c.done === c.total;

/** Whether an action has nothing left to do for the paper (such papers are skipped; a passed summary is never redone).
 * Every action stands alone otherwise: the job prepares the paper first. */
function isDone(p: PaperEntry, a: Action): boolean {
  const digested = p.digest_verify === "PASS";
  const annotated = p.highlights > 0 && complete(p.figure_notes);
  return {
    digest: digested,
    translation: complete(p.translation),
    annotation: annotated,
    all: digested && complete(p.translation) && annotated,
  }[a];
}

/** Four line icons, grey until the part is done, then blue; the counts are in the tooltip. */
function Marks({ p }: { p: PaperEntry }) {
  const marks: [string, boolean, ReactNode][] = [
    [t("mark_prepared"), p.status !== "new", <PreparedIcon />],
    [`${t("translation")} ${p.translation.done}/${p.translation.total}`, complete(p.translation), <TranslateIcon />],
    [`${t("highlights")} ${p.highlights}`, p.highlights > 0, <HighlightIcon />],
    [`${t("figure_notes")} ${p.figure_notes.done}/${p.figure_notes.total}`, complete(p.figure_notes), <FigureIcon />],
  ];
  return (
    <span className="marks">
      {marks.map(([label, on, icon]) => {
        const text = `${label}: ${t(on ? "mark_done" : "mark_todo")}`;
        return <span key={label} className={`mark${on ? " on" : ""}`} role="img" aria-label={text} title={text}>{icon}</span>;
      })}
    </span>
  );
}

const etaText = (s: number | null) =>
  s === null ? t("eta_estimating")
  : s < 60 ? t("eta_soon")
  : `${t("eta_about")} ${s >= 3600 ? `${Math.floor(s / 3600)} h ` : ""}${Math.round((s % 3600) / 60)} min ${t("eta_left")}`;

function Bar({ label, text, right, done, total }: { label: string; text: ReactNode; right: ReactNode; done: number; total: number }) {
  return (
    <div className="run-progress">
      <div className="run-progress-text">
        <span className="num">{text}</span>
        <span>{right}</span>
      </div>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${(100 * done) / total}%` }} />
      </div>
    </div>
  );
}

// the preparing bar shows only when it takes a while
const PREPARE_SHOW_AFTER_S = 1;

/** Bars under the search: new PDFs being moved into the output folder, then the jobs of the current run (papers done,
 * time left). Each disappears when its work is done. */
function Progress({ jobs, parallel, prep }: { jobs: JobInfo[]; parallel: number; prep: PrepareState | null }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), POLL_MS);
    return () => clearInterval(timer);
  }, []);
  const run = runProgress(jobs, parallel || 1, now);
  const preparing = prep?.running && prep.total > 0 && now - (prep.started ?? now) >= PREPARE_SHOW_AFTER_S;
  return (
    <>
      {preparing && (
        <Bar label={t("preparing")} text={`${t("preparing")} · ${prep.done} / ${prep.total}`} right={prep.current} done={prep.done} total={prep.total} />
      )}
      {run && (
        <Bar
          label={t("progress")}
          text={<>
            {t("progress")} · {run.done} / {run.total} {t("progress_papers")}
            {run.failed > 0 && <span className="bad"> · {run.failed} {t("progress_failed")}</span>}
          </>}
          right={etaText(run.eta)}
          done={run.done}
          total={run.total}
        />
      )}
    </>
  );
}

/** The step to run on the selected papers; each item shows how many of them it has work for (a check: none). */
function ProcessMenu({ chosen, onRun }: { chosen: PaperEntry[]; onRun: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="primary" aria-haspopup="menu" aria-expanded={open} disabled={chosen.length === 0} onClick={() => setOpen((o) => !o)} title={t("process_hint")}>
        {t("process")} <ChevronDownIcon />
      </button>
      {open && (
        <div className="menu" role="menu">
          {ACTIONS.map(({ action, label, hint }) => {
            const todo = chosen.filter((p) => p.status !== "evicted" && !isDone(p, action)).length;
            return (
              <button
                key={action}
                role="menuitem"
                data-action={action}
                disabled={todo === 0}
                title={t(todo ? hint : "already_done")}
                onClick={() => {
                  setOpen(false);
                  onRun(action);
                }}
              >
                <span>{t(label)}</span>
                {todo ? <span className="todo num" title={t("batch_todo")}>{todo}</span>
                  : <span className="done" aria-label={t("already_done")}><CheckIcon /></span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const choiceKey = (backend: string) => `paper-viewer:agent:${backend}`;
function loadChoice(backend: string): AgentChoice {
  try {
    return { model: "", effort: "", ...JSON.parse(localStorage.getItem(choiceKey(backend)) ?? "{}") };
  } catch {
    return { model: "", effort: "" };
  }
}

/** Model and effort for the next jobs; empty = cfg.yaml. Remembered per backend in this browser. */
function AgentPicker({ cfg, choice, onChange }: { cfg: AgentConfig; choice: AgentChoice; onChange: (c: AgentChoice) => void }) {
  const set = (c: AgentChoice) => {
    onChange(c);
    try {
      localStorage.setItem(choiceKey(cfg.backend), JSON.stringify(c));
    } catch {
      /* private window: not remembered */
    }
  };
  const fallback = (v: string) => `${t("agent_default")} (${v || t("agent_cli_default")})`;
  return (
    <div className="agent-picker" title={t("agent_hint")}>
      <span className="chip">{cfg.backend}</span>
      <label>
        {t("agent_model")}
        <input
          list="agent-models"
          value={choice.model}
          placeholder={fallback(cfg.model)}
          onChange={(e) => set({ ...choice, model: e.target.value.trim() })}
        />
        <datalist id="agent-models">
          {cfg.models.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      {cfg.efforts.length > 0 && (
        <label>
          {t("agent_effort")}
          <select value={choice.effort} onChange={(e) => set({ ...choice, effort: e.target.value })}>
            <option value="">{fallback(cfg.effort)}</option>
            {cfg.efforts.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

const JOB_LABEL: Record<JobInfo["status"], Key> = {
  queued: "job_queued", running: "job_running", done: "job_done", failed: "job_failed", interrupted: "job_interrupted",
};

function JobLog({ job, onResume }: { job: JobInfo; onResume: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.lines.length]);
  const action = ACTIONS.find((a) => a.action === job.action);
  const tone = job.status === "done" ? "ok" : job.status === "failed" || job.status === "interrupted" ? "bad" : "";
  return (
    <div className="job" data-testid="job-log">
      <div className="job-head">
        <span className={`chip ${tone}`} data-status={job.status}>
          {action ? `${t(action.label)} · ` : ""}{t(JOB_LABEL[job.status])}
        </span>
        {resumable(job) && <button onClick={onResume} title={t("resume_hint")}>{t("resume")}</button>}
      </div>
      <pre ref={ref}>{job.lines.join("\n") || "…"}</pre>
    </div>
  );
}

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** Flip one value of a set remembered in this browser. */
const toggleStored = (key: string, value: string) => (cur: Set<string>) => {
  const next = new Set(cur);
  if (!next.delete(value)) next.add(value);
  try {
    localStorage.setItem(key, JSON.stringify([...next]));
  } catch {
    /* private window: not remembered */
  }
  return next;
};

export default function Library() {
  const [papers, setPapers] = useState<PaperEntry[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  // latest job per jobKey(paper); a job the server refused stays local (id "") until the paper runs again
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [choice, setChoice] = useState<AgentChoice>({ model: "", effort: "" });
  const [parallel, setParallel] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadSet(COLLAPSED_KEY));
  // papers the user marked as read, by jobKey (the PDF hash survives the folder being moved)
  const [read, setRead] = useState<Set<string>>(() => loadSet(READ_KEY));
  // the select circles, Select all and the Process menu show only in select mode
  const [selecting, setSelecting] = useState(false);
  const [note, setNote] = useState("");
  const [prep, setPrep] = useState<PrepareState | null>(null);

  // bumped by whatever may start work (a job, or a list reload: the server then prepares new src/ PDFs) to restart
  // the polling below, which stops while nothing runs
  const [wake, setWake] = useState(0);
  const poll = useRef({ last: "", seen: new Set<string>(), lastPrep: "" });

  const refresh = useCallback(() => listPapers().then((ps) => {
    setPapers(ps);
    setWake((w) => w + 1);
  }, (e) => setError(String(e.message ?? e))), []);
  useEffect(() => {
    refresh();
    getConfig().then((c) => {
      setParallel(c.parallel ?? 0);
      if (!c.agent) return; // older server
      setAgent(c.agent);
      const saved = loadChoice(c.agent.backend);
      setChoice({ model: saved.model, effort: c.agent.efforts.includes(saved.effort) ? saved.effort : "" });
    }, () => {});
  }, [refresh]);

  // one poll for every job (also brings back the logs after a reload or a viewer restart); the list reloads when a
  // job finishes. Each tick tells whether work is left; once none is, the polling stops until the next wake.
  useEffect(() => {
    const st = poll.current;
    const tick = () =>
      listJobs().then((list) => {
        const text = JSON.stringify(list);
        if (text !== st.last) {
          st.last = text;
          const ended = list.filter((j) => finished(j) && !st.seen.has(j.id));
          ended.forEach((j) => st.seen.add(j.id));
          setJobs((cur) => ({
            ...Object.fromEntries(Object.entries(cur).filter(([, j]) => !j.id)),
            ...Object.fromEntries(list.map((j) => [j.paper, j])),
          }));
          if (ended.length) refresh();
        }
        return list.some((j) => !finished(j));
      }, () => true); // server unreachable: keep asking
    // new src/ PDFs the server is moving into the output folder: the list reloads as each one is done
    const tickPrep = () =>
      getPrepare().then((s) => {
        const key = `${s.running}:${s.done}:${s.started}`;
        if (key !== st.lastPrep) {
          if (st.lastPrep) refresh(); // a PDF was prepared, or the batch ended
          st.lastPrep = key;
          setPrep(s);
        }
        return s.running;
      }, () => true);
    let alive = true;
    const tickAll = () =>
      Promise.all([tick(), tickPrep()]).then((busy) => {
        if (alive && !busy.some(Boolean)) clearInterval(timer);
      });
    const timer = setInterval(tickAll, POLL_MS);
    tickAll();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh, wake]);

  const busy = (p: PaperEntry) => !!jobs[jobKey(p)] && !finished(jobs[jobKey(p)]);
  const chosen = (papers ?? []).filter((p) => selected.has(p.id));
  const run = async (p: PaperEntry, action: Action, agentChoice = choice, resume = false) => {
    const key = jobKey(p);
    try {
      const job = await startJob(p.id, action, agentChoice, resume);
      setJobs((all) => ({ ...all, [key]: { id: job.job_id, paper: key, action: job.action, status: job.status as JobInfo["status"], lines: [], ...agentChoice } }));
      setWake((w) => w + 1);
    } catch (e) {
      setJobs((all) => ({ ...all, [key]: { id: "", paper: key, action, status: "failed", lines: [String((e as Error).message ?? e)], ...agentChoice } }));
    }
  };
  // the same action, model and effort as the cut-off run, keeping what it already finished
  const resume = (p: PaperEntry, j: JobInfo) => run(p, j.action, { model: j.model, effort: j.effort }, true);

  /** Queue the action for every selected paper in list order, skipping the ones it has nothing to do for. */
  const runSelected = async (action: Action) => {
    const todo = chosen.filter((p) => p.status !== "evicted" && !busy(p) && !isDone(p, action));
    for (const p of todo) await run(p, action);
    setNote(`${todo.length} ${t("batch_started")}` + (chosen.length > todo.length ? ` · ${chosen.length - todo.length} ${t("batch_skipped")}` : ""));
  };

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (papers ?? []).filter((p) => !q || p.folder_rel.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)),
    [papers, q],
  );
  const tree = useMemo(() => buildTree(visible), [visible]);

  const selState = (ids: string[]) => {
    const n = ids.filter((id) => selected.has(id)).length;
    return n === 0 ? false : n === ids.length ? true : null;
  };
  const select = (ids: string[], on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  const toggleFolder = (path: string) => setCollapsed(toggleStored(COLLAPSED_KEY, path));

  const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties;
  const renderPaper = (p: PaperEntry, depth: number) => {
    const job = jobs[jobKey(p)];
    const on = selecting && selected.has(p.id);
    const isRead = read.has(jobKey(p));
    return (
      <div key={p.id} className="tree-item" role="treeitem" aria-selected={on} data-paper-id={p.id} style={depthStyle(depth)}>
        <div className={`tree-row paper-row${on ? " selected" : ""}${isRead ? " read" : ""}`}>
          <span className="twisty-space" />
          <FileIcon />
          <span className="name" title={p.folder_rel}>{p.name}</span>
          {p.status === "new" && <span className="chip warn">{t("new_paper")}</span>}
          {p.status === "evicted" && <span className="chip warn">{t("evicted")}</span>}
          <span className="pages num">{p.status !== "new" && `${p.num_pages}p`}</span>
          <Marks p={p} />
          <button
            className="read-toggle"
            aria-pressed={isRead}
            aria-label={`${t("mark_read")} ${p.name}`}
            title={t(isRead ? "mark_unread" : "mark_read")}
            onClick={() => setRead(toggleStored(READ_KEY, jobKey(p)))}
          >
            <CheckIcon />
          </button>
          <button className="primary" disabled={p.status !== "ok"} onClick={() => navigate(`/r/${p.id}`)}>{t("open")}</button>
          {selecting && <SelectCircle state={on} label={`${t("select")} ${p.name}`} onChange={(v) => select([p.id], v)} />}
        </div>
        {/* a finished job shows only as the row's blue step marks */}
        {job && job.status !== "done" && <JobLog job={job} onResume={() => resume(p, job)} />}
      </div>
    );
  };
  // the papers directly in a folder, then its subfolders (a search shows every folder open)
  const renderFolder = (f: Folder, depth: number): ReactNode => (
    <>
      {f.papers.map((p) => renderPaper(p, depth))}
      {f.dirs.map((d) => {
        const ids = allPapers(d).map((p) => p.id);
        const state = selState(ids);
        const open = !!q || !collapsed.has(d.path);
        return (
          <div key={d.path} className="tree-item" role="treeitem" aria-expanded={open} aria-selected={state === true} data-folder={d.path} style={depthStyle(depth)}>
            <div className={`tree-row folder-row${selecting && state === true ? " selected" : ""}`}>
              <button className="twisty" aria-expanded={open} onClick={() => toggleFolder(d.path)}>
                <ChevronDownIcon />
                <FolderIcon />
                <span className="folder-name">{d.name}</span>
                <span className="count num">{ids.length}</span>
              </button>
              {selecting && <SelectCircle state={state} label={`${t("select")} ${d.name}`} onChange={(v) => select(ids, v)} />}
            </div>
            {open && <div role="group">{renderFolder(d, depth + 1)}</div>}
          </div>
        );
      })}
    </>
  );

  const visibleIds = visible.map((p) => p.id);
  const toggleSelecting = () => {
    setSelecting((on) => !on);
    setSelected(new Set()); // leaving select mode drops the selection; entering starts empty
    setNote("");
  };
  return (
    <div className="library">
      <header className="library-head">
        <h1>{t("library")}</h1>
        <p>{t("library_sub")}</p>
        <input className="paper-search" placeholder={t("search_papers")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("search_papers")} />
        <Progress jobs={Object.values(jobs)} parallel={parallel} prep={prep} />
        {agent && <AgentPicker cfg={agent} choice={choice} onChange={setChoice} />}
      </header>
      {error && <p className="error">{t("load_failed")}: {error}</p>}
      {papers === null && !error && <p className="empty-state">{t("loading")}</p>}
      {papers?.length === 0 && <p className="empty-state">{t("no_papers")}</p>}
      {visible.length > 0 && (
        <div className="tree">
          <div className="batch-bar" title={parallel ? `${t("batch_hint")} ${parallel}` : undefined}>
            <span className="num">{selecting ? `${chosen.length} ${t("selected")}` : `${(papers ?? []).length} ${t("papers_count")}`}</span>
            {note && <span role="status">{note}</span>}
            <span className="spacer" />
            {selecting && (
              <>
                <ProcessMenu chosen={chosen} onRun={runSelected} />
                <span className="select-all-label" aria-hidden="true">{t("select_all")}</span>
                <SelectCircle state={selState(visibleIds)} label={t("select_all")} onChange={(v) => select(visibleIds, v)} />
              </>
            )}
            <button className="select-mode" aria-pressed={selecting} onClick={toggleSelecting} title={t("select_mode_hint")}>
              <SelectModeIcon />
              {t(selecting ? "select_done" : "select")}
            </button>
          </div>
          <div role="tree" aria-multiselectable="true" aria-label={t("library")}>{renderFolder(tree, 0)}</div>
        </div>
      )}
    </div>
  );
}
