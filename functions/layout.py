"""PDF layout analysis for the viewer: blocks, columns, reading order, figure/table regions.

Writes into <paper>/.work/:
  layout/blocks.json        pages -> blocks (kind, bbox, column, reading order, text)
  layout/figures.json       figure/table regions with captions and in-text references
  layout/figures/<fid>.png  200 dpi crops
  translate/pNNN.src.md     translation sources (translatable blocks in reading order)

Coordinates are PDF points, top-left origin, 1-based pages (docs/viewer-plan.md §4.1). The analysis runs in
PyMuPDF's unrotated page space; output rects are mapped through page.rotation_matrix so they match the page as
displayed (page.rect, pdf.js). Output is deterministic: the same PDF gives byte-identical files.

Usage (via wrapper): scripts/internal/layout.sh "<paper folder | folder name>" [--force]
"""
import argparse
import json
import re
import sys
from pathlib import Path

import pymupdf

from functions.papers import find_pdf, resolve_for_annotate, target_lang, viewer_cfg
from functions.verify import WORK_DIR

VERSION = 1
HF_BAND = 0.08                      # header/footer zone: top/bottom share of the page height
CLUSTER_PAD = 6.0                   # graphics closer than 2*pad belong to one cluster
MIN_CLUSTER_AREA, MIN_CLUSTER_PATHS = 1500.0, 3
UNLABELED_MIN_SHARE = 0.15          # caption-less graphics become figures above this share of the page
CROP_DPI = 200
MATH_FONT_RE = re.compile(r"CMMI|CMSY|CMEX|Math|Symbol|STIX", re.I)
MATH_CHAR_RE = re.compile(r"[=∑∏∫∼≈≤≥←→⇒∀∃∈∂∇±×·√∥α-ωΑ-Ω]")
EQ_PAD = (10.0, 4.0)                # (x, y) pt: fragments this close to an equation's box belong to it
EQ_FRAGMENT_CHARS = 60              # longer blocks are text, not equation fragments
EQ_FRAGMENT_WORDS = 4               # ... and so are blocks with this many ordinary words ("where x is the ...")
WORD_RE = re.compile(r"[A-Za-z]{3,}")
# Same alternatives as extract_pdf.CAPTION_RE, but "." or ":" must follow the number so that prose starting a
# block ("Fig. 2 shows ...") is not a caption. IEEE "TABLE I" may stand alone on its line.
CAPTION_RE = re.compile(r"^(?:((?i:figure|fig\.|table|tab\.))\s*(\d+)\s*[.:]|(TABLE|Table)\s+([IVXL]+)\b\s*(?:[.:]|$))")
REF_RE = re.compile(r"\b(Fig(?:ure)?s?\.?|Tables?|TABLES?|Tab\.)\s*(\d+|[IVXL]+\b)")
HEADING_NUM_RE = re.compile(r"^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[A-H]\.)\s+[A-Z]")
REFS_HEAD_RE = re.compile(r"^(?:\d+\.?|[IVX]+\.)?\s*(?:references|bibliography)\s*$", re.I)
LIST_RE = re.compile(r"^(?:[•\-–*]\s|\(\w{1,3}\)\s)")
EQ_NUM_RE = re.compile(r"\(\d+[a-z]?\)$")
TRANSLATE_KINDS = {"heading", "paragraph", "list", "caption"}
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50}


# --------------------------------------------------------------------------- #
# Small geometry helpers (rects are (x0, y0, x1, y1) tuples; zero-height lines are valid)
# --------------------------------------------------------------------------- #
def _union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _touch(a, b, gap=0.0):
    return a[0] <= b[2] + gap and b[0] <= a[2] + gap and a[1] <= b[3] + gap and b[1] <= a[3] + gap


def _area(r):
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def _xover(a, b):
    """Horizontal overlap as a share of the narrower rect."""
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) / max(1e-6, min(a[2] - a[0], b[2] - b[0]))


def _center_in(b, r):
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return r[0] <= cx <= r[2] and r[1] <= cy <= r[3]


def _r2(r):
    return [round(v, 2) for v in r]


def _roman(s: str) -> int:
    vals = [ROMAN[c] for c in s.upper()]
    return sum(-v if i + 1 < len(vals) and v < vals[i + 1] else v for i, v in enumerate(vals))


def _number(s: str) -> int:
    return int(s) if s.isdigit() else _roman(s)


def join_lines(lines: list[str]) -> str:
    """Join lines with spaces; a line ending in '-' followed by a lowercase start is dehyphenated."""
    out = ""
    for line in lines:
        if out.endswith("-") and line[:1].islower():
            out = out[:-1] + line
        else:
            out = f"{out} {line}" if out else line
    return out


