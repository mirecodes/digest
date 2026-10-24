# Paper Viewer — Implementation Plan (for coding agent)

> **읽는 사람: coding agent.** 이 문서와 `implementation.md`를 처음부터 끝까지 읽은 뒤, §13의 Phase 순서대로 구현한다.
> 각 Phase의 Acceptance를 전부 통과해야 다음 Phase로 넘어간다. 애매한 점은 §14 규칙대로 스스로 결정하고 기록한 뒤 계속 진행한다.
> 기존 digest 파이프라인(`implementation.md` §1–7)의 동작은 바꾸지 않는다 (Phase 0의 리팩터 제외).

---

## 0. 목표와 원칙

digest 파이프라인이 만든 논문 폴더를 **로컬 웹앱**에서 열어 읽고 분석한다.

1. **2-pane 리더**: 왼쪽 원문 PDF, 오른쪽 블록 단위 한국어 번역. 두 패널은 **페이지 단위로 싱크되어 같이 스크롤**된다.
2. **자동 하이라이트**: 논문의 문제·기여·핵심 아이디어·방법·결과·한계를 카테고리 색으로 표시.
3. **Figure/Table 호버 해설**: 피규어 영역에 마우스를 올리면 해석 popover가 뜬다.
4. **선택 설명/번역, 영역 설명, 논문 기반 채팅** (Moonlight의 Explanation/Translation/Chat).
5. **마크업과 저장**: 사용자 하이라이트·메모, Obsidian 노트(`.md`)와 주석 PDF 내보내기.

원칙

| # | 원칙 | 구체적 의미 |
|---|---|---|
| P1 | **evidence first 유지** | 미리 생성하는 AI 산출물(번역, 하이라이트, 피규어 해설)은 파일로 저장되고 Python이 검증한다. 하이라이트는 원문 그대로의 quote여야 하며 PDF 좌표에 **앵커링되지 않으면 ERROR**. 피규어 해설의 수치는 `[E#, p.N]` 또는 `[FIG: id]`/`[INTERP]` 마커 필수. |
| P2 | **기존 분업 유지** | 결정적 작업(레이아웃 분석, 좌표 계산, 검증, 번들 빌드, 서버) = Python. 읽기·번역·선정·해설 = Claude (Claude Code skill 또는 LLM 백엔드). |
| P3 | **실시간 AI 응답은 출처 표시 강제** | 설명·채팅은 사전 검증이 불가능하므로 `[p.N]` 링크를 강제하고, 응답 속 인용문을 `pages.md`와 대조해 ✓/⚠ 배지를 단다. |
| P4 | **로컬 전용** | `127.0.0.1` 바인딩, 계정·클라우드·공유 서버 없음. 모든 상태는 논문 폴더의 `.work/` 안에. |
| P5 | **graceful degradation** | 번역/하이라이트/해설이 없어도 리더는 열린다. 없는 기능 자리에는 "생성" 버튼을 둔다. 레이아웃(`blocks.json`)은 결정적이고 빠르므로 서버가 필요할 때 자동 생성한다. |

---

## 1. Moonlight 기능 매핑

| Moonlight | 이 프로젝트 구현 | 사전 생성? | Phase |
|---|---|---|---|
| Explanation · Text (선택 → 설명) | 선택 툴바 `설명` → 우측 drawer에 스트리밍 설명, 이어서 질문 가능 | 실시간 | 5 |
| Explanation · Image (이미지 하단 아이콘, Cmd/Ctrl+Drag) | 피규어 **호버 popover**(사전 생성) + 피규어 하단 `ⓘ` 배지 + Cmd/Ctrl+Drag 영역 설명(실시간, 영역 crop 이미지 전송) | 둘 다 | 4, 5 |
| Auto Highlight | evidence.md + highlights.md → PDF 좌표 앵커링 → 카테고리 색 레이어, 헤더 토글, 사이드바 목록 | 사전 | 3, 4 |
| Translation (선택 / 전체 페이지) | 전체 번역은 오른쪽 패널(블록 단위, 페이지 싱크). 선택 번역은 툴바 `번역`. 번역 없는 페이지는 `이 페이지 번역` 버튼 | 둘 다 | 2, 3, 5 |
| Chat | drawer의 `채팅` 탭. 논문 전문을 컨텍스트로, `[p.N]` 클릭 시 해당 페이지로 이동, 인용 검증 배지 | 실시간 | 5 |
| Navigation | 아웃라인, 피규어 목록, 하이라이트 목록, 블록 검색, 페이지 이동, 블록 상호 링크, (Phase 7) 참고문헌 `[12]` 호버 미리보기 | — | 2, 4, 7 |
| Mark Up | 사용자 하이라이트(색), 메모 | — | 6 |
| Save & Share | `<name> - notes.md` (Obsidian용, `[[name.pdf#page=N]]` 링크), `<name> - annotated.pdf` | — | 6 |

**범위 밖**: 계정, 클라우드 동기화, 링크 공유, 다중 사용자, 모바일 레이아웃, OCR.

---

## 2. 기술 스택과 결정

| 영역 | 선택 | 이유 |
|---|---|---|
| 백엔드 | FastAPI + uvicorn (`.venv`) | 기존 Python 모듈 재사용, SSE 스트리밍 간단 |
| PDF 렌더 | `pdfjs-dist` (버전 고정) — canvas + text layer | 텍스트 선택이 필요하므로 이미지 렌더 불가. 좌표는 PyMuPDF와 같은 PDF point 공간 |
| 프론트엔드 | React 18 + TypeScript + Vite, 상태는 `zustand` | 오버레이/팝오버/스크롤 싱크 상태가 많음 |
| Markdown | `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` | AI 설명의 수식 렌더 |
| 레이아웃 분석 | PyMuPDF 휴리스틱 (`get_text("dict")`, `get_drawings()`, `get_image_info()`) | 사용자는 PyMuPDF 유지 결정. 새 PDF 파서 추가 금지 |
| LLM | 백엔드 추상화: `claude_cli` (기본, Claude Code 구독) / `anthropic_api` / `fake` (테스트) | 기존 워크플로가 Claude Code 기반 |
| 테스트 | Python: 기존 `selftest.py` 확장 (+ FastAPI `TestClient`). Web: `vitest`, `@playwright/test` | 실제 LLM 호출 없이 전부 돌아야 함 |

Node ≥ 20은 **빌드에만** 필요. 빌드 산출물 `web/dist/`를 FastAPI가 정적 파일로 서빙한다.

---

## 3. 디렉터리 추가분

```
requirements.txt                 + fastapi, uvicorn[standard], httpx (TestClient), anthropic (optional backend)
configs/cfg.yaml                 + viewer: 섹션 (§11)
functions/
  textmatch.py                   [Phase 0] verify.py에서 분리: loose(), find_quote_pages() 등
  fixtures.py                    [Phase 0] 합성 논문 PDF 생성기 (selftest·e2e 공용)
  papers.py                      [Phase 1] out_root 스캔, paper id, 폴더 상태 조사
  layout.py                      [Phase 1] PDF → blocks.json, figures.json, figure crops, translate/*.src.md
  anchor.py                      [Phase 1] quote → PDF 좌표 rect 목록
  annotations.py                 [Phase 3] highlights.md / figure_notes.md / translate/*.ko.md 파서
  verify_annotations.py          [Phase 3] 번역·하이라이트·피규어 해설 검증
  build_viewer.py                [Phase 2→3] 모든 산출물 → .work/viewer.json 번들
  viewer/
    __init__.py
    server.py                    [Phase 2] FastAPI app, 정적 파일, REST + SSE
    jobs.py                      [Phase 3] annotate 서브프로세스 큐, 로그 SSE
    llm.py                       [Phase 5] LLMBackend: claude_cli / anthropic_api / fake
    context.py                   [Phase 5] 프롬프트 컨텍스트 조립 (논문 본문, 위치, 선택)
    grounding.py                 [Phase 5] 응답 속 인용문/[p.N] 검증
    export.py                    [Phase 6] notes.md, annotated.pdf
    prompts/*.md                 [Phase 5] 프롬프트 템플릿 (영어)
scripts/
  viewer.sh [--dev] [--port N]   [Phase 2] 서버 실행 (+ 브라우저 열기)
  annotate.sh [-n NAME]          [Phase 3] headless Claude Code로 /paper-annotate 실행 (digest.sh와 같은 구조)
  internal/
    layout.sh / anchor_check.sh / verify_annotations.sh / build_viewer.sh   얇은 wrapper
    viewer_test.sh               [Phase 2] vitest + playwright
.claude/skills/paper-annotate/
  SKILL.md                       [Phase 3] 영어. 번역·하이라이트·피규어 해설 절차
  templates/highlights.md
  templates/figure_notes.md
  templates/translation.md
web/
  package.json, package-lock.json, vite.config.ts, tsconfig.json, index.html
  src/
    main.tsx, App.tsx, i18n.ts (UI 문자열 ko 기본, en)
    types.ts                     viewer.json 스키마의 TS 미러 (§4.8)
    api/client.ts, api/sse.ts
    pages/Library.tsx, pages/Reader.tsx
    reader/  HeaderBar, Sidebar, PdfPane, PdfPage, TranslationPane, TranslationPage,
             HighlightLayer, FigureLayer, FigurePopover, BlockLinkLayer,
             SelectionToolbar, RegionSelect, Drawer(ExplainTab, ChatTab), CitationText
    lib/     coords.ts, scrollSync.ts, hitTest.ts, citations.ts, store.ts
  tests/unit/*.test.ts, tests/e2e/*.spec.ts
  dist/                          빌드 산출물 (git 제외)
tests/fixtures/
  viewer.sample.json             golden 번들 (selftest가 재생성 후 비교)
docs/
  viewer-plan.md                 이 문서
  decisions.md                   에이전트가 내린 설계 결정 로그 (ADR, 한 결정당 3–5줄)
```

