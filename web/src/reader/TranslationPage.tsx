// One translation card: the page's blocks in reading order, placed like the original page (§8.3). In `single` mode
// (narrow translation pane) every item spans the text width and stacks in reading order, with a larger font.
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cropUrl } from "../api/client";
import { cardItems, columnBox, layoutCard, type CardItem } from "../lib/cardLayout";
import { useStore } from "../lib/store";
import { t } from "../i18n";
import type { Block, Category, Figure, PageInfo } from "../types";
import { useNav } from "./nav";

const CARD_PAD = 12; // px below the last item
const MIN_FONT = 11;
const SINGLE_FONT = 14; // px, minimum in single mode: a whole text line is available

type Props = {
  paperId: string; info: PageInfo; blocks: Block[]; figures: Figure[]; s: number; single: boolean; hlCats: Map<string, Category>;
};

function TranslationPage({ paperId, info, blocks, figures, s, single, hlCats }: Props) {
  const nav = useNav();
  const setLink = useStore((st) => st.setLink);
  const items = useMemo(() => cardItems(info, blocks, figures), [info, blocks, figures]);
  const ids = useMemo(() => new Set(items.map((it) => it.key)), [items]);
  const linked = useStore((st) => (st.link?.from === "pdf" && ids.has(st.link.id) ? st.link.id : null));
  const flash = useStore((st) => (st.flash && ids.has(st.flash.id) ? st.flash : null));
  const oneColumn = single && info.columns > 1;
  const fontSize = Math.max(oneColumn ? SINGLE_FONT : MIN_FONT, info.body_font_size * s * 0.95);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const [tops, setTops] = useState<number[] | null>(null);
  const [height, setHeight] = useState(info.height * s);

  const boxes = useMemo(() => {
    const full = columnBox(info, blocks, -1);
    return items.map((it) => {
      if (it.type === "block") {
        const c = oneColumn ? full : columnBox(info, blocks, it.column);
        return { left: c.left * s, width: c.width * s, height: undefined as number | undefined };
      }
      const [x0, y0, x1, y1] = it.bbox; // figures and equations keep their size; centered in one column
      return { left: (oneColumn ? full.left + (full.width - (x1 - x0)) / 2 : x0) * s, width: (x1 - x0) * s, height: (y1 - y0) * s };
    });
  }, [items, info, blocks, s, oneColumn]);

  useLayoutEffect(() => {
    const heights = items.map((_, i) => boxes[i].height ?? refs.current[i]?.offsetHeight ?? 0);
    const next = layoutCard(items.map((it, i) => ({ column: oneColumn ? -1 : it.column, y0: it.bbox[1], height: heights[i] })), s);
    setTops(next);
    const bottom = next.reduce((m, top, i) => Math.max(m, top + heights[i]), 0);
    setHeight(Math.max(info.height * s, bottom + CARD_PAD));
  }, [items, boxes, s, fontSize, info.height, oneColumn]);

  const render = (it: CardItem, i: number) => {
    const style: React.CSSProperties = { left: boxes[i].left, width: boxes[i].width, top: tops?.[i] ?? it.bbox[1] * s, height: boxes[i].height };
    const cls = `${it.key === linked ? " linked" : ""}${it.key === flash?.id ? " flashing" : ""}`;
    const common = {
      ref: (el: HTMLElement | null) => { refs.current[i] = el; },
      onPointerEnter: () => setLink({ id: it.key, from: "tr" }),
      onPointerLeave: () => useStore.getState().link?.from === "tr" && setLink(null),
      onClick: () => window.getSelection()?.isCollapsed !== false && nav.goToBlock(it.key),
    };
    if (it.type === "figure") {
      return (
        <div key={it.key + (it.key === flash?.id ? flash.n : "")} className={`tr-figure${cls}`} data-figure-id={it.key} style={style} {...common}>
          <img src={it.figure.image_url} alt={it.figure.label ?? ""} loading="lazy" draggable={false} />
        </div>
      );
    }
    if (it.type === "equation") {
      return (
        <img key={it.key + (it.key === flash?.id ? flash.n : "")} className={`tr-eq${cls}`} data-block-id={it.key} style={style}
          src={cropUrl(paperId, info.page, it.bbox)} alt="" loading="lazy" draggable={false} {...common} />
      );
    }
    const b = it.block;
    const untranslated = b.translate && !b.tr;
    const cat = hlCats.get(b.id);
    return (
      <div key={it.key + (it.key === flash?.id ? flash.n : "")} data-hl={cat}
        className={`tr-block kind-${b.kind}${untranslated ? " untranslated" : ""}${cat ? ` has-hl hl-${cat}` : ""}${cls}`}
        data-block-id={it.key} title={untranslated ? t("untranslated") : undefined} style={style} {...common}>
        {b.tr ?? b.text}
      </div>
    );
  };

  return (
    <div className="tr-card" data-page={info.page} style={{ height, fontSize }}>
      {items.map(render)}
    </div>
  );
}

export default memo(TranslationPage);