# --------------------------------------------------------------------------- #
# Blocks
# --------------------------------------------------------------------------- #
def raw_blocks(page) -> list[dict]:
    d = page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)
    blocks = []
    for k, b in enumerate(d["blocks"]):
        lines, line_boxes, chars, size_sum, bold, math, sizes = [], [], 0, 0.0, 0, 0, []
        for line in b.get("lines", []):
            text = "".join(s["text"] for s in line["spans"]).strip()
            if text:
                lines.append(text)
                line_boxes.append(tuple(line["bbox"]))
            for s in line["spans"]:
                n = len(s["text"].strip())
                chars += n
                size_sum += n * s["size"]
                bold += n if s["flags"] & 16 else 0
                math += n if MATH_FONT_RE.search(s["font"]) else 0
                sizes.append((round(s["size"], 1), n))
        if not chars:
            continue
        text = join_lines(lines)
        blocks.append({
            "k": k, "bbox": tuple(b["bbox"]), "lines": lines, "line_boxes": line_boxes, "text": text, "chars": chars,
            "words": len(text.split()), "font_size": size_sum / chars, "bold": bold / chars > 0.6,
            "math": math / chars, "sizes": sizes, "kind": None, "figure_id": None, "column": 0,
        })
    return blocks


def body_font_size(pages_blocks: list[list[dict]]) -> float:
    """Character-weighted mode of span sizes over the whole document."""
    weight = {}
    for blocks in pages_blocks:
        for b in blocks:
            for size, n in b["sizes"]:
                weight[size] = weight.get(size, 0) + n
    return max(sorted(weight), key=lambda s: weight[s]) if weight else 10.0


def _hf_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\d+", "", text)).strip().lower()


def mark_header_footer(pages_blocks, heights) -> None:
    """Blocks in the top/bottom band that repeat on >= half the pages (digits ignored), or bare page numbers."""
    def in_band(b, h):
        return b["bbox"][3] <= HF_BAND * h or b["bbox"][1] >= (1 - HF_BAND) * h

    pages_with = {}
    for pno, blocks in enumerate(pages_blocks):
        for key in {_hf_key(b["text"]) for b in blocks if in_band(b, heights[pno])}:
            pages_with[key] = pages_with.get(key, 0) + 1
    need = max(2, len(pages_blocks) / 2)
    for pno, blocks in enumerate(pages_blocks):
        for b in blocks:
            if in_band(b, heights[pno]) and (re.fullmatch(r"\d+", b["text"]) or pages_with.get(_hf_key(b["text"]), 0) >= need):
                b["kind"] = "header_footer"


def caption_info(b) -> tuple[tuple[str, str, int], tuple] | None:
    """((kind, normalized label, number), caption box) when the block holds a figure/table caption.

    The caption usually starts on the first line; it may also follow short subfigure-label lines such as
    "(a) (b) (c)" that PyMuPDF put in the same block. The caption box covers the caption lines only.
    """
    for i, line in enumerate(b["lines"]):
        m = CAPTION_RE.match(line)
        if m:
            word, num = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            kind = "table" if word.lower().startswith("tab") else "figure"
            box = b["line_boxes"][i]
            for lb in b["line_boxes"][i + 1:]:
                box = _union(box, lb)
            return (kind, f"{kind.capitalize()} {num}", _number(num)), box
        if len(line.split()) > 8 or line.rstrip().endswith("."):
            return None
    return None


def is_prose(b) -> bool:
    return len(b["lines"]) >= 2 and b["words"] / len(b["lines"]) > 8 and b["text"].rstrip().endswith(".")


def detect_columns(blocks, width, body) -> tuple[int, float | None]:
    mid, margin = width / 2, 0.05 * width
    body_blocks = [b for b in blocks if b["kind"] is None and abs(b["font_size"] - body) <= 0.2 * body]
    total = sum(b["chars"] for b in body_blocks) or 1
    narrow = [b for b in body_blocks if b["bbox"][2] - b["bbox"][0] < 0.6 * width]
    left = [b for b in narrow if b["bbox"][2] <= mid + margin]
    right = [b for b in narrow if b["bbox"][0] >= mid - margin and b not in left]
    if left and right and min(sum(b["chars"] for b in left), sum(b["chars"] for b in right)) / total >= 0.2:
        return 2, (max(b["bbox"][2] for b in left) + min(b["bbox"][0] for b in right)) / 2
    return 1, None