`.gitignore`에 `web/node_modules/`, `web/dist/`, `web/test-results/`, `web/playwright-report/` 추가.

---

## 4. 논문별 데이터 산출물

```
<paper folder>/
  <name>.pdf, <name> - report.md, <name> - summary.md      (기존)
  <name> - notes.md              [Phase 6] 내보내기 (Obsidian에서 보임)
  <name> - annotated.pdf         [Phase 6] 내보내기
  .work/
    pages.md, captions.md, evidence.md                     (기존)
    layout/blocks.json           [Phase 1] Python
    layout/figures.json          [Phase 1] Python
    layout/figures/<fid>.png     [Phase 1] Python (200 dpi crop)
    layout/crops/<hash>.png      [Phase 2] 서버 캐시 (수식 블록, 임의 영역)
    translate/glossary.md        [Phase 3] Claude
    translate/p003.src.md        [Phase 1] Python (번역 원본, 블록 마커 포함)
    translate/p003.ko.md         [Phase 3] Claude (또는 Phase 5 페이지 번역)
    highlights.md                [Phase 3] Claude (H 블록)
    figure_notes.md              [Phase 3] Claude (F 블록)
    viewer.json                  [Phase 2+] Python 번들 (프론트엔드가 읽는 유일한 파일)
    viewer/annotations.json      [Phase 6] 사용자 하이라이트·메모
    viewer/figure_overrides.json [Phase 4] 사용자가 고친 피규어 bbox
    viewer/chats/<thread>.json   [Phase 5]
    viewer/cache/<sha256>.md     [Phase 5] 설명·번역 캐시
    viewer/jobs/<ts>.log         [Phase 3]
```

### 4.1 좌표계 규칙 (모든 단계 공통)

- 단위: **PDF point**, 원점 좌상단, y는 아래로 증가. PyMuPDF `page.rect` 기준(= cropbox).
- `bbox`/`rect`는 `[x0, y0, x1, y1]` 실수, 소수 둘째 자리 반올림.
- 페이지 번호는 **1-based** (pages.md의 `<!-- PAGE N -->`와 동일).
- 프론트엔드: `cssPx = pt * scale`, `scale = renderedPageWidthPx / page.width`. pdf.js viewport도 cropbox 기준이므로 일치해야 한다.
- 회전 페이지(`page.rotation != 0`): PyMuPDF 텍스트 좌표와 pdf.js 렌더 좌표가 일치하는지 **fixture로 실측**한다. 필요하면 `page.rotation_matrix`로 변환해 저장하고, 해결 못 하면 `pages[i].rotation`을 유지한 채 해당 페이지 오버레이를 끄고 WARN. 결정은 `docs/decisions.md`에 기록.

### 4.2 `layout/blocks.json`

```json
{
  "version": 1,
  "pdf": "Robust Recovery Controller Quadrupedal Robot (2019).pdf",
  "pages": [
    {
      "page": 1, "width": 612.0, "height": 792.0, "rotation": 0,
      "columns": 2, "column_split": 306.5, "body_font_size": 10.0,
      "blocks": [
        {
          "id": "p1-b0", "kind": "heading", "bbox": [72.0, 70.1, 540.0, 92.3],
          "column": -1, "order": 0, "font_size": 17.2, "bold": true,
          "text": "Robust Recovery Controller for a Quadrupedal Robot",
          "translate": true, "figure_id": null
        }
      ]
    }
  ]
}
```

- `id`: `p{page}-b{k}`, k는 PyMuPDF 원래 블록 순서 기준 (재실행해도 같은 PDF면 같은 ID — **결정적**이어야 한다).
- `kind`: `heading | paragraph | list | caption | equation | figure_text | table_text | header_footer | reference | other`.
- `column`: `0`, `1`, 또는 `-1`(두 단에 걸침).
- `order`: 페이지 내 읽기 순서 (0부터).
- `translate`: `heading | paragraph | list | caption`이면 true. `reference`는 `viewer.translate_references`에 따름. 나머지 false.
- `figure_id`: `figure_text`/`table_text`/`caption`이면 소속 피규어 ID.
- `text`: 줄을 공백으로 이어 붙이고, 줄 끝 `-` + 다음 줄 소문자 시작이면 하이픈 제거 후 붙임(dehyphenate).

### 4.3 `layout/figures.json`

```json
{
  "version": 1,
  "figures": [
    {
      "id": "fig-p3-0", "kind": "figure", "label": "Figure 2", "number": 2,
      "page": 3, "bbox": [70.0, 80.0, 300.0, 250.0],
      "caption_block": "p3-b4", "caption": "Figure 2: Overview of ...",
      "image": "layout/figures/fig-p3-0.png",
      "refs": [{"page": 2, "block": "p2-b7"}, {"page": 5, "block": "p5-b2"}],
      "bbox_source": "auto", "confidence": 0.9
    }
  ]
}
```

- `id`: `fig-p{page}-{k}` (페이지 내 위→아래 순). 캡션 없는 큰 그래픽은 `fig-p{page}-u{k}`, `label: null`.
- `kind`: `figure | table`. `label`은 `Fig. 3`/`Figure 3` → `Figure 3`, `Tab. 1` → `Table 1`로 정규화.
- `refs`: 모든 블록에서 `\b(Fig(?:ure)?s?\.?|Tables?|Tab\.)\s*(\d+)` 매치 중 같은 kind·number를 가리키는 블록 (캡션 자신 제외).
- `bbox_source`: `auto | manual`. `viewer/figure_overrides.json`(`{fid: bbox}`)이 있으면 layout 재실행 시 그 bbox를 쓰고 `manual`.

### 4.4 `translate/pNNN.src.md`, `translate/pNNN.ko.md`

Python이 페이지마다 `src`를 만든다 (`translate: true` 블록만, 읽기 순서대로). `NNN`은 3자리 0 패딩.

```
<!-- PAGE 3 -->
<!-- BLOCK p3-b2 kind=heading -->
3.1 Problem Formulation

<!-- BLOCK p3-b3 kind=paragraph -->
We formulate the recovery task as a Markov decision process ...
```

Claude(또는 Phase 5 페이지 번역)가 같은 마커로 `ko`를 쓴다:

```
<!-- BLOCK p3-b2 -->
3.1 문제 정식화 (Problem Formulation)

<!-- BLOCK p3-b3 -->
우리는 복구(recovery) 과제를 마르코프 결정 과정(Markov decision process, MDP)으로 정식화한다 ...
```

파서는 `<!-- BLOCK (\S+)` 마커 사이 텍스트를 strip해서 읽는다. 마커 뒤 속성은 무시.

### 4.5 `highlights.md` (Claude 작성)

evidence.md와 같은 블록 문법 (기존 파서 재사용 가능하게):

```
### H1
- category: contribution
- page: 2
- quote: "We propose a model-free controller that recovers from arbitrary falls"
- note_ko: 이 논문의 핵심 기여 — 임의 낙상에서의 복구를 하나의 정책으로 해결
- note_en: Core contribution — a single policy that recovers from arbitrary falls
```

> **변경 (decisions.md D4-7):** 하이라이트는 H 블록만, 큰 틀 카테고리 `problem | assumption | prior_work | contribution | method | result | insight | limitation`, 8–24개, 메모 = 한 줄 요약. evidence는 하이라이트하지 않는다. 아래 두 줄은 원래 계획이다.

- `category` ∈ `problem | contribution | insight | method | result | limitation`.
- 최종 하이라이트 = **evidence-derived** (evidence.md에서 category ∈ {problem, gap→problem, contribution, insight, method, result, ablation→result, limitation}, `NOT_REPORTED` 제외, `note`→`note_ko`) **+ H 블록**.
- H 블록은 evidence가 못 다룬 핵심 문장만 추가한다 (§6 밀도 규칙).

### 4.6 `figure_notes.md` (Claude 작성)

```
### F1
- figure: fig-p3-0
- status: OK
#### ko
요약: 제안 방법의 3단계 구조(상태 추정 → 정책 → 저수준 제어)를 보여주는 개요도.
읽는 법: 왼쪽에서 오른쪽으로 신호가 흐르며, 점선 상자는 학습되는 모듈이다.
- 정책은 관절 위치 목표를 50 Hz로 출력한다 [E14, p.4]
- 상태 추정기가 분리되어 있어 시뮬레이션→실물 전이를 돕는다는 것이 그림의 요지로 보인다 [INTERP]
본문 연결: C1(통합 복구 정책)의 구조적 근거.
#### en
Summary: Overview of the three-stage pipeline (state estimation → policy → low-level control).
How to read: ...
- The policy outputs joint position targets at 50 Hz [E14, p.4]
- ... [INTERP]
Link to text: structural basis for C1.
```

- 모든 피규어/테이블에 F 블록이 있어야 한다. 해설할 수 없으면 `- status: SKIP` + `- reason: ...`.
- `요약:`/`Summary:` 첫 줄 = popover 헤드라인 (ko ≤ 120자).
- 인용 마커: 기존 `[E#, p.N]`, `[CALC: …]`, `[INTERP]`, `[EXT]` + **신규 `[FIG: fid]`** = "그림에서 눈으로 읽은 근사값". 그래프에서 읽은 수치는 반드시 `[FIG: …]`.

### 4.7 `viewer/annotations.json` (사용자 상태)

```json
{
  "version": 1,
  "items": [
    {
      "id": "u_01J9...", "type": "highlight", "page": 3,
      "rects": [[72.0, 300.1, 290.2, 311.0]], "quote": "...",
      "color": "yellow", "note": "나중에 다시 볼 것",
      "created": "2026-10-04T10:00:00Z", "updated": "2026-10-04T10:00:00Z"
    }
  ]
}
```

`type`: `highlight | note`(점 메모, `rects` 1개 = 아이콘 위치) | `saved_explanation`(`body_md`, `context`).

