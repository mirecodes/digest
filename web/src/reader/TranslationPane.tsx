// Translation pane: one card per original page, same gap as the PDF pane. Card positions are measured and
// reported as a PaneLayout for scroll sync. While the divider is dragged (`frozen`) the cards keep their layout and
// are only scaled by CSS to the new width; they are laid out again once, when the drag ends.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PAGE_GAP, PANE_PAD } from "../lib/coords";
import { categoryByBlock, visible } from "../lib/highlights";
import type { PaneLayout } from "../lib/scrollSync";
import { useStore } from "../lib/store";
import type { Block, Figure } from "../types";
import TranslationPage from "./TranslationPage";

type Props = {
  elRef: React.RefObject<HTMLDivElement | null>;
  onLayout: (layout: PaneLayout) => void;
  frozen: boolean;
  single: boolean; // two-column pages as one column (lib/split.singleColumn)
};

export default function TranslationPane({ elRef, onLayout, frozen, single }: Props) {
  const data = useStore((s) => s.data)!;
  const [view, setView] = useState({ width: 0, single });
  const contentRef = useRef<HTMLDivElement>(null);
  const live = useRef({ frozen, single, width: 0 });
  live.current = { frozen, single, width: view.width };

  const showHl = useStore((s) => s.showHl);
  const hiddenCats = useStore((s) => s.hiddenCats);
  const byPage = useMemo(() => {
    const m = new Map<number, { blocks: Block[]; figures: Figure[] }>();
    for (const p of data.pages) m.set(p.page, { blocks: [], figures: [] });
    for (const b of data.blocks) m.get(b.page)?.blocks.push(b);
    for (const f of data.figures) m.get(f.page)?.figures.push(f);
    return m;
  }, [data]);
  // one map for all pages; TranslationPage reads its own blocks from it (memo stays valid for unchanged pages)
  const hlCats = useMemo(() => categoryByBlock(visible(data.highlights, showHl, hiddenCats), data.blocks),
    [data, showHl, hiddenCats]);

  useLayoutEffect(() => {
    const el = elRef.current!;
    const content = contentRef.current!;
    const measure = () => {
      const w = el.clientWidth;
      const { frozen, single, width } = live.current;
      if (frozen) {
        const inner = width - 2 * PANE_PAD;
        content.style.transform = inner > 0 ? `scale(${(w - 2 * PANE_PAD) / inner})` : "";
        return;
      }
      content.style.transform = "";
      setView((v) => (v.width === w && v.single === single ? v : { width: w, single }));
      const cards = [...content.children] as HTMLElement[];
      onLayout({ tops: cards.map((c) => c.offsetTop), heights: cards.map((c) => c.offsetHeight), gap: PAGE_GAP });
    };
    const ro = new ResizeObserver(measure); // pane width, and content height (any card resizing)
    ro.observe(el);
    ro.observe(content);
    measure();
    return () => ro.disconnect();
  }, [elRef, onLayout, data, frozen, single]);

  const inner = Math.max(0, view.width - 2 * PANE_PAD);
  return (
    <div ref={elRef} className="pane tr-pane" tabIndex={0} data-testid="tr-pane">
      <div ref={contentRef} className={`tr-content${view.single ? " single" : ""}`} style={{ width: inner }}>
        {inner > 0 &&
          data.pages.map((p) => (
            <TranslationPage key={p.page} paperId={data.paper.id} info={p} s={inner / p.width} single={view.single}
              blocks={byPage.get(p.page)!.blocks} figures={byPage.get(p.page)!.figures} hlCats={hlCats} />
          ))}
      </div>
    </div>
  );
}