def column_of(r, columns, split) -> int:
    if columns == 1:
        return 0
    if r[0] < split - 10 and r[2] > split + 10:
        return -1
    return 0 if (r[0] + r[2]) / 2 < split else 1


# --------------------------------------------------------------------------- #
# Figures and tables (§5.2.1)
# --------------------------------------------------------------------------- #
def _clip(r, s):
    r = (max(r[0], s[0]), max(r[1], s[1]), min(r[2], s[2]), min(r[3], s[3]))
    return r if r[2] >= r[0] and r[3] >= r[1] else None


def graphics(page, width, height) -> list[tuple]:
    """Image and vector-path rects, clipped by the PDF clip paths (plots often draw far outside their axes)."""
    page_rect = (0.0, 0.0, width, height)
    rects, clips = [tuple(i["bbox"]) for i in page.get_image_info()], []
    for d in page.get_drawings(extended=True):
        level = d.get("level", 0)
        while clips and clips[-1][0] >= level:
            clips.pop()
        if d["type"] == "clip":
            clips.append((level, tuple(d["scissor"])))
        elif d["type"] != "group":
            r = tuple(d["rect"])
            for _, s in clips:
                r = r and _clip(r, s)
            if r:
                rects.append(r)
    rects = (_clip(r, page_rect) for r in rects)
    return sorted(r for r in rects if r and not (r[2] - r[0] >= 0.95 * width and r[3] - r[1] >= 0.95 * height))


def cluster(rects) -> list[dict]:
    """Merge graphics whose CLUSTER_PAD-expanded rects overlap (bbox-based, so it stays fast on dense plots)."""
    clusters = []
    for r in rects:
        merged = {"bbox": r, "n": 1, "used": False}
        rest = []
        for c in clusters:
            if _touch(c["bbox"], merged["bbox"], 2 * CLUSTER_PAD):
                merged = {"bbox": _union(c["bbox"], merged["bbox"]), "n": c["n"] + merged["n"], "used": False}
            else:
                rest.append(c)
        clusters = rest + [merged]
    changed = True
    while changed:
        changed = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if _touch(clusters[i]["bbox"], clusters[j]["bbox"], 2 * CLUSTER_PAD):
                    a, b = clusters[i], clusters.pop(j)
                    a["bbox"], a["n"] = _union(a["bbox"], b["bbox"]), a["n"] + b["n"]
                    changed = True
                    break
            if changed:
                break
    return [c for c in clusters if _area(c["bbox"]) >= MIN_CLUSTER_AREA or c["n"] >= MIN_CLUSTER_PATHS]


def _free_text(b) -> bool:
    """Text that may belong to a figure: not a caption, header/footer, prose, or another figure's text."""
    return b["kind"] is None and b["figure_id"] is None and not b.get("caption") and not is_prose(b)


def _figure_from_clusters(cap, blocks, clusters, above: bool):
    cb = cap["cbox"]

    def beside(r):  # text: entirely on the requested side of the caption
        return r[3] <= cb[1] + 4 if above else r[1] >= cb[3] - 4

    def mostly_beside(r):  # graphics often overlap the caption by a few points
        return (r[1] < cb[1] and (r[1] + r[3]) / 2 <= cb[1]) if above else (r[3] > cb[3] and (r[1] + r[3]) / 2 >= cb[3])

    def prose_between(r):
        lo, hi = (r[3], cb[1]) if above else (cb[3], r[1])
        return any(b is not cap and (is_prose(b) or b.get("caption")) and _xover(b["bbox"], cb) >= 0.3
                   and b["bbox"][1] >= lo - 1 and b["bbox"][3] <= hi + 1 for b in blocks)

    cands = [c for c in clusters if not c["used"] and mostly_beside(c["bbox"]) and _xover(c["bbox"], cb) >= 0.3
             and not prose_between(c["bbox"])]
    if not cands:
        return None
    best = max(cands, key=lambda c: c["bbox"][3]) if above else min(cands, key=lambda c: c["bbox"][1])
    best["used"] = True
    bbox, members = best["bbox"], []

    def same_row(r):  # e.g. the other half of a two-column-wide figure
        return r[1] <= bbox[3] + 15 and bbox[1] <= r[3] + 15 and _xover(r, cb) >= 0.3 and not prose_between(r)

    changed = True
    while changed:
        changed = False
        for c in clusters:
            if not c["used"] and mostly_beside(c["bbox"]) and _xover(c["bbox"], cb) >= 0.3 \
                    and (_touch(bbox, c["bbox"], 15) or same_row(c["bbox"])):
                c["used"], bbox, changed = True, _union(bbox, c["bbox"]), True
        for b in blocks:
            if b not in members and _free_text(b) and beside(b["bbox"]) and _touch(bbox, b["bbox"], CLUSTER_PAD):
                members.append(b)
                bbox, changed = _union(bbox, b["bbox"]), True
    # never extend into the caption
    return (bbox[0], bbox[1], bbox[2], min(bbox[3], cb[1])) if above else (bbox[0], max(bbox[1], cb[3]), bbox[2], bbox[3])