### 4.8 `viewer.json` (번들 — 프론트엔드는 이것만 읽는다)

`build_viewer.py`가 결정적으로 만든다. 입력 파일 mtime이 번들보다 새로우면 서버가 요청 시 재빌드한다.

```ts
// web/src/types.ts 와 functions/build_viewer.py 가 같은 구조를 유지해야 한다
interface ViewerData {
  version: 1;
  built_at: string;
  paper: {
    id: string; name: string; folder_rel: string;     // out_root 기준 상대경로
    title: string | null; authors: string | null; venue_year: string | null; // report.md 헤더에서 파싱
    num_pages: number; pdf_url: string;
    digest_verify: "PASS" | "FAIL" | null;            // report.md "verify: PASS|FAIL"
  };
  pages: { page: number; width: number; height: number; rotation: number;
           columns: 1 | 2; column_split: number | null; body_font_size: number }[];
  blocks: { id: string; page: number; kind: string; bbox: Rect; column: -1 | 0 | 1;
            order: number; text: string; translate: boolean; tr: string | null;
            figure_id: string | null }[];
  figures: { id: string; page: number; kind: "figure" | "table"; label: string | null;
             bbox: Rect; caption_block: string | null; image_url: string;
             confidence: number; bbox_source: "auto" | "manual";
             refs: { page: number; block: string }[];
             note: null | { status: "OK" | "SKIP"; reason?: string;
                            ko?: { summary: string; body_md: string };
                            en?: { summary: string; body_md: string } } }[];
  highlights: { id: string; source: "evidence" | "highlight"; category: Category;
                page: number; rects: Rect[]; quote: string;
                note_ko: string | null; note_en: string | null }[];   // id: "E12" | "H3"
  evidence: Record<string, { page: number; loc: string | null; quote: string; category: string }>;
  outline: { title: string; page: number; level: number; block_id: string | null }[];
  status: {
    layout: boolean;
    translation: { done: number; total: number };
    highlights: number; figure_notes: { done: number; total: number };
    annotations_verify: "PASS" | "FAIL" | null; warnings: number;
  };
}
type Rect = [number, number, number, number];
type Category = "problem" | "contribution" | "insight" | "method" | "result" | "limitation";
```

---

## 5. Python 모듈 명세

모든 모듈은 `scripts/internal/*.sh` → `_env.sh` 경유로 `.venv`에서 실행한다. 코드·주석·docstring은 영어.

### 5.1 `textmatch.py` (Phase 0, verify.py에서 분리)

- `loose(s) -> str`: 기존과 **완전히 동일한 동작** (NFKC → lower → `[0-9a-z가-힣]`만).
- `load_pages(pages_md) -> dict[int, str]`, `find_quote_pages(quote, pages) -> list[int]`.
- verify.py는 이 모듈을 import하도록만 바꾼다. 기존 selftest가 그대로 PASS해야 한다.

### 5.2 `layout.py` (Phase 1)

CLI: `layout.sh "<paper folder>" [--force]` → `.work/layout/*`, `.work/translate/*.src.md` 생성. 결과 요약 출력 (`[layout] pages=14 blocks=312 figures=7 low_conf=1`).
API: `build_layout(paper_dir: Path, force=False) -> dict`.

알고리즘 (페이지별):

1. **블록 수집**: `page.get_text("dict")`의 type 0 블록. 줄 텍스트 = span 텍스트 연결. 블록별 `font_size`(글자 수 가중 평균), `bold`(span flags bold 비율 > 0.6).
2. **본문 글꼴 크기**: 문서 전체 span 크기의 글자 수 가중 최빈값 → `body_font_size`.
3. **header/footer**: 페이지 상·하단 8% 안의 블록 중, 숫자를 지운 정규화 텍스트가 전체 페이지의 ≥ 50%에서 반복되거나, 숫자만(페이지 번호)인 것.
4. **캡션**: 블록 첫 줄이 `^(Figure|Fig\.|Table|Tab\.)\s*(\d+)[\.:]?` (기존 captions.md 정규식과 일치시킬 것).
5. **단(column) 감지**: `mid = width/2`, `margin = 0.05*width`. 폭 < 0.6*width인 본문 크기 블록들 중 `x1 ≤ mid+margin` 그룹과 `x0 ≥ mid-margin` 그룹이 각각 글자 수 비중 ≥ 20%면 2단. `column_split = (왼쪽 그룹 max x1 + 오른쪽 그룹 min x0)/2`. split을 10pt 이상 가로지르는 블록은 `column = -1`.
6. **피규어/테이블 영역** (§5.2.1) — 블록 분류 전에 계산, 영역 안 블록은 `figure_text`/`table_text`.
7. **나머지 분류**: heading(한 줄~두 줄, 단어 ≤ 15, `font_size ≥ 1.1*body` 또는 bold, 또는 `^\d+(\.\d+)*\.?\s+[A-Z]`), equation(수학 글꼴 이름 `CMMI|CMSY|CMEX|Math|Symbol|STIX` span 비중 ≥ 40%, 또는 줄 끝 `\(\d+\)` + 짧은 줄), reference(heading `References|Bibliography` 이후 블록), list(`^[•\-–\*]|\(\w\)` 시작), 나머지 paragraph.
8. **같은 단락 병합**: 같은 column에서 세로 간격 < 0.5×줄높이, 글꼴 크기 동일, 둘 다 paragraph이면 병합하지 **않는다** (ID 안정성 우선). 대신 Claude 번역 시 앞뒤 블록 문맥을 보게 한다.
9. **읽기 순서**: 블록과 피규어 영역을 y0로 정렬 → `column=-1` 요소로 가로 band 분할 → 각 band 안에서 col0을 위→아래, 그다음 col1. 1단이면 y0 순.
10. **아웃라인**: `doc.get_toc()`가 있으면 사용, 없으면 heading 블록(번호 깊이 = level).

#### 5.2.1 피규어/테이블 영역 감지

1. 그래픽 후보: `page.get_image_info()` bbox + `page.get_drawings()` 각 path의 `rect`. 페이지 크기의 95% 이상(테두리)은 제외.
2. 6pt 확장 rect가 겹치는 것끼리 union-find로 클러스터링. 면적 ≥ 1500pt² 또는 path ≥ 3개인 클러스터만 유지.
3. 각 **Figure 캡션**: 캡션 위쪽에서, 캡션과 x 겹침 ≥ 30%이고 사이에 paragraph 블록이 없는 가장 가까운 클러스터 → 인접(간격 < 15pt) 클러스터들과 union → 그 안의 텍스트 블록 포함해 확장. 위에 없으면 아래쪽 검색. `confidence 0.9`.
4. 각 **Table 캡션**: 캡션 아래쪽으로, 다음 캡션 / prose paragraph(줄당 평균 단어 > 8이고 마침표로 끝남) / band 끝 전까지의 텍스트 블록 + 겹치는 drawing 클러스터 union. 그래픽 없으면 `confidence 0.6`.
5. 실패 시 fallback: 캡션과 가장 가까운 paragraph 사이 사각형(캡션 column 폭). `confidence 0.4`.
6. 캡션 없는 그래픽 클러스터가 페이지 면적의 ≥ 15%면 `label: null` 피규어.
7. `figure_overrides.json` 적용 → crop 렌더 `page.get_pixmap(clip=bbox, dpi=200)` → `layout/figures/<fid>.png`.

### 5.3 `anchor.py` (Phase 1)

`anchor_quote(page: fitz.Page, quote: str) -> AnchorResult | None`

```
words = page.get_text("words")      # (x0,y0,x1,y1,text,block_no,line_no,word_no), sort=False
S, owner = "", []
for i, w in enumerate(words):
    n = loose(w[4]); S += n; owner += [i] * len(n)
q = loose(quote); pos = S.find(q)
if not q or pos < 0: return None
i0, i1 = owner[pos], owner[pos + len(q) - 1]
rects = union of word bboxes in words[i0..i1], grouped by (block_no, line_no)
ambiguous = S.find(q, pos + 1) >= 0
```

- `pages.md`는 `get_text("text")`(sort 없음)로 만들었으므로 `words`와 같은 내부 순서다 → evidence에서 검증된 quote는 같은 순서로 찾힌다.
- 결과: `{page, rects, ambiguous}`. 하이픈 줄바꿈(`rein-`/`forcement`), 합자(`ﬁ`)도 loose 덕분에 매칭된다.
- CLI: `anchor_check.sh "<paper folder>"` — evidence/highlights 전체를 앵커링해 성공률 출력 (디버깅용).

### 5.4 `annotations.py` (Phase 3)

파서만 담당: `parse_highlights(md) -> list[H]`, `parse_figure_notes(md) -> list[F]`, `parse_translation(md) -> dict[block_id, str]`, `parse_src(md) -> list[(block_id, kind, text)]`. evidence 파서는 verify.py의 것을 `textmatch.py`/공용 위치로 옮겨 재사용.

### 5.5 `verify_annotations.py` (Phase 3)

CLI: `verify_annotations.sh "<paper folder>" [--translation|--highlights|--figures]` (인자 없으면 전부). ERROR ≥ 1이면 exit 1. 출력 형식은 기존 verify와 동일하게 `ERROR …` / `WARN …` / 마지막 줄 `[verify-annotations] PASS|FAIL errors=N warnings=M`.

