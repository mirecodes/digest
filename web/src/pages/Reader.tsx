// Reader: header, sidebar, PDF pane | divider | translation pane, with page-synchronized scrolling.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { loadViewer } from "../api/client";
import { t } from "../i18n";
import { union } from "../lib/highlights";
import { closePop } from "../lib/popover";
import { bindScrollSync, type PaneLayout } from "../lib/scrollSync";
import { SNAPS, SPLIT_MAX, SPLIT_MIN, singleColumn, snapSplit, stepSplit } from "../lib/split";
import { useStore } from "../lib/store";
import HeaderBar from "../reader/HeaderBar";
import { NavContext, type Nav } from "../reader/nav";
import PdfPane from "../reader/PdfPane";
import Sidebar from "../reader/Sidebar";
import TranslationPane from "../reader/TranslationPane";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const SPLIT_KEY = "pv.split";
const readSplit = () => {
  try {
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(localStorage.getItem(SPLIT_KEY)) || 0.5));
  } catch {
    return 0.5;
  }
};

export default function Reader({ paperId, initialPage }: { paperId: string; initialPage: number }) {
  const data = useStore((s) => s.data);
  const setData = useStore((s) => s.setData);
  const showTr = useStore((s) => s.showTr);
  const sidebar = useStore((s) => s.sidebar);
  const sync = useStore((s) => s.sync);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [split, setSplit] = useState(readSplit);
  const [dragging, setDragging] = useState(false); // the translation pane keeps its layout until the drag ends
  const pdfEl = useRef<HTMLDivElement>(null);
  const trEl = useRef<HTMLDivElement>(null);
  const panesEl = useRef<HTMLDivElement>(null);
  const layouts = useRef<{ a: PaneLayout | null; b: PaneLayout | null }>({ a: null, b: null });
  const scale = useRef(1);
  const syncer = useRef<ReturnType<typeof bindScrollSync> | null>(null);
  const pendingPage = useRef(initialPage > 1 ? initialPage : 0);

  useEffect(() => {
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    loadViewer(paperId)
      .then((d) => {
        setData(d);
        task = pdfjs.getDocument({
          url: d.paper.pdf_url, standardFontDataUrl: "/pdfjs/standard_fonts/", cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true, wasmUrl: "/pdfjs/wasm/", iccUrl: "/pdfjs/iccs/", enableHWA: true, // GPU canvas: large images draw fast
        });
        return task.promise;
      })
      .then(setDoc)
      .catch((e) => setError(String(e?.message ?? e)));
    return () => {
      task?.destroy();
      setData(null);
    };
  }, [paperId, setData]);

  const nav = useMemo<Nav>(() => {
    const findTarget = (id: string) => {
      const d = useStore.getState().data;
      const b = d?.blocks.find((x) => x.id === id) ?? d?.figures.find((x) => x.id === id);
      if (b) return { page: b.page, bbox: b.bbox };
      const h = d?.highlights.find((x) => x.id === id);
      return h ? { page: h.page, bbox: union(h.rects) } : null;
    };
    return {
      goToPage(page) {
        const el = pdfEl.current;
        const l = layouts.current.a;
        if (!el || !l) return;
        el.scrollTop = l.tops[page - 1] - 8;
        if (useStore.getState().sync) syncer.current?.align("a");
      },
      goToBlock(id) {
        const el = pdfEl.current;
        const l = layouts.current.a;
        const target = findTarget(id);
        if (!el || !l || !target) return;
        const center = (target.bbox[1] + target.bbox[3]) / 2;
        el.scrollTop = l.tops[target.page - 1] + center * scale.current - el.clientHeight / 2;
        useStore.getState().flashBlock(id); // sync stays paused for this jump; the next user scroll re-aligns
      },
      showInTranslation(id) {
        const pane = trEl.current;
        const node = pane?.querySelector<HTMLElement>(`[data-block-id="${id}"],[data-figure-id="${id}"]`);
        if (!pane || !node) return;
        const y = node.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
        pane.scrollTop = y - pane.clientHeight / 2 + node.offsetHeight / 2;
        useStore.getState().flashBlock(id);
      },
    };
  }, []);

  const onPdfLayout = useCallback((l: PaneLayout, s: number) => {
    layouts.current.a = l;
    scale.current = s;
    useStore.getState().setScale(s);
    if (pendingPage.current) {
      const page = pendingPage.current;
      pendingPage.current = 0;
      requestAnimationFrame(() => nav.goToPage(page));
    }
  }, [nav]);
  const onTrLayout = useCallback((l: PaneLayout) => {
    layouts.current.b = l;
    if (useStore.getState().sync) syncer.current?.align("a"); // cards changed height (resize, one-column switch)
  }, []);

  useEffect(() => {
    if (!doc || !showTr || !pdfEl.current || !trEl.current) return;
    syncer.current = bindScrollSync(pdfEl.current, trEl.current, () => layouts.current, () => useStore.getState().sync);
    requestAnimationFrame(() => useStore.getState().sync && syncer.current?.align("a"));
    return () => {
      syncer.current?.dispose();
      syncer.current = null;
    };
  }, [doc, showTr]);
  useEffect(() => {
    if (sync) syncer.current?.align("a"); // turning sync back on aligns to the PDF pane
  }, [sync]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePop();
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "h") st.toggle("showHl");
      else if (key === "t") st.toggle("showTr");
      else if (key === "s") st.toggle("sync");
      else if (key === "[") st.toggle("sidebar");
      else if (key === "j" && st.data) nav.goToPage(Math.min(st.data.pages.length, st.page + 1));
      else if (key === "k") nav.goToPage(Math.max(1, st.page - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  const commitSplit = (v: number) => {
    setSplit(v);
    try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* ignore */ }
  };
  const onDividerDown = (e: React.PointerEvent) => {
    const box = panesEl.current!.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    let v = split;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      v = snapSplit(ev.clientX - box.left, box.width);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSplit(v)); // at most one layout per frame
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      cancelAnimationFrame(frame);
      commitSplit(v);
      setDragging(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  const onDividerKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    commitSplit(stepSplit(split, e.key === "ArrowLeft" ? -1 : 1));
  };
  const snapped = SNAPS.includes(split);

  if (error) return <div className="reader-msg error">{t("load_failed")}: {error}</div>;
  if (!data || !doc) return <div className="reader-msg">{t("loading")}</div>;
  return (
    <NavContext.Provider value={nav}>
      <div className="reader">
        <HeaderBar />
        <div className="reader-body">
          {sidebar && <Sidebar />}
          <div className={`panes${dragging ? " resizing" : ""}`} ref={panesEl}>
            <div className="pdf-col" style={{ flexBasis: showTr ? `${split * 100}%` : "100%" }}>
              <PdfPane doc={doc} elRef={pdfEl} onLayout={onPdfLayout} />
            </div>
            {showTr && (
              <>
                <div className={`divider${dragging ? " dragging" : ""}${dragging && snapped ? " snapped" : ""}`}
                  onPointerDown={onDividerDown} onKeyDown={onDividerKey} tabIndex={0} role="separator" aria-orientation="vertical"
                  aria-label={t("split")} aria-valuemin={SPLIT_MIN * 100} aria-valuemax={SPLIT_MAX * 100} aria-valuenow={Math.round(split * 100)} />
                <div className="tr-col">
                  <TranslationPane elRef={trEl} onLayout={onTrLayout} frozen={dragging} single={singleColumn(split)} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </NavContext.Provider>
  );
}