def _table_from_text(cap, blocks, rects, col_range, spanning_caption, below: bool):
    cb = cap["cbox"]
    lo, hi = col_range
    order = sorted((b for b in blocks if b is not cap and (b["bbox"][1] >= cb[3] - 2 if below else b["bbox"][3] <= cb[1] + 2)),
                   key=lambda b: b["bbox"][1] if below else -b["bbox"][3])
    taken, edge, first_gap = [], cb[3] if below else cb[1], None
    for b in order:
        r = b["bbox"]
        if b["column"] == -1 and not spanning_caption:
            break                                   # band end
        if not (r[0] >= lo - 5 and r[2] <= hi + 5) or _xover(r, cb) < 0.3:
            continue                                # other column, or a table beside this one
        gap = r[1] - edge if below else edge - r[3]
        long_lines = len(b["lines"]) >= 2 and b["words"] / len(b["lines"]) > 8   # prose cut by a column/math break
        if b.get("caption") or b["kind"] == "header_footer" or long_lines or HEADING_NUM_RE.match(b["text"]) \
                or gap > 30 or b["figure_id"]:
            break
        taken.append(b)
        first_gap = gap if first_gap is None else first_gap
        edge = r[3] if below else r[1]
    if not taken:
        return None, False, None
    bbox = taken[0]["bbox"]
    for b in taken[1:]:
        bbox = _union(bbox, b["bbox"])
    # rules and cell shading: one pass over a fixed region (growing iteratively chains into nearby math and figures)
    text_box, ruled = bbox, False
    for r in rects:
        if text_box[1] - 12 <= r[1] and r[3] <= text_box[3] + 12 and lo - 5 <= r[0] and r[2] <= hi + 5 \
                and text_box[0] - CLUSTER_PAD <= (r[0] + r[2]) / 2 <= text_box[2] + CLUSTER_PAD:
            bbox, ruled = _union(bbox, r), True
    return bbox, ruled, first_gap


def _fallback(cap, blocks, col_range):
    """Rectangle between the caption and the nearest prose block above (else below), caption column width."""
    cb, (lo, hi) = cap["cbox"], col_range
    prose = [b["bbox"] for b in blocks if b is not cap and is_prose(b) and _xover(b["bbox"], (lo, 0, hi, 1)) >= 0.5]
    above = [r[3] for r in prose if r[3] <= cb[1]]
    top = max(above) if above else 0.0
    if cb[1] - top >= 20:
        return (lo, top, hi, cb[1])
    below = [r[1] for r in prose if r[1] >= cb[3]]
    bottom = min(below) if below else None
    if bottom is not None and bottom - cb[3] >= 20:
        return (lo, cb[3], hi, bottom)
    return None