| 대상 | 조건 | 결과 |
|---|---|---|
| 번역 | `translate:true` 블록의 번역 누락 또는 빈 문자열 | ERROR |
| 번역 | src에 없는 블록 ID | ERROR |
| 번역 | paragraph인데 한글이 하나도 없음 (미번역) | WARN |
| 번역 | 원문의 소수/백분율/`×` 수치 집합 ⊄ 번역 | WARN |
| 번역 | 원문 인용 번호 `\[\d+(?:[,–-]\s*\d+)*\]` 누락 | WARN |
| 번역 | 길이 비율(번역/원문 글자) < 0.25 또는 > 3.0 | WARN (요약·누락 의심) |
| 하이라이트 | category 허용값 밖, page/quote 누락 | ERROR |
| 하이라이트 | quote가 명시 페이지에 없음 (다른 페이지면 `actually on p.[Y]`) | ERROR |
| 하이라이트 | H 블록 앵커링 실패 | ERROR |
| 하이라이트 | evidence-derived 앵커링 실패 | WARN (번들에서 제외) |
| 하이라이트 | 앵커 ambiguous | WARN (첫 매치 사용) |
| 하이라이트 | H quote가 같은 페이지 evidence quote와 포함 관계 (중복) | WARN |
| 하이라이트 | 총 개수/페이지당 개수가 §6 밀도 규칙 밖 | WARN |
| 피규어 해설 | figures.json에 없는 `figure:` ID | ERROR |
| 피규어 해설 | 피규어에 F 블록 없음 | ERROR |
| 피규어 해설 | status OK인데 `#### ko` 없음 | ERROR / `#### en` 없음 → WARN |
| 피규어 해설 | `[E#, p.N]` 존재하지 않는 E / 페이지 불일치 | ERROR |
| 피규어 해설 | `[FIG: id]`가 존재하지 않는 피규어 | ERROR |
| 피규어 해설 | 수치가 있는데 마커 없음 | WARN (기존 check_output 숫자 규칙 재사용) |

### 5.6 `build_viewer.py` (Phase 2에서 layout만으로 동작, Phase 3에서 확장)

`build_viewer(paper_dir) -> Path`. layout이 없으면 먼저 `build_layout`. 번역·하이라이트·해설이 없으면 해당 필드를 `null`/빈 배열로. verify_annotations를 내부 호출해 `status`를 채운다. 출력 JSON은 키 정렬, 들여쓰기 없음. **LLM 호출 금지.**

### 5.7 `papers.py` (Phase 1)

- `scan(out_root) -> list[PaperEntry]`: `.work/pages.md`가 있는 폴더 재귀 탐색.
- `paper_id(folder_rel) = sha1(folder_rel.as_posix())[:12]`.
- `PaperEntry`: `id, name, folder, folder_rel, num_pages, has_report, digest_verify, has_layout, translation (done/total), highlights, figure_notes`.
- `resolve_for_annotate(name) -> Path`: 폴더 경로 / 폴더 이름 / `out_root` 기준 상대경로 매칭 (prepare의 `-n` 규칙과 같은 스타일, 다중 매치는 에러).
- iCloud 미다운로드 파일(`.<name>.pdf.icloud` 존재)은 `status: "evicted"`로 표시.

### 5.8 `viewer/server.py` (Phase 2+) — API는 §9

- 시작 시 `out_root`를 스캔해 `id → folder` 맵을 메모리에 둔다 (`/api/papers` 호출 시 재스캔).
- 파일 응답은 반드시 맵을 통해 해석된 폴더 하위만. `..`/절대경로/심볼릭 링크 탈출 거부.
- `127.0.0.1`에만 바인딩. CORS 없음 (dev 모드에서는 Vite proxy 사용).
- `web/dist`가 없으면 `/`에서 "run scripts/setup.sh" 안내 HTML.

---

## 6. Skill `/paper-annotate` (Phase 3)

`.claude/skills/paper-annotate/SKILL.md` — **영어로 작성**. 아래 초안을 바탕으로 다듬는다.

~~~markdown
---
name: paper-annotate
description: Prepare a digested paper for the interactive viewer — full Korean translation per layout block, auto-highlights, and figure/table explanations — then verify and build viewer.json. Use with `/paper-annotate -n NAME`.
---

# Preconditions
- The paper folder already has `.work/pages.md`. `.work/evidence.md` and the report are strongly preferred
  (run /paper-digest first). If evidence.md is missing, highlights come only from H blocks and figure notes
  may not use [E#] citations.

# Steps
1. Resolve and lay out: `scripts/internal/layout.sh "<folder>"`. Read the summary line.
2. Read context: `<name> - summary.md`, the Glossary section of the report, `.work/evidence.md`,
   `.work/layout/figures.json`.
3. Glossary: write `.work/translate/glossary.md` — one line per term `English → 한국어 (keep English if
   conventionally untranslated)`. Start from the report Glossary. Use it consistently on every page.
4. Translate page by page. For each `.work/translate/pNNN.src.md`, write `pNNN.ko.md` with exactly the same
   BLOCK ids, in the same order. Rules:
   - Faithful, sentence-by-sentence. Never summarize, merge, or drop sentences.
   - Keep math, symbols, variable names, citation numbers like [12], URLs, and "Figure 3 / Table 2 / Eq. (4)"
     references as-is (Figure → 그림, Table → 표 is fine but keep the number).
   - First occurrence of a technical term: 한국어(English). Afterwards Korean only, per glossary.
   - Headings keep their numbering: "3.1 문제 정식화 (Problem Formulation)".
   - If a block ends mid-sentence (column/page break), end the translation at the corresponding point so the
     next block continues naturally. Read the neighbouring blocks before translating.
5. `scripts/internal/verify_annotations.sh "<folder>" --translation`. Fix all ERRORs; review WARNs.
6. Highlights: write `.work/highlights.md` (template: templates/highlights.md). Evidence quotes of categories
   problem/gap/contribution/insight/method/result/ablation/limitation are included automatically — do NOT
   repeat them. Add H blocks only for key sentences evidence does not cover. Density:
   - total highlights (evidence-derived + H): 15–40 and ≤ 1.5 × pages; at most 4 per page
   - each quote: one sentence (two max), 40–300 characters, copied verbatim from pages.md (original language)
   - coverage: ≥1 problem, ≥1 contribution, ≥2 method, ≥2 result, ≥1 limitation if the paper states any
7. Figure notes: for each figure in figures.json, open the PNG (`.work/layout/figures/<fid>.png`) with the Read
   tool, read its caption and the blocks listed in `refs`, then write an F block (template:
   templates/figure_notes.md): Summary line (≤120 Korean chars), How to read (axes, legend, symbols),
   2–4 observations, Link to text (which contribution C# it supports). Korean first, then English.
   Numbers from the paper text → [E#, p.N]; numbers read off the image → [FIG: <fid>]; judgement → [INTERP].
   If the crop is wrong or unreadable, write `status: SKIP` with a reason (e.g. "bbox misses the legend").
8. `scripts/internal/verify_annotations.sh "<folder>"` — fix ERRORs (max 3 rounds).
9. `scripts/internal/build_viewer.sh "<folder>"`.
10. Report back: folder, translation done/total, highlight count by category, figure notes OK/SKIP,
    verify PASS/FAIL, warnings, low-confidence figure boxes.

# Headless rules
Same as /paper-digest: under `claude -p`, never pass --force; report instead of asking.
~~~

`scripts/annotate.sh [-n NAME]`: digest.sh와 같은 구조. `-n` 없으면 `viewer.json`의 `status`가 미완료인 폴더를 최대 `max_papers`개. 세션마다
`claude -p "/paper-annotate -n \"$FOLDER\"" --add-dir "$OUT" --permission-mode acceptEdits --allowedTools "Bash(scripts/internal/*)" "Read" < /dev/null`.
(정확한 플래그 문법은 설치된 버전의 `claude --help`로 확인. headless에서 PNG Read가 허용되는지 실제로 테스트하고 `docs/decisions.md`에 기록.)

`cfg.yaml`의 `viewer.auto_annotate: true`면 digest.sh가 verify PASS인 논문에 대해 이어서 annotate를 실행한다 (기본 false).

---

## 7. Scripts

| 스크립트 | 동작 |
|---|---|
| `scripts/setup.sh` | 기존 + Node ≥ 20이 있으면 `cd web && npm ci && npm run build`. 없으면 경고만 (Python 부분은 정상 완료). `--with-e2e`면 `npx playwright install chromium` |
| `scripts/viewer.sh [--dev] [--port N] [--no-open]` | 기본: `uvicorn functions.viewer.server:app --host 127.0.0.1 --port 8765`, 2초 후 macOS `open` / Linux `xdg-open`. `--dev`: uvicorn `--reload` + `npm run dev`(Vite, `/api` proxy) 동시 실행, 종료 시 둘 다 kill |
| `scripts/annotate.sh [-n NAME]` | §6 |
| `scripts/internal/layout.sh`, `anchor_check.sh`, `verify_annotations.sh`, `build_viewer.sh` | 각 모듈의 얇은 wrapper (`_env.sh` source) |
| `scripts/internal/viewer_test.sh [--e2e]` | `npm run test` (vitest) + `--e2e`면 fixture out_root로 서버 띄우고 Playwright |

---

## 8. 프론트엔드 명세

### 8.1 화면 구성

```
┌ HeaderBar ─────────────────────────────────────────────────────────────────────┐
│ ← 라이브러리 | 제목 | 3 / 14 | − 100% + 맞춤 | ✨하이라이트 | 번역패널 | 🔒싱크 | AI: 한/EN | 💬 | 내보내기▾ | 상태칩 │
├ Sidebar(240, 접기) ┬ PdfPane (원문) ──────┬ TranslationPane (번역) ─┬ Drawer(380, 접기) ┤
│ 아웃라인           │                      │                         │ [설명] [채팅]      │
│ 하이라이트(필터)   │   pdf.js 페이지들     │   페이지 카드들          │                    │
│ 피규어             │   + 오버레이 레이어   │   (블록 단위 번역)       │                    │
│ 메모 / 채팅 기록   │                      │                         │                    │
└────────────────────┴──────────────────────┴─────────────────────────┴────────────────────┘
```

- PdfPane과 TranslationPane 사이 드래그 가능한 divider (기본 50:50, localStorage에 비율 저장, 20–80%). 1/3·1/2·2/3에서 20px 안이면 붙는다(`lib/split.ts`). 화살표 키로 이 점들 사이를 옮긴다. 원문 쪽이 2/3을 넘으면 번역 카드의 2단 페이지가 한 단(최소 14px)으로 바뀐다(§8.3). 드래그 중 번역 패널은 CSS scale로만 늘고 줄며, 놓을 때 한 번 다시 배치한다.
- 번역 패널을 끄면 PdfPane이 가운데 정렬된 단일 뷰.
- 1280px 미만에서는 Sidebar/Drawer가 오버레이로 뜬다.
- UI 문자열은 `i18n.ts` (ko 기본). AI 출력 언어 토글(한/EN)은 피규어 해설·하이라이트 노트·새 설명 요청 언어를 바꾼다.

### 8.2 PdfPane

- `pdfjs-dist`로 문서 로드. 페이지 크기는 `viewer.json.pages`에서 미리 알고 있으므로 **모든 페이지 placeholder를 즉시 정확한 높이로 배치**한 뒤, 뷰포트 ±2 페이지를 canvas + text layer로 렌더한다. 이미 그린 페이지는 ±4까지 유지하고, 그 밖에서는 canvas를 해제한다(`lib/pageRender.keepRange`). 렌더는 한 번에 한 job씩, 현재 페이지에 가까운 것부터 돈다(canvas가 text layer보다 먼저). text layer는 마운트당 한 번 만들고 `--total-scale-factor`로 CSS가 늘린다. canvas는 scale이 바뀌는 동안 CSS로 늘였다가, 150ms 뒤 새 canvas에 다시 그려 바꿔 끼운다(빈 프레임 없음). divider 드래그 중에는 text layer를 숨긴다(span 수천 개의 layout이 프레임마다 다시 돌기 때문). `enableHWA`(GPU canvas).
- canvas는 `devicePixelRatio` 반영. 줌: fit-width(기본), 50–300% 단계.
- 페이지 DOM 구조 (위에서 아래로 z 순서):
  1. canvas
  2. `HighlightLayer` (pointer-events: none, `mix-blend-mode: multiply`)
  3. `BlockLinkLayer` (pointer-events: none, 연결 블록 외곽선)
  4. text layer (pdf.js, 선택 가능)
  5. (오버레이에 pointer-events를 받는 요소 없음. 피규어는 hit-test 클릭으로 연다, §8.7)
- **호버 판정은 오버레이 요소가 아니라 hit-testing**: 페이지 컨테이너의 `pointermove`(rAF throttle) → `lib/coords.ts`로 page pt 변환 → `lib/hitTest.ts`가 우선순위 figure > highlight > block으로 판정. 이렇게 해야 텍스트 선택을 방해하지 않는다.
- pdf.js TextLayer API는 버전마다 다르다. 설치된 버전의 타입 정의를 읽고 사용할 것.

### 8.3 TranslationPane — "번역 레플리카" 페이지 카드

- 각 원문 페이지마다 카드 1개. 카드 사이 간격은 PdfPane의 페이지 간격과 같은 값(`PAGE_GAP = 16px`).
- 카드 스케일 `s = cardInnerWidth / page.width`. 기본 글자 크기 `= body_font_size * s * 0.95`, 최소 11px.
- 블록 배치 (React `useLayoutEffect`로 측정 후 absolute 배치):
  - 1단 페이지: 한 열. 2단 페이지: `column_split` 기준 두 열을 원문과 같은 x 비율로 배치. `column=-1` 블록은 두 열 전체 폭.
  - 한 단 모드(번역 패널 < 1/3): 2단 페이지의 블록이 모두 본문 폭 전체로 읽는 순서대로 쌓인다. 피규어·수식은 원래 크기로 가운데. 글자 최소 14px.
  - 블록은 `order` 순. 각 블록 `top = max(이전 블록 bottom + 4px, bbox.y0 * s)` → 공간이 남으면 원문과 같은 높이에, 번역이 길면 아래로 밀린다. band(2단 사이의 걸침 블록) 시작 위치는 두 열 bottom의 최댓값.
  - 카드 높이 = `max(page.height * s, 마지막 bottom + padding)`.
- 블록 종류별 렌더:
  - 번역 대상 블록: `tr`가 있으면 번역, 없으면 원문을 회색 이탤릭으로 + 카드 우상단 `이 페이지 번역` 버튼(Phase 5).
  - 피규어/테이블: `figures[].image_url`을 bbox 폭 비율로 표시, 바로 아래에 번역된 캡션. (`figure_text`/`table_text` 블록은 숨김.)
  - equation: `/api/papers/{id}/crop?page=&bbox=` PNG (원문 그대로).
  - header_footer: 숨김. reference: 원문 그대로 (번역 설정 시 번역).
- 각 블록 요소에 `data-block-id`, 피규어에 `data-figure-id`.

### 8.4 페이지 싱크 스크롤 (`lib/scrollSync.ts`)

사용자가 요청한 핵심 기능. 순수 함수로 구현하고 vitest로 검증한다.

```ts
// 각 pane의 페이지 레이아웃: tops[i], heights[i] (scroll 컨텐츠 좌표, px)
type PaneLayout = { tops: number[]; heights: number[]; gap: number };

// reference line = scrollTop + 0.3 * clientHeight
function mapRef(y: number, from: PaneLayout, to: PaneLayout): number {
  // 1) y가 속한 페이지 i 찾기 (페이지 + 뒤따르는 gap을 한 구간으로)
  // 2) t = (y - from.tops[i]) / (from.heights[i] + from.gap), 0..1로 clamp
  // 3) return to.tops[i] + t * (to.heights[i] + to.gap)
}
```

- `follower.scrollTop = mapRef(driver.scrollTop + 0.3*driver.clientHeight, ...) - 0.3*follower.clientHeight`.
- 경계: driver가 scrollTop=0이면 follower도 0, 맨 아래면 follower도 맨 아래.
- **driver 판정**: 각 pane에서 `wheel`, `pointerdown`, `touchstart`, `keydown`(포커스) 발생 시 그 pane을 150ms 동안 active로. active가 아닌 pane의 `scroll` 이벤트는 무시 → 피드백 루프 방지. follower 갱신은 `requestAnimationFrame` 1회로 합치고 smooth 스크롤 사용 금지.
- 레이아웃 재계산: `ResizeObserver`(두 pane, 모든 카드), 줌 변경, 폰트 로드(`document.fonts.ready`), 이미지 로드 후.
- 🔒 토글로 싱크 on/off. off에서 다시 on으로 켜면 PdfPane을 driver로 즉시 1회 정렬.
- 페이지 표시기(`3 / 14`)는 PdfPane reference line 기준 페이지.
- 불변식 (테스트): 어떤 y에서도 `mapRef(mapRef(y, A, B), B, A)`가 y와 1px 이내.
- (Phase 7, 선택) 블록 앵커 정밀 싱크: 1단 페이지에서 (원문 block top, 번역 block top) 쌍으로 단조 증가하는 앵커만 남겨 구간 선형 보간. 2단 페이지는 페이지 비율 방식 유지.

### 8.5 블록 상호 링크

- PdfPane에서 블록 위에 hover → 오른쪽 대응 블록 배경 강조 (`--link-bg`). 오른쪽 블록 hover → 왼쪽 `BlockLinkLayer`에 해당 bbox 외곽선.
- 오른쪽 블록 클릭 → 싱크를 잠깐 멈추고 PdfPane을 그 블록 중앙으로 스크롤, 300ms 하이라이트 flash, 이후 싱크 재개. 왼쪽에서는 `Alt+클릭`으로 반대 방향 (일반 클릭은 텍스트 선택 용도).

### 8.6 자동 하이라이트

- 카테고리 색 (light / dark 모드 각각 CSS 변수):

| category | 의미 (UI 라벨) | 색 |
|---|---|---|
| problem | 문제·동기 | 보라 |
| contribution | 핵심 기여 | 노랑 |
| insight | 핵심 아이디어 | 주황 |
| method | 방법 | 파랑 |
| result | 결과 | 초록 |
| limitation | 한계 | 빨강 |

- 헤더 `✨하이라이트` = 전체 on/off (단축키 `H`). 사이드바 하이라이트 탭에서 카테고리별 체크박스 + 개수, 기본 전부 on.
- rect마다 div, opacity 0.35. 호버 500ms 체류 시 작은 tooltip: 카테고리 라벨 + note(AI 언어 토글에 따라 ko/en) + 출처(`E12`면 "evidence"). 클릭(드래그 아님) → 사이드바 해당 항목 선택·스크롤.
- 사이드바 목록: 카테고리 → 페이지 순. 항목 클릭 → 해당 위치로 스크롤 + flash.
- 번역 패널: 하이라이트가 걸린 블록의 번역 문장 왼쪽에 같은 색 3px 세로 막대 (문장 단위 매핑은 하지 않는다 — 블록 단위).

### 8.7 피규어 호버 해설 (요청 기능)

- 페이지 위에 배지는 없다. 피규어 위에서는 커서가 pointer로 바뀐다. `confidence < 0.6`이면 bbox 점선 외곽선.
- **열기**: 피규어 안을 클릭(텍스트 선택이 아닐 때) → 고정 popover. **닫기**: 같은 피규어를 다시 클릭, 페이지의 다른 곳이나 바깥 클릭, `Esc`, × 버튼. 동시에 하나만. 사이드바 Figures 탭에서도 연다(키보드 접근). hover로는 열지 않는다(하이라이트 tooltip만 hover).
- 위치: 피규어 오른쪽에 공간이 있으면 오른쪽, 없으면 아래, 뷰포트 안으로 clamp. 최대 폭 420px, 최대 높이 60vh 스크롤.
- 내용: `label` + 요약(굵게) → `body_md` (읽는 법, 관찰 bullet, 본문 연결) → 버튼 `[자세히]`(drawer 설명 탭에 전체 + 이어서 질문) `[질문하기]`(채팅 탭에 피규어 컨텍스트 첨부) `[한/EN]`.
- 해설이 없거나 SKIP: "해설 없음" + reason + `[지금 생성]` → Phase 5 영역 설명 API를 피규어 bbox로 호출, 결과를 popover에 스트리밍 (이 결과는 캐시에만 저장, `figure_notes.md`에는 쓰지 않는다 — 사전 생성물은 skill+verify 경로로만).
- 번역 패널의 피규어 이미지에도 같은 popover.
- **bbox 수정** (Phase 4): popover의 `영역 수정` → PdfPane에서 드래그로 새 사각형 → `PUT /api/papers/{id}/figures/{fid}/bbox` → `figure_overrides.json` 저장, 해당 crop 재렌더, 번들 재빌드. 해설은 "영역이 바뀌었음 — 재생성 권장" 표시.

### 8.8 선택 툴바와 영역 선택

- text layer에서 선택이 끝나면(`mouseup` + 비어 있지 않은 selection) 선택 영역 위에 `SelectionToolbar`: `설명` `번역` `하이라이트(색 5개)` `메모` `질문하기` `복사`.
- 선택 정보: `text = selection.toString()`, 시작 페이지 = 가장 가까운 `[data-page]`, `rects = range.getClientRects()` → page pt 변환(시작 페이지에 속한 rect만). 페이지를 넘는 선택은 시작 페이지 기준.
- 번역 패널에서도 선택 → `설명` `질문하기` `복사` (원문 블록 ID를 컨텍스트로 첨부).
- **Cmd(mac)/Ctrl + 드래그** on PdfPane → `RegionSelect`가 사각형을 그림 (text layer 선택 대신). 놓으면 drawer 설명 탭에 crop 미리보기 + 스트리밍 설명. 사각형이 피규어 bbox와 IoU ≥ 0.6이면 해당 피규어 해설을 컨텍스트로 함께 보냄.

### 8.9 Drawer: 설명 탭 / 채팅 탭

- **설명 탭**: 요청 카드 스택(최신이 위). 카드 = 컨텍스트 미리보기(선택 텍스트 또는 crop) + 스트리밍 Markdown + 하단 `[저장]`(annotations에 saved_explanation) `[이어서 질문]`(채팅 탭으로 새 스레드, 이 설명을 첫 메시지 컨텍스트로).
- **채팅 탭**: 스레드 목록(사이드바 '채팅 기록'과 동일) + 현재 스레드. 입력창 위에 첨부된 컨텍스트 칩(선택 텍스트/피규어/페이지) 표시, x로 제거.
- **CitationText 렌더** (모든 AI 텍스트 공통, `lib/citations.ts`):
  - `[p.N]` → 클릭 시 페이지 N으로 스크롤.
  - `[E12, p.6]` → 링크 + hover 시 evidence quote tooltip.
  - `[FIG: fig-p3-0]` → 클릭 시 해당 피규어로 스크롤 + popover.
  - `[INTERP]`, `[EXT]`, `[CALC: …]` → 회색 작은 배지.
  - 스트림 종료 후 서버가 보낸 grounding 결과로 인용문 옆에 ✓(원문에서 확인) / ⚠(원문에서 찾지 못함, hover 시 "AI가 의역했거나 지어낸 인용일 수 있음").
  - 수식 `$...$`, `$$...$$` → KaTeX.

### 8.10 내비게이션 (Phase 2/4/7)

- 사이드바 탭: 아웃라인(`outline`) · 하이라이트 · 피규어(썸네일 = figure PNG, 클릭 이동, hover popover) · 메모 · 채팅 기록.
- 블록 검색(`/` 단축키): `blocks[].text`와 `tr` 대상 부분 문자열 검색 → 결과 목록(페이지, 앞뒤 문맥) → 이동 + 블록 flash. (pdf.js find controller는 쓰지 않는다.)
- 페이지 이동: 페이지 표시기 클릭 → 입력.
- (Phase 7) 참고문헌 미리보기: reference 블록에서 `^\[(\d+)\]` 또는 `^(\d+)\.` 항목 파싱 → 본문 text layer의 `[12]` 위 hover 시 해당 항목 tooltip. 숫자형 인용만 지원.

### 8.11 마크업과 내보내기 (Phase 6)

- 사용자 하이라이트: 선택 툴바 색 → `annotations.json`에 저장(`PUT` 전체 교체, 300ms debounce). 사용자 하이라이트는 자동 하이라이트 위에 그린다(불투명도 0.45). 클릭 → 색 변경/메모/삭제 미니 메뉴.
- 메모: 선택 툴바 `메모` 또는 빈 곳 `N` 단축키 후 클릭 → 핀 아이콘 + 텍스트.
- 내보내기 ▾: `Obsidian 노트(.md)`, `주석 PDF`. 완료 후 토스트에 파일 경로.

### 8.12 단축키

| 키 | 동작 |
|---|---|
| `H` | 자동 하이라이트 토글 |
| `T` | 번역 패널 토글 |
| `S` | 싱크 토글 |
| `/` | 블록 검색 |
| `[` / `]` | 사이드바 / drawer 토글 |
| `J` / `K` | 다음 / 이전 페이지 |
| `Cmd/Ctrl + 드래그` | 영역 설명 |
| `Esc` | popover·툴바·검색 닫기 |

입력창 포커스 중에는 단축키 비활성.

### 8.13 라이브러리 화면

- `/api/papers` 목록 표: 이름, 하위 폴더, 페이지 수, 상태 칩(digest PASS/FAIL, 번역 x/y, 하이라이트 n, 피규어 해설 x/y, evicted), 버튼 `[열기]` `[전처리]`.
- `[전처리]` → `POST /api/papers/{id}/annotate` → 행 아래 로그 패널(SSE). 완료 시 상태 갱신.
- 상단 검색 필터, 하위 폴더별 그룹.
- 라우트: `/` 라이브러리, `/r/:paperId?page=N` 리더 (딥링크).

---

## 9. 서버 API

모든 경로는 `/api` 아래. `{id}`는 paper id. JSON 오류는 `{"error": "...", "detail": ...}`.

| Method | Path | 설명 |
|---|---|---|
| GET | `/papers` | 라이브러리 목록 (`PaperEntry[]`) |
| GET | `/papers/{id}/viewer.json` | 번들 (stale이면 재빌드 후 반환) |
| GET | `/papers/{id}/pdf` | 원본 PDF (`Accept-Ranges` 지원 — pdf.js range 요청) |
| GET | `/papers/{id}/figures/{fid}.png` | 피규어 crop |
| GET | `/papers/{id}/crop?page=N&bbox=x0,y0,x1,y1&dpi=200` | 임의 영역 PNG (bbox 검증, dpi ≤ 300, `layout/crops/`에 캐시) |
| PUT | `/papers/{id}/figures/{fid}/bbox` | 피규어 bbox 수정 (§8.7) |
| POST | `/papers/{id}/explain` | SSE. body `{kind:"text"|"region"|"figure", text?, page, rects?, bbox?, figure_id?, block_id?, lang}` |
| POST | `/papers/{id}/translate` | SSE. body `{text, page, lang}` — 선택 번역 |
| POST | `/papers/{id}/translate_page` | SSE 진행률. body `{page}` — 해당 페이지 `pNNN.ko.md` 작성 → verify(translation) → 번들 재빌드 |
| GET | `/papers/{id}/chats` / `/chats/{tid}` | 스레드 목록 / 내용 |
| POST | `/papers/{id}/chats/{tid}/messages` | SSE. body `{message, context?: {...}, lang}`. `tid="new"`면 생성 후 첫 이벤트로 `thread` |
| DELETE | `/papers/{id}/chats/{tid}` | 스레드 삭제 (사용자 요청 시만) |
| GET / PUT | `/papers/{id}/annotations` | 사용자 상태 (PUT 전체 교체, 버전 필드로 낙관적 잠금 → 충돌 409) |
| POST | `/papers/{id}/annotate` | 전처리 job 등록 → `{job_id}` |
| GET | `/jobs` | 이번·지난 서버 실행의 job `{id, paper(sha), action, status, lines, model, effort, submitted, started, ended}` — 라이브러리가 1초마다 폴링 (D4-12, D4-13, D4-14) |
| GET | `/prepare` | 새 src/ PDF 백그라운드 준비 상태 `{running, done, total, current, started}` (D4-15) |
| POST | `/papers/{id}/export/notes` | `<name> - notes.md` 생성 → `{path}` |
| POST | `/papers/{id}/export/pdf` | `<name> - annotated.pdf` 생성 → `{path}` |
| GET | `/config` | 프론트에 필요한 설정 (target_lang, 백엔드 종류, 카테고리 기본값) |

SSE 이벤트 형식 (모든 스트리밍 엔드포인트 공통):

```
event: delta      data: {"text": "..."}
event: grounding  data: {"items": [{"quote": "...", "page_claimed": 3, "pages_found": [3], "ok": true}]}
event: done       data: {"cached": false, "thread_id": "...", "usage": {...}}
event: error      data: {"message": "..."}
```

jobs: 동시에 `parallel`(cfg.yaml, 1..10)개 실행, 나머지는 큐, 논문당 1개. 서버 종료 시 실행 중 서브프로세스 terminate.

---

## 10. LLM 백엔드와 프롬프트 (Phase 5)

### 10.1 인터페이스

```python
class LLMBackend(Protocol):
    name: str
    def stream(self, *, system: str, messages: list[dict], images: list[Path] = (),
               model: str, max_tokens: int = 1500) -> Iterator[str]: ...
```

| 백엔드 | 구현 |
|---|---|
| `claude_cli` (기본) | `claude -p` 서브프로세스, `--output-format stream-json`(부분 메시지 스트리밍 옵션이 있으면 사용), `--model`, 이미지는 파일 경로를 프롬프트에 적고 `Read` 허용 + `--add-dir <paper>/.work`. 채팅은 **매 요청에 대화 기록 전체를 다시 보냄** (stateless — `--resume`에 의존하지 않음). 정확한 플래그는 `claude --help`로 확인 |
| `anthropic_api` | `anthropic` SDK `messages.stream`. 논문 컨텍스트 system 블록에 `cache_control: {"type": "ephemeral"}` (prompt caching). 이미지 base64. 키는 `ANTHROPIC_API_KEY` 환경변수 (설정 파일·로그에 키 저장 금지) |
| `fake` | 결정적 출력: `"FAKE[{kind}] {입력 앞 40자} — see [p.{page}] \"{pages.md에서 해당 페이지 첫 30자}\""`를 10자씩 yield. 모든 테스트가 사용 |

선택: `cfg.viewer.llm_backend`, 환경변수 `PAPER_VIEWER_LLM`이 우선.

### 10.2 컨텍스트 조립 (`context.py`)

- 논문 본문: `pages.md` 전체가 `viewer.max_context_chars`(기본 250000) 이하면 전체, 아니면 `summary.md` + report 한국어 부분 + 현재 페이지 ±1.
- 위치: 페이지, 블록이 속한 섹션 heading(outline에서 역추적), 블록 원문, 앞뒤 블록.
- 보조: glossary.md, 관련 evidence(같은 페이지), 피규어면 caption + 피규어 해설 + crop 이미지.
- 프롬프트 파일 `functions/viewer/prompts/*.md`는 **영어**. `{lang}`으로 출력 언어 지정 (ko = 한국어).

### 10.3 프롬프트 템플릿 (초안 — 영어로 파일에 저장)

`system_common.md`

```
You are a careful research colleague helping the user read the paper below.
Answer in {lang_name}.
Grounding rules:
- Base every claim about the paper on its text. Cite pages as [p.N] (N = page marker in the paper text).
- When you rely on specific wording, quote it exactly in double quotes, in the original language, ≤ 25 words.
- Never invent numbers. If the paper does not state something, say so explicitly.
- Mark general background knowledge not from the paper with [EXT], and your own judgement with [INTERP].
- Use LaTeX ($...$) for math.
<paper>
{paper_text}
</paper>
```

`explain_text.md`

```
The user selected this passage on page {page} (section: {section}):
<selection>{text}</selection>
Surrounding text: <context>{neighbors}</context>
Explain it so a graduate student outside this subfield understands it. Structure:
1. One-sentence gist.
2. Plain explanation (unpack jargon, the "why", how it connects to the previous step).
3. If it contains math: explain every symbol and what the equation computes.
4. Its role in the paper (which problem/contribution it serves) with [p.N].
150–300 words unless the passage is long.
```

`explain_region.md` — 위와 같되 `<image>`(crop)와 영역 내 추출 텍스트(`page.get_textbox(bbox)`), 피규어면 캡션·사전 해설 포함. "describe what is shown, how to read it, the key takeaway, and values only if legible (mark them [FIG])".

`translate_selection.md` — 충실 번역, glossary 준수, 수식·인용번호 보존, 번역만 출력.

`translate_page.md` — §6 번역 규칙 + "output exactly the BLOCK markers given, same order, nothing else". 서버는 결과를 파싱해 ID 집합이 src와 다르면 1회 재시도, 그래도 다르면 error 이벤트.

`chat_system.md` — system_common + "You can be asked follow-ups; keep answers focused; suggest which figure/section to look at with [p.N]".

### 10.4 Grounding 검사 (`grounding.py`)

스트림 종료 후: 응답에서 `"…"` 안의 라틴 문자 인용(loose 길이 ≥ 15)을 추출 → 가장 가까운 `[p.N]`를 claimed page로 → `find_quote_pages`. 결과를 `grounding` 이벤트로 전송하고 채팅 기록에 함께 저장.

### 10.5 캐시

키 = `sha256(kind, normalized input, page, bbox, lang, model, prompt file hash)`. `viewer/cache/<key>.md`에 저장, 히트 시 스트리밍 없이 delta 한 번 + `done{cached:true}`. 설명 카드에 `다시 생성` 버튼 (캐시 무시).

---

## 11. 설정 — `configs/cfg.yaml` 추가분

```yaml
viewer:
  host: 127.0.0.1
  port: 8765
  target_lang: ko               # 번역·AI 출력 기본 언어
  translate_references: false
  llm_backend: claude_cli       # claude_cli | anthropic_api | fake  (env PAPER_VIEWER_LLM 우선)
  model_interactive: sonnet     # claude_cli: alias / anthropic_api: 전체 모델 ID (예: claude-sonnet-5-5)
  model_vision: sonnet
  max_context_chars: 250000
  highlight_default_categories: [problem, contribution, insight, method, result, limitation]
  auto_annotate: false          # true면 digest.sh가 PASS 논문에 annotate까지 실행
```

`functions/` 쪽 설정 로더에 기본값을 두고, 키가 없어도 동작해야 한다. 모델 ID는 하드코딩하지 말고 설정에서만 읽는다.

---

## 12. 테스트 전략 — 실제 LLM 호출 0회

### 12.1 합성 fixture (`functions/fixtures.py`, Phase 0)

PyMuPDF로 생성하는 3페이지 논문 "FooNet":
- p1: 두 단에 걸친 제목·저자, 2단 본문, 헤더 "Preprint" + 푸터 페이지 번호(모든 페이지), Abstract에 기여 문장, 줄 끝 하이픈 분리 단어(`rein-`/`forcement`), 합자 `ﬁ` 포함 단어.
- p2: 왼쪽 단에 vector 그림(사각형·선·화살표 path 여러 개) + 아래 캡션 `Figure 1: ...`, 오른쪽 단 본문에 `Fig. 1` 참조, 수식 줄 `L = Σ_t r_t (1)`.
- p3: 단 걸침 raster 이미지(Pixmap으로 만든 PNG 삽입) + 캡션 `Figure 2`, `Table 1` 캡션 + 아래 선으로 그린 3×3 표와 셀 텍스트, `References` 섹션 `[1] ...`, `[2] ...`.
- 정답 메타데이터(그린 피규어 rect, 표 rect, 블록 종류 기대값)를 함께 반환.
- 필요 시 회전 페이지 fixture를 별도로 생성 (§4.1 실측용).

같은 fixture로 `evidence.md`, `report.md`, `summary.md`, `highlights.md`, `figure_notes.md`, `translate/*.ko.md`의 good/bad 버전을 만들어 쓴다.

### 12.2 Python selftest 확장 (`scripts/internal/selftest.sh`)

기존 섹션 유지 + 추가:
- **layout**: 2단 감지, 읽기 순서(col0 블록 order < col1), header_footer 분류, 캡션 3개, Figure 1 bbox IoU ≥ 0.7, raster Figure 2 IoU ≥ 0.8, Table 1 bbox가 표 rect 포함, figure_text/table_text는 `translate:false`, `refs`에 p2 본문 블록, equation 분류, reference 분류, **두 번 실행 시 blocks.json 바이트 동일**.
- **anchor**: 하이픈 분리 quote → 서로 다른 줄의 rect 2개, 합자 quote 매칭, 다른 페이지 quote → None, ambiguous 플래그.
- **verify_annotations**: good → PASS. bad: 번역 누락 ID, 모르는 ID, 앵커링 불가 H, 없는 figure ID, 없는 E 인용, `[FIG: 없는id]` → 각각 ERROR. 수치 누락 번역 → WARN.
- **build_viewer**: fixture로 빌드 → `tests/fixtures/viewer.sample.json`과 비교(`built_at` 제외). 다르면 FAIL + diff 요약. 스키마 변경 시 golden 갱신 명령: `scripts/internal/build_viewer.sh --update-golden`.
- **server** (`TestClient`, `PAPER_VIEWER_LLM=fake`): `/api/papers`에 fixture 1건, `/pdf` 200 + range 요청 206, 경로 탈출 시도 404, `/crop` bbox 범위 밖 400, `/explain` SSE에 delta ≥ 1 + grounding + done, annotations PUT/GET 왕복 + 버전 충돌 409, export/notes 파일 생성.

### 12.3 프론트엔드

- vitest: `coords`(pt↔px 왕복), `scrollSync`(경계, 역함수 1px 불변식, 높이가 다른 페이지들), `hitTest`(우선순위), `citations`(모든 마커 파싱), 번역 카드 배치 함수(블록 top 단조성, 2단 배치).
- Playwright e2e (`viewer_test.sh --e2e`): 임시 out_root에 fixture 논문 + 모든 산출물 복사, `PAPER_VIEWER_LLM=fake`로 서버 기동.
  1. 라이브러리 → 리더 열림, 3페이지 placeholder 높이 정확.
  2. PdfPane을 2페이지 상단으로 스크롤 → TranslationPane의 2페이지 카드 상단이 같은 reference line ±40px.
  3. TranslationPane을 스크롤해도 반대 방향 싱크. 🔒 끄면 싱크 안 됨.
  4. Figure 1 영역 클릭 → popover에 요약 텍스트(고정), 다시 클릭·바깥 클릭·Esc로 닫힘. hover만으로는 열리지 않음.
  5. `H` → 하이라이트 레이어 숨김/표시, 사이드바 항목 클릭 → 해당 페이지로 이동.
  6. 텍스트 드래그 선택 → 툴바 → `설명` → drawer에 `FAKE[text]` 스트리밍 + `[p.N]` 링크 클릭 시 이동 + ✓ 배지.
  7. Ctrl+드래그 → crop 미리보기 이미지 + `FAKE[region]`.
  8. 사용자 하이라이트 생성 → 새로고침 후 유지. 내보내기 notes → 파일 존재.
  9. 오른쪽 블록 hover → 왼쪽 외곽선 표시.

---

## 13. Phase 계획

각 Phase 끝: (a) 해당 Acceptance 전부 통과, (b) `scripts/internal/selftest.sh` PASS, (c) Phase 2부터 `scripts/internal/viewer_test.sh` PASS, (d) `implementation.md` §8 상태 표 갱신 + 실제로 만든 것과 이 계획의 차이를 `docs/decisions.md`에 기록, (e) 커밋 `viewer: phase N — <요약>`.

### Phase 0 — 준비와 리팩터
- `textmatch.py` 분리, verify.py가 import. `fixtures.py` 작성(§12.1), selftest의 기존 FooNet 생성이 있으면 이것으로 통합.
- requirements, `.gitignore`, `setup.sh`(Node 빌드는 web/가 생긴 뒤 동작하도록 조건부), CLAUDE.md 규칙 추가(§14).
- **Acceptance**: 기존 selftest 결과 동일하게 PASS. `setup.sh` 두 번 실행해도 안전.

### Phase 1 — 레이아웃과 앵커링 (Python만)
- `papers.py`, `layout.py`, `anchor.py`, wrapper 스크립트.
- **Acceptance**: §12.2 layout·anchor 테스트 PASS. 실제 논문 폴더 하나(사용자 vault의 기존 결과물)로 `layout.sh` 실행 시 오류 없이 완료 — 요약 줄과 low_conf 피규어 수를 보고. `anchor_check.sh`로 기존 evidence 앵커링 성공률 보고(목표 ≥ 90%, 미달 시 실패 사례 분석을 decisions.md에).

### Phase 2 — 서버와 리더 골격
- `build_viewer.py`(layout만), `server.py`(papers, viewer.json, pdf, figures, crop), `viewer.sh`.
- web: Library, Reader, HeaderBar, PdfPane(가상화, text layer), TranslationPane(원문 회색 표시, 피규어/수식 이미지), **페이지 싱크 스크롤**, 블록 상호 링크, 페이지 표시기, 줌, 아웃라인 탭, 블록 검색.
- **Acceptance**: e2e 1–3, 9 PASS. 50페이지 PDF에서 스크롤 시 메인 스레드 long task 없이 동작(Chrome performance로 확인 후 수치 기록).

### Phase 3 — 전처리 skill과 검증
- `annotations.py`, `verify_annotations.py`, `build_viewer.py` 확장, `/paper-annotate` SKILL.md + templates, `annotate.sh`, `jobs.py` + 라이브러리 `[전처리]` 버튼과 로그.
- **Acceptance**: §12.2 verify_annotations·build_viewer 테스트 PASS. (사용자가 실행할 수 있도록) 실제 논문 하나에 대한 `scripts/annotate.sh -n NAME` 실행 절차를 `implementation.md` §8에 기록. 에이전트 환경에서 `claude` CLI를 쓸 수 있으면 직접 1회 실행해 결과(번역 x/y, 하이라이트 수, verify 결과)를 보고.

### Phase 4 — 오버레이
- HighlightLayer + 사이드바 하이라이트 탭(필터), FigureLayer + FigurePopover(hover/pin/위치), 피규어 탭, 피규어 bbox 수정, 번역 패널 하이라이트 막대, CitationText(사전 생성물용 — `[E#]` tooltip, `[FIG]` 이동).
- **Acceptance**: e2e 4, 5 PASS. 하이라이트 rect가 pdf.js text layer의 같은 단어 span과 2pt 이내로 겹침(e2e에서 fixture 단어 하나로 측정).

### Phase 5 — 실시간 AI
- `llm.py`(3 백엔드), `context.py`, `prompts/`, `grounding.py`, 캐시, explain/translate/translate_page/chat 엔드포인트, SelectionToolbar, RegionSelect, Drawer(설명·채팅), `이 페이지 번역` 버튼, popover `[지금 생성]`.
- **Acceptance**: e2e 6, 7 PASS (fake). `claude_cli`/`anthropic_api` 백엔드는 실제 호출 없이 명령/요청 조립을 단위 테스트(서브프로세스·SDK mock). 수동 확인 절차를 `implementation.md`에 기록.

### Phase 6 — 마크업과 내보내기
- annotations API + UI(사용자 하이라이트, 메모, saved_explanation), `export.py`.
- notes.md 형식:

```
<!-- generated by paper-viewer; edits will be overwritten on next export -->
# {name} — Reading Notes
> [[{name}.pdf]] · report: [[{name} - report]] · exported YYYY-MM-DD

## Highlights
### p.3
- ==quote== — note ([[{name}.pdf#page=3|p.3]])

## Saved explanations
### p.5 · "{selection 앞 60자}"
{body_md}
```
  - 기존 파일이 첫 줄 마커 없이 존재하면 덮어쓰지 않고 409 → UI에서 "다른 이름으로 저장(`- notes 2.md`)" 선택.
- annotated.pdf: 원본 복사본에 `page.add_highlight_annot(quads)`(자동 하이라이트는 카테고리 색, 사용자 하이라이트는 사용자 색) + note를 annotation content로. 원본 PDF는 절대 수정하지 않는다.
- **Acceptance**: e2e 8 PASS. selftest에서 annotated.pdf를 다시 열어 annotation 개수 = 하이라이트 수.

### Phase 7 — 다듬기
- 참고문헌 `[n]` 호버 미리보기, 다크 모드, 단축키 전체, 블록 앵커 정밀 싱크(옵션), 리더 위치 기억(`viewer/state.json`: 마지막 페이지·줌·패널 비율), 대형 PDF 성능, 접근성(포커스 링, aria-label).
- **Acceptance**: 각 기능별 e2e 1개 이상 추가, 전체 테스트 PASS.

---

## 14. 에이전트 작업 규칙 (CLAUDE.md에 추가할 내용 포함)

1. 시작 전에 `implementation.md`, 이 문서, 기존 `functions/`·`scripts/`·`.claude/skills/paper-digest/`를 읽는다.
2. **언어**: 코드·주석·docstring·SKILL.md·프롬프트·CLAUDE.md는 영어. 문서(`implementation.md`, `docs/*.md`)는 한국어. UI 문자열은 `i18n.ts` (ko 기본, en).
3. **Python**은 항상 `scripts/` 경유(`.venv`). 전역 pip 금지. 새 의존성은 `requirements.txt` → `setup.sh`. Node 의존성은 `web/package.json`, lockfile 커밋, 버전 고정.
4. 기존 digest 파이프라인 동작 변경 금지 (Phase 0 리팩터 제외). `selftest.sh`는 항상 PASS.
5. **논문 내용(번역·하이라이트·해설)을 코드로 생성하지 않는다.** 그것은 skill 또는 LLM 백엔드의 일이다. 테스트는 fixture와 `fake` 백엔드만 쓰고 **실제 LLM 호출을 하지 않는다.**
6. 사전 생성물(`translate/*.ko.md`, `highlights.md`, `figure_notes.md`)은 skill 경로(+ `translate_page`)로만 쓰고, 쓴 뒤에는 반드시 verify_annotations → build_viewer.
7. 서드파티 API(pdf.js TextLayer, `claude` CLI 플래그, `anthropic` SDK, PyMuPDF 버전별 차이)는 기억에 의존하지 말고 설치된 버전의 타입 정의·`--help`·docstring으로 확인한다.
8. 애매한 점은 원칙(§0)에 맞는 가장 단순한 쪽으로 결정하고 `docs/decisions.md`에 기록한 뒤 계속한다. 사용자에게 묻는 것은 파괴적 작업(사용자 파일 삭제·덮어쓰기)일 때만.
9. 사용자 vault(`out_dir`)의 기존 파일(`report.md`, `summary.md`, `evidence.md`, PDF)은 읽기만 한다. 쓰기는 `.work/layout|translate|viewer/`, `.work/viewer.json`, `.work/highlights.md`, `.work/figure_notes.md`, 그리고 사용자가 누른 내보내기 파일만.
10. Phase 완료마다 `implementation.md` §8 상태 표와 as-built 설명을 갱신하고 커밋한다.

CLAUDE.md에 추가 (영어):

```
## Viewer
- Plan: docs/viewer-plan.md. Work phase by phase; each phase must pass its acceptance, selftest.sh, and viewer_test.sh.
- Never generate paper content (translations, highlights, figure notes) in code; tests use fixtures and PAPER_VIEWER_LLM=fake. No real LLM calls in tests.
- Pre-generated annotations are written only via /paper-annotate (or translate_page), then verify_annotations.sh, then build_viewer.sh.
- Coordinates: PDF points, top-left origin, 1-based pages (docs/viewer-plan.md §4.1).
- Record design decisions in docs/decisions.md.
```

---

## 15. 알려진 한계 (계획 단계 예상)

- 스캔본 PDF: 텍스트 레이어가 없어 레이아웃·앵커링 불가 (digest와 동일하게 미지원).
- 레이아웃 휴리스틱: 본문을 감싸는 피규어, 3단 이상, 사이드 캡션은 오검출 가능 → `confidence` 표시 + 수동 bbox 수정.
- 단·페이지 경계에서 잘린 문장은 블록별로 번역되어 어색할 수 있다.
- `loose()` 한계(그리스 문자·수식 기호 무시)는 앵커링에도 그대로 적용된다 — 기호만 다른 quote는 구분 못 함.
- `claude_cli` 백엔드는 프로세스 시작 오버헤드로 첫 토큰까지 수 초가 걸린다. 빠른 응답이 필요하면 `anthropic_api`.
- 실시간 AI 응답은 grounding 배지로 표시만 할 뿐 차단하지 않는다.
- iCloud "저장 공간 최적화"로 내려받지 않은 PDF는 열 수 없다 (라이브러리에 evicted 표시).
- 회전 페이지·비표준 cropbox의 좌표 일치는 Phase 1에서 실측 후 결정.