def detect_figures(page_no, blocks, rects, width, height, columns, split) -> list[dict]:
    if columns == 2:  # graphics in neighbouring columns must not merge across the gutter
        groups = [[r for r in rects if r[2] <= split + 3], [r for r in rects if r[0] >= split - 3],
                  [r for r in rects if r[0] < split - 3 and r[2] > split + 3]]
        clusters = [c for g in groups for c in cluster(g)]
    else:
        clusters = cluster(rects)
    found = []
    caps = sorted((b for b in blocks if b.get("caption")), key=lambda b: (b["bbox"][1], b["bbox"][0]))
    for cap in caps:
        kind, label, number = cap["caption"]
        col = cap["column"]
        col_range = (0.0, width) if col == -1 or columns == 1 else ((0.0, split) if col == 0 else (split, width))
        bbox, conf = None, 0.9
        if kind == "figure":
            bbox = _figure_from_clusters(cap, blocks, clusters, above=True) or _figure_from_clusters(cap, blocks, clusters, above=False)
        else:  # captions sit above or below their table: take the side whose first row is closer
            sides = [_table_from_text(cap, blocks, rects, col_range, col == -1, below) for below in (True, False)]
            sides = [s for s in sides if s[0]]
            if sides:
                bbox, ruled, _ = min(sides, key=lambda s: s[2])
                conf = 0.9 if ruled else 0.6
        if not bbox:
            bbox, conf = _fallback(cap, blocks, col_range), 0.4
        if not bbox:
            continue
        found.append({"kind": kind, "label": label, "number": number, "bbox": bbox, "caption": cap, "confidence": conf})
        # claim member blocks now so the next caption's search does not take them
        for b in blocks:
            if b is not cap and b["kind"] is None and b["figure_id"] is None and not b.get("caption") and _center_in(b["bbox"], bbox):
                b["figure_id"] = "?"
    for c in clusters:
        if not c["used"] and _area(c["bbox"]) >= UNLABELED_MIN_SHARE * width * height:
            found.append({"kind": "figure", "label": None, "number": None, "bbox": c["bbox"], "caption": None, "confidence": 0.5})
    for b in blocks:
        if b["figure_id"] == "?":
            b["figure_id"] = None
    labeled = sorted((f for f in found if f["label"]), key=lambda f: (f["bbox"][1], f["bbox"][0]))
    unlabeled = sorted((f for f in found if not f["label"]), key=lambda f: (f["bbox"][1], f["bbox"][0]))
    for k, f in enumerate(labeled):
        f["id"] = f"fig-p{page_no}-{k}"
    for k, f in enumerate(unlabeled):
        f["id"] = f"fig-p{page_no}-u{k}"
    return labeled + unlabeled


# --------------------------------------------------------------------------- #
# Block repair: PyMuPDF sometimes cuts one paragraph into blocks of a line or two, and one display equation into
# fragments (symbols, sub/superscripts, the number). Both are joined back after classification.
# --------------------------------------------------------------------------- #
def line_pitch(pages_blocks) -> float:
    """Median top-to-top distance of consecutive lines inside blocks: the body line spacing."""
    gaps = sorted(round(l2[1] - l1[1], 1) for blocks in pages_blocks for b in blocks
                  for l1, l2 in zip(b["line_boxes"], b["line_boxes"][1:]) if l2[1] - l1[1] > 0.5 * b["font_size"])
    return gaps[len(gaps) // 2] if gaps else 0.0


def _absorb(a, b, kind=None) -> None:
    """Merge block b into a (a keeps its id)."""
    chars = a["chars"] + b["chars"]
    for key in ("font_size", "math"):
        a[key] = (a[key] * a["chars"] + b[key] * b["chars"]) / chars
    a["bold"] = a["bold"] and b["bold"]
    a["bbox"], a["chars"], a["sizes"] = _union(a["bbox"], b["bbox"]), chars, a["sizes"] + b["sizes"]
    a["lines"], a["line_boxes"] = a["lines"] + b["lines"], a["line_boxes"] + b["line_boxes"]
    a["text"] = join_lines([a["text"], b["text"]])
    a["words"] = len(a["text"].split())
    a["kind"] = kind or a["kind"]


def _hanging(b) -> bool:
    """Lines after the first start right of it (reference entries)."""
    lb = b["line_boxes"]
    return len(lb) > 1 and min(l[0] for l in lb[1:]) > lb[0][0] + 3


def _continues(a, b, pitch) -> bool:
    """b is the next piece of paragraph a: same column and font, body line spacing, b not indented, and a's last
    line reaches the right edge (a paragraph's last line is usually short)."""
    if a["kind"] != "paragraph" or b["kind"] != "paragraph" or a["column"] != b["column"] or _hanging(a) or _hanging(b):
        return False
    last, first = a["line_boxes"][-1], b["line_boxes"][0]
    left = min(l[0] for l in a["line_boxes"])
    right = max(a["bbox"][2], b["bbox"][2])
    return (abs(a["font_size"] - b["font_size"]) <= 0.6 and 0 < first[1] - last[1] <= 1.25 * pitch
            and abs(first[0] - left) <= 3 and last[2] >= right - 12)


def merge_paragraphs(blocks, pitch) -> list[dict]:
    if not pitch:
        return blocks
    out = []
    for b in sorted(blocks, key=lambda b: (b["column"], b["bbox"][1], b["bbox"][0])):
        if out and _continues(out[-1], b, pitch):
            _absorb(out[-1], b)
        else:
            out.append(b)
    return out


def _fragment(b) -> bool:
    return (b["kind"] in ("equation", "paragraph", "list", "heading") and len(b["lines"]) <= 3
            and b["chars"] <= EQ_FRAGMENT_CHARS and len(WORD_RE.findall(b["text"])) < EQ_FRAGMENT_WORDS)


def group_equations(blocks, columns, split) -> list[dict]:
    """Touching short fragments with math in them become one equation block (shown as one crop in the viewer)."""
    def near(r, q):
        return r[0] <= q[2] + EQ_PAD[0] and q[0] <= r[2] + EQ_PAD[0] and r[1] <= q[3] + EQ_PAD[1] and q[1] <= r[3] + EQ_PAD[1]

    groups: list[tuple[tuple, list[dict]]] = []  # (box of the members, members): limits under a sum join its box
    for b in sorted((b for b in blocks if _fragment(b)), key=lambda b: b["k"]):
        box, members = b["bbox"], [b]
        while hit := [g for g in groups if near(box, g[0])]:
            groups = [g for g in groups if g not in hit]
            for g in hit:
                box, members = _union(box, g[0]), members + g[1]
        groups.append((box, members))
    groups = [g for _, g in groups]
    gone = set()
    for g in groups:
        if len(g) < 2 or not any(o["kind"] == "equation" or o["math"] >= 0.2 or MATH_CHAR_RE.search(o["text"]) for o in g):
            continue
        g.sort(key=lambda o: (o["bbox"][0], o["bbox"][1]))  # left to right; the text is not shown
        head = min(g, key=lambda o: o["k"])
        for o in g:
            if o is not head:
                _absorb(head, o)
                gone.add(id(o))
        head["kind"], head["column"] = "equation", column_of(head["bbox"], columns, split)
    return [b for b in blocks if id(b) not in gone]


# --------------------------------------------------------------------------- #
# Classification and reading order
# --------------------------------------------------------------------------- #
def classify(b, body) -> str:
    if b["math"] >= 0.4 or (len(b["lines"]) <= 3 and any(EQ_NUM_RE.search(l) and len(l) <= 60 for l in b["lines"])):
        return "equation"
    if len(b["lines"]) <= 2 and b["words"] <= 15 and (b["font_size"] >= 1.1 * body or b["bold"] or HEADING_NUM_RE.match(b["text"])):
        return "heading"
    if LIST_RE.match(b["text"]):
        return "list"
    return "paragraph"


def reading_order(items, columns) -> list:
    """items: dicts with bbox/column. Column-spanning items split the page into bands; each band is read col 0, then col 1."""
    items = sorted(items, key=lambda it: (it["bbox"][1], it["bbox"][0]))
    if columns == 1:
        return items
    out, band = [], []

    def flush():
        out.extend(sorted((it for it in band if it["column"] == 0), key=lambda it: (it["bbox"][1], it["bbox"][0])))
        out.extend(sorted((it for it in band if it["column"] == 1), key=lambda it: (it["bbox"][1], it["bbox"][0])))
        band.clear()

    for it in items:
        if it["column"] == -1:
            flush()
            out.append(it)
        else:
            band.append(it)
    flush()
    return out


def outline(doc, pages) -> list[dict]:
    """The PDF outline when present, otherwise heading blocks (numbering depth = level)."""
    headings = {p["page"]: [b for b in p["blocks"] if b["kind"] == "heading"] for p in pages}
    toc = [t for t in doc.get_toc(simple=True) if 1 <= t[2] <= len(pages)]
    if toc:
        result = []
        for level, title, page in toc:
            key = re.sub(r"\s+", "", title.lower())[:30]
            match = next((b["id"] for b in headings[page] if key and re.sub(r"\s+", "", b["text"].lower()).startswith(key)), None)
            result.append({"title": title.strip(), "page": page, "level": level, "block_id": match})
        return result
    result = []
    for p in pages:
        for b in headings[p["page"]]:
            m = re.match(r"^(\d+(?:\.\d+)*)\.?\s", b["text"])
            level = m.group(1).count(".") + 1 if m else 2 if re.match(r"^[A-H]\.\s", b["text"]) else 1
            result.append({"title": b["text"], "page": p["page"], "level": level, "block_id": b["id"]})
    return result


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #
def _out_rect(page, r):
    """Unrotated analysis space -> displayed page space."""
    if not page.rotation:
        return r
    return tuple(pymupdf.Rect(r) * page.rotation_matrix)


def _in_rect(page, r):
    if not page.rotation:
        return tuple(r)
    return tuple(pymupdf.Rect(r) * ~page.rotation_matrix)


def analyze(pdf: Path, overrides: dict, translate_references: bool) -> tuple[dict, dict]:
    """Return (blocks.json data, figures.json data)."""
    doc = pymupdf.open(pdf)
    sizes = [(p.cropbox.width, p.cropbox.height) for p in doc]      # unrotated analysis space
    pages_blocks = [raw_blocks(p) for p in doc]
    body = body_font_size(pages_blocks)
    pitch = line_pitch(pages_blocks)
    mark_header_footer(pages_blocks, [h for _, h in sizes])

    pages, figures, in_refs = [], [], False
    for pno, (page, blocks) in enumerate(zip(doc, pages_blocks), start=1):
        width, height = sizes[pno - 1]
        for b in blocks:
            info = caption_info(b) if b["kind"] is None else None
            if info:
                b["caption"], b["cbox"] = info
        columns, split = detect_columns(blocks, width, body)
        for b in blocks:
            b["column"] = -1 if b["kind"] == "header_footer" else column_of(b["bbox"], columns, split)
            b["id"] = f"p{pno}-b{b['k']}"

        figs = detect_figures(pno, blocks, graphics(page, width, height), width, height, columns, split)
        for f in figs:
            if f["id"] in overrides:
                f["bbox"], f["bbox_source"] = _in_rect(page, overrides[f["id"]]), "manual"
            f["column"] = column_of(f["bbox"], columns, split)
            kind = "table_text" if f["kind"] == "table" else "figure_text"
            if f["caption"]:
                f["caption"]["figure_id"] = f["id"]
            for b in blocks:
                if b["kind"] is None and not b.get("caption") and b["figure_id"] is None and _center_in(b["bbox"], f["bbox"]):
                    b["kind"], b["figure_id"] = kind, f["id"]
        for b in blocks:
            if b["kind"] is None:
                b["kind"] = "caption" if b.get("caption") else classify(b, body)
        blocks = group_equations(merge_paragraphs(blocks, pitch), columns, split)  # prose first: its lines are not fragments

        # reading order: figure regions stand in for their member blocks
        members = {f["id"]: sorted((b for b in blocks if b["kind"] in ("figure_text", "table_text") and b["figure_id"] == f["id"]),
                                   key=lambda b: (b["bbox"][1], b["bbox"][0])) for f in figs}
        items = [b for b in blocks if b["kind"] not in ("figure_text", "table_text")] + [{**f, "is_figure": True} for f in figs]
        ordered = []
        for it in reading_order(items, columns):
            ordered.extend(members[it["id"]] if it.get("is_figure") else [it])
        for i, b in enumerate(ordered):
            b["order"] = i

        # references: everything after a References heading until the next font-based heading
        for b in ordered:
            if b["kind"] in ("header_footer", "caption", "figure_text", "table_text", "equation"):
                continue
            if REFS_HEAD_RE.match(b["text"]):
                in_refs, b["kind"] = True, "heading"
            elif in_refs:
                big = len(b["lines"]) <= 2 and b["words"] <= 15 and (b["font_size"] >= 1.1 * body or b["bold"])
                if big:
                    in_refs, b["kind"] = False, "heading"
                else:
                    b["kind"] = "reference"

        out_blocks = []
        for b in ordered:
            out_blocks.append({
                "id": b["id"], "kind": b["kind"], "bbox": _r2(_out_rect(page, b["bbox"])),
                "column": b["column"] if not page.rotation else 0, "order": b["order"],
                "font_size": round(b["font_size"], 2), "bold": b["bold"], "text": b["text"],
                "translate": b["kind"] in TRANSLATE_KINDS or (b["kind"] == "reference" and translate_references),
                "figure_id": b["figure_id"],
            })
        out_size = (page.rect.width, page.rect.height)
        pages.append({
            "page": pno, "width": round(out_size[0], 2), "height": round(out_size[1], 2), "rotation": page.rotation,
            "columns": columns if not page.rotation else 1,
            "column_split": round(split, 2) if split is not None and not page.rotation else None,
            "body_font_size": round(body, 2), "blocks": out_blocks,
        })
        for f in figs:
            cap = f["caption"]
            figures.append({
                "id": f["id"], "kind": f["kind"], "label": f["label"], "number": f["number"], "page": pno,
                "bbox": _r2(_out_rect(page, f["bbox"])), "caption_block": cap["id"] if cap else None,
                "caption": cap["text"] if cap else None, "image": f"layout/figures/{f['id']}.png", "refs": [],
                "bbox_source": f.get("bbox_source", "auto"), "confidence": f["confidence"],
            })

    by_key = {(f["kind"], f["number"]): f for f in figures if f["number"] is not None}
    for p in pages:
        for b in p["blocks"]:
            for m in REF_RE.finditer(b["text"]):
                kind = "table" if m.group(1).lower().startswith("tab") else "figure"
                f = by_key.get((kind, _number(m.group(2))))
                ref = {"page": p["page"], "block": b["id"]}
                if f and b["id"] != f["caption_block"] and ref not in f["refs"]:
                    f["refs"].append(ref)
    data = {"version": VERSION, "pdf": pdf.name, "pages": pages, "outline": outline(doc, pages)}
    return data, {"version": VERSION, "figures": figures}


def write_sources(data: dict, tr_dir: Path) -> None:
    """translate/pNNN.src.md for every page with translatable blocks; stale .src.md files are removed."""
    tr_dir.mkdir(parents=True, exist_ok=True)
    wanted = set()
    for p in data["pages"]:
        blocks = [b for b in p["blocks"] if b["translate"]]
        if not blocks:
            continue
        path = tr_dir / f"p{p['page']:03d}.src.md"
        wanted.add(path.name)
        body = "".join(f"<!-- BLOCK {b['id']} kind={b['kind']} -->\n{b['text']}\n\n" for b in blocks)
        path.write_text(f"<!-- PAGE {p['page']} -->\n{body}", encoding="utf-8")
    for old in tr_dir.glob("p*.src.md"):
        if old.name not in wanted:
            old.unlink()


def render_crops(pdf: Path, figures: list[dict], fig_dir: Path) -> None:
    fig_dir.mkdir(parents=True, exist_ok=True)
    for old in fig_dir.glob("*.png"):
        old.unlink()
    doc = pymupdf.open(pdf)
    for f in figures:
        clip = pymupdf.Rect(f["bbox"]) & doc[f["page"] - 1].rect
        if not clip.is_empty:
            doc[f["page"] - 1].get_pixmap(clip=clip, dpi=CROP_DPI).save(fig_dir / f"{f['id']}.png")


def _summary(blocks: dict, figures: dict, skipped: bool) -> dict:
    figs = figures["figures"]
    return {"pages": len(blocks["pages"]), "blocks": sum(len(p["blocks"]) for p in blocks["pages"]),
            "figures": len(figs), "low_conf": sum(f["confidence"] < 0.6 for f in figs), "skipped": skipped}


def _dump(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, indent=1) + "\n"


def build_layout(paper_dir: Path, force: bool = False) -> dict:
    """Analyze the paper's PDF unless blocks.json is newer than the PDF and the bbox overrides. Returns a summary."""
    paper_dir = paper_dir.resolve()
    pdf = find_pdf(paper_dir)
    if pdf is None:
        raise FileNotFoundError(f"no PDF in {paper_dir}")
    work = paper_dir / WORK_DIR
    lay = work / "layout"
    blocks_path, figures_path = lay / "blocks.json", lay / "figures.json"
    overrides_path = work / "viewer" / "figure_overrides.json"
    inputs = [pdf] + ([overrides_path] if overrides_path.exists() else [])
    if not force and blocks_path.exists() and figures_path.exists() and \
            all(blocks_path.stat().st_mtime >= p.stat().st_mtime for p in inputs):
        return _summary(json.loads(blocks_path.read_text(encoding="utf-8")),
                        json.loads(figures_path.read_text(encoding="utf-8")), skipped=True)

    overrides = json.loads(overrides_path.read_text(encoding="utf-8")) if overrides_path.exists() else {}
    blocks, figures = analyze(pdf, overrides, bool(viewer_cfg()["translate_references"]))
    lay.mkdir(parents=True, exist_ok=True)
    render_crops(pdf, figures["figures"], lay / "figures")
    write_sources(blocks, work / "translate")
    figures_path.write_text(_dump(figures), encoding="utf-8")
    blocks_path.write_text(_dump(blocks), encoding="utf-8")   # last: its mtime marks the layout as complete
    return _summary(blocks, figures, skipped=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="PDF layout analysis for the paper viewer")
    parser.add_argument("paper", help="paper folder path, folder name, or path relative to the output root")
    parser.add_argument("--force", action="store_true", help="re-run even if the layout is up to date")
    args = parser.parse_args()
    try:
        folder = resolve_for_annotate(args.paper)
        print(f"[layout] folder: {folder}")
        print(f"[layout] target_lang: {target_lang()}")
        s = build_layout(folder, args.force)
    except (FileNotFoundError, ValueError) as e:
        print(f"[layout] ERROR: {e}", file=sys.stderr)
        return 1
    note = " (up to date)" if s["skipped"] else ""
    print(f"[layout] pages={s['pages']} blocks={s['blocks']} figures={s['figures']} low_conf={s['low_conf']}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
