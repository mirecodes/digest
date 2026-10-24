# 설계 결정 로그 (Paper Viewer)

계획(`docs/viewer-plan.md`)과 달라졌거나 계획이 정하지 않은 부분을 한 결정당 3–5줄로 기록한다.

---

## Phase 0

### D0-1. viewer-plan.md 위치
- 저장소 루트에 있던 `viewer-plan.md`를 `docs/viewer-plan.md`로 옮겼다. `implementation.md`와 CLAUDE.md가 모두 이 경로를 가리킨다.

### D0-2. `anthropic` 의존성은 Phase 5에 추가
- §3은 Phase 0에서 `anthropic`까지 넣으라고 하지만, 쓰는 곳은 Phase 5의 `anthropic_api` 백엔드뿐이다.
- 지금은 `fastapi`, `uvicorn[standard]`, `httpx`만 추가. `anthropic`은 Phase 5에서 optional import로 추가한다.

### D0-3. fixture의 합자·수식 글꼴
- PyMuPDF base-14 글꼴(Helvetica)은 `ﬁ`(U+FB01)를 `·`로 바꿔 버려 텍스트 레이어에 합자가 남지 않는다.
- 그래서 합자 줄과 수식 줄 `L = Σt rt (1)`만 MuPDF 내장 `cjk` 글꼴(Droid Sans Fallback)로 넣는다. 추출 시 `ﬁ`, `Σ`가 그대로 나온다.
- 이 글꼴 이름은 수학 글꼴 패턴(`CMMI|…|Symbol`)에 걸리지 않으므로, fixture의 수식 블록은 §5.2 7번의 두 번째 규칙(짧은 줄 + 줄 끝 `(n)`)으로 분류되어야 한다.

### D0-4. selftest 합성 논문을 fixtures.py로 통합
- 기존 2페이지 FooNet 생성기를 `functions/fixtures.py`의 3페이지 FooNet으로 교체했다. 기존 evidence quote(E1 p.1, E2 p.2)는 그대로 원문에 들어 있어 selftest 기대값은 바뀌지 않는다 (페이지 수 검사만 2 → 3).
- 기존 p.2 문장 앞의 `Table 2: Results on LRA.`는 뺐다. 줄 첫머리 `Table 2:`는 layout에서 캡션으로 분류되어 표 영역 감지를 교란하기 때문. E2 quote는 그 뒤 문장이라 영향 없음.
- `build_foonet()`은 정답 메타데이터(피규어/표 rect, 블록 종류 기대값, 앵커 테스트용 quote)를 반환한다.

### D0-5. textmatch 분리 범위
- `textmatch.py`에는 `loose`, `load_pages`, `find_quote_pages`만 둔다. `check_evidence`의 페이지 탐색은 원래 코드를 유지했다 (빈 quote 같은 경계 동작까지 완전히 동일하게).
- 검증: 기존 `verify.py`(HEAD)와 새 `verify.sh`의 출력이 vault의 실제 논문 9편 모두에서 바이트 단위로 같다.
- evidence 파서 이동은 실제로 재사용하는 Phase 3에서 한다.

---

## Phase 1

평가 기준: vault의 실제 논문 9편(76페이지)을 scratch에 복사해 반복 실행하고, 페이지 오버레이(블록 종류·읽기 순서·피규어 박스)를 눈으로 확인했다. 아래 규칙 변경은 모두 실제 실패 사례에서 나왔다.

### D1-1. 좌표: 회전·cropbox 실측 결과 (§4.1)
- PyMuPDF의 텍스트(`get_text`)·도형(`get_drawings`) 좌표는 **cropbox 기준이지만 회전 전(unrotated)** 공간이다. `page.rect`와 `get_pixmap(clip=)`은 회전 후 공간이다.
- 그래서 분석은 회전 전 공간에서 하고, 출력 rect만 `page.rotation_matrix`로 변환한다. `anchor.py`도 같다. pdf.js는 회전을 MuPDF와 같게 렌더하므로 일치한다.
- selftest가 90° 회전 페이지에서 앵커 rect 안의 렌더링 픽셀이 실제 글자(잉크)인지 확인한다. 회전 페이지는 단 분석을 하지 않고 `columns: 1`, 블록 `column: 0`으로 낸다 (vault 논문에는 회전 페이지 없음).

### D1-2. 캡션 판정을 §5.2보다 엄격하게
- 실제 논문에서 "Fig. 2 summarises…", "Figure 4 reports…"처럼 본문이 블록 첫 줄에서 시작하는 경우가 많다. 그래서 번호 뒤에 `.` 또는 `:`가 있어야 캡션으로 본다.
- IEEE 형식 `TABLE I`(로마 숫자, 단독 줄)도 캡션으로 인정하고 number는 정수로 변환한다. 본문 참조 정규식도 로마 숫자를 받는다.
- PyMuPDF가 부분 그림 라벨 줄 "(a) (b) (c)"와 캡션을 한 블록으로 묶는 경우가 있다. 앞 줄들이 짧은 라벨(≤ 8단어, 마침표 없음)이면 이후 줄에서 캡션이 시작되어도 인정하고, 영역 탐색에는 캡션 줄들의 상자(`cbox`)만 쓴다.

### D1-3. 그래픽 후보: clip path 반영
- matplotlib 그래프의 음영 띠는 path가 페이지 밖(x = −144)까지 뻗어 있고 축 영역 clip으로만 잘려 보인다. `get_drawings()`는 clip을 무시해서 이웃 피규어끼리 합쳐졌다.
- `get_drawings(extended=True)`의 clip(`scissor`) 스택으로 각 path rect를 잘라 쓴다. 직선(높이 0) 표 괘선이 사라지지 않도록 교집합은 tuple 연산으로 한다.

### D1-4. 피규어 영역 탐색 규칙 보정 (§5.2.1)
- 이미지·그래프 bbox가 캡션과 몇 pt 겹치는 경우가 흔하다. 그래픽 클러스터는 "중심이 캡션 쪽에 있으면" 후보로 보고, 결과 bbox는 캡션 경계에서 자른다. 텍스트 블록은 기존처럼 완전히 캡션 쪽에 있어야 한다.
- 2단 페이지에서는 왼쪽/오른쪽/걸침 그래픽을 따로 클러스터링한다. 단 사이 간격(약 14pt)이 12pt 병합 기준과 비슷해 서로 다른 단의 그림이 합쳐졌기 때문.
- 인접 클러스터 union(< 15pt)은 캡션과 x 겹침 ≥ 30%인 클러스터로 제한하고, 같은 높이대에 있는 클러스터도 합친다 (단 너비 두 개짜리 그림이 단별로 나뉜 경우).

### D1-5. 표 영역 탐색 규칙 보정
- 캡션이 표 아래에 있는 논문(예: Table II/III)이 있어서, 캡션 아래·위 양쪽을 모두 걷고 첫 행이 캡션에 더 가까운 쪽을 택한다.
- 나란히 놓인 표(Table III | Table IV)를 위해 행 블록은 캡션과 x 겹침 ≥ 30%여야 한다.
- 걷기 중단 조건에 번호 heading(`IV. EXPERIMENTAL RESULTS`)과 "줄당 8단어 초과의 여러 줄 블록"(수식·단 끊김으로 마침표 없이 끝난 본문)을 추가.
- 괘선·셀 음영 union은 반복 확장 대신 "표 텍스트 범위 ±12pt, 중심이 표 x 범위 안"인 rect만 한 번에 합친다. 반복 확장은 인라인 수식 선을 타고 페이지 아래까지 번졌다.

### D1-6. 그 밖의 결정
- header/footer 반복 규칙은 최소 2페이지에서 반복될 때만 적용 (1페이지 문서에서 모든 상단 블록이 머리글이 되는 것 방지).
- References 구간은 다음 "글꼴 기반" heading(크기 ≥ 1.1×본문 또는 bold, ≤ 2줄)에서 끝난다. 번호 패턴만으로는 끝내지 않는다 (참고문헌 항목 `1. A. Author`가 heading 정규식에 걸리므로).
- 아웃라인은 `blocks.json`의 최상위 `outline` 키에 저장한다 (§4.2 스키마에 없던 필드; viewer.json이 그대로 가져간다). TOC 항목은 같은 페이지 heading 블록과 앞 30자(공백 제거) 비교로 `block_id`를 붙인다.
- `translate/pNNN.src.md`는 번역 대상 블록이 있는 페이지만 쓴다. 그 외의 오래된 `.src.md`는 지운다. `.ko.md`는 절대 건드리지 않는다.
- `blocks.json`/`figures.json`은 diff를 보기 쉽게 들여쓰기 1로 저장한다 (키 정렬, 결정적).
- 레이아웃은 `blocks.json`이 PDF와 `figure_overrides.json`보다 새로우면 다시 계산하지 않는다 (`--force`로 강제). `blocks.json`을 마지막에 써서 중간 실패 시 재계산되게 한다.
- `papers.py`의 번역 done/total은 지금은 `.ko.md`/`.src.md`의 BLOCK 마커 수다. Phase 3에서 파서로 정확히 센다.

### D1-7. Phase 1 실측 (vault 9편)
- 캡션 기준 피규어/표 검출: captions.md의 라벨(구두점 규칙 적용) 82개 중 79개 검출. 놓친 3개는 모두 본문 문장이 줄 첫머리에 온 경우("…in Figure 8. In our…")로, 실제 캡션은 다른 페이지에서 검출됨 → 실질 누락 0. 로마 숫자 표 12개 추가 검출. low_conf(< 0.6) 0개.
- 앵커링: evidence quote 533/533 (100%), ambiguous 0.
- 속도: 논문당 0.5–1.5초 (15페이지 기준 1.4초).

---

## Phase 2

### D2-1. 프론트엔드 버전 (정확히 고정)
- React 19.3.0, Vite 8.3.2, TypeScript 7.0.2, pdfjs-dist 6.4.299, zustand 5.0.15, vitest 5.0.3, @playwright/test 1.63.0.
- §2는 React 18이라고 했지만 18에 의존하는 기능이 없고 19가 현재 버전이라 19를 썼다. TS 7(`tsc`)이 실제로 타입 오류를 잡는 것을 확인했다.
- `react-markdown`/KaTeX 등 Markdown 의존성은 AI 텍스트를 렌더하는 Phase 4/5에서 추가한다. 라우터 라이브러리는 쓰지 않는다 (라우트 2개: History API로 충분).

### D2-2. pdf.js 데이터 파일 제공 방식
- 내장되지 않은 base-14 글꼴(fixture의 Helvetica 등), CMap, wasm 디코더, ICC 파일이 필요하다. 빌드에 복사하지 않고 FastAPI가 `web/node_modules/pdfjs-dist/{standard_fonts,cmaps,wasm,iccs}`를 `/pdfjs/<kind>/<name>`으로 직접 서빙한다 (dev 모드는 Vite가 `/pdfjs`를 프록시). 이름은 정규식으로 검증.
- 전제: `web/node_modules`가 있어야 한다 (`setup.sh`가 `npm ci`로 항상 만든다).
- pdf.js 6의 text layer는 조상 요소의 CSS 변수 `--total-scale-factor`, `--scale-round-x/y`로 크기를 정한다. `pdf_viewer.css` 전체(4천 줄) 대신 `.textLayer` 규칙만 `styles.css`에 옮겼다.

### D2-3. 서버
- 출력 루트는 `PAPER_VIEWER_OUT` 환경변수가 있으면 그것을 쓴다 (selftest·e2e가 임시 루트를 쓰기 위해). 없으면 cfg.yaml의 `out_dir`.
- PDF Range 요청은 Starlette `FileResponse`가 기본 지원(206)하므로 별도 구현 없음.
- 파일 응답은 스캔으로 찾은 논문 폴더 하위만: 피규어 ID 정규식 검증 + resolve 후 폴더 안인지 확인(symlink·`..` 탈출 거부). iCloud evicted 논문은 409.
- `/crop`: bbox는 페이지 rect ±0.5pt 안이어야 하고 dpi는 36–300. 결과는 `layout/crops/<sha1>.png`에 캐시.
- `httpx` 대신 `httpx2`: Starlette 1.7의 TestClient가 `httpx` 사용을 deprecated로 경고한다.
- Library의 `[전처리]` 버튼은 job 큐(`jobs.py`)가 생기는 Phase 3에서 추가한다.

### D2-4. viewer.json (Phase 2 범위)
- layout만 묶는다: `tr`는 모두 null, `highlights` `[]`, `evidence` `{}`, `figures[].note` null. evidence 파서 공용화는 Phase 3.
- 압축 JSON(키 정렬). 신선도 검사: PDF, blocks/figures.json, report, evidence, highlights, figure_notes, overrides, `*.ko.md` 중 하나라도 더 새로우면 재빌드 (layout 자체도 먼저 최신화).
- report 헤더(`# 제목`, `> 저자 · 학회, 연도 [E#, p.N]`)에서 title/authors/venue_year를 파싱하고 인용 마커는 지운다.

### D2-5. 리더 구현 선택
- 가상화: IntersectionObserver 대신, 페이지 top을 이미 알고 있으므로 scrollTop에서 이진 탐색으로 보이는 페이지를 계산하고 ±2페이지만 canvas+text layer를 렌더한다 (결정적이고 관찰자 불필요). 범위 밖 페이지는 언마운트하며 canvas 비트맵을 즉시 해제.
- 싱크 driver 판정: §8.4 그대로(wheel/pointerdown/touchstart/keydown 후 150ms) + 포인터를 누르고 있는 동안(스크롤바 드래그)은 계속 active. `mapRef`는 첫 페이지 위·마지막 페이지 아래에서 오프셋을 그대로 옮겨 역함수 불변식이 전 구간에서 성립한다.
- 줌·창 크기·번역 패널 토글로 scale이 바뀌면 reference line 위치를 `mapRef`로 유지한다. 측정 전(폭 0) 레이아웃은 기준으로 쓰지 않는다 (처음에 2페이지로 열리던 버그의 원인).
- 번역 카드의 피규어 위치: 피규어가 캡션보다 위면 캡션 바로 앞, 아래면 바로 뒤. 캡션 없는 피규어는 같은 단에서 y가 처음으로 같거나 큰 항목 앞.
- 번역 블록 클릭 → PDF만 그 블록 중앙으로 이동 + flash. 번역 패널은 다음 사용자 스크롤 때 다시 맞춰진다 (= §8.5의 "싱크를 잠깐 멈추고 재개").
- hover 강조는 페이지 단위 selector로 구독해, 커서가 움직여도 해당 카드만 다시 그린다.
- 단축키 중 구현이 한 줄인 T/S/[/J/K//는 지금 넣었다. 나머지(H, Esc 전체, Cmd+드래그)는 해당 기능 Phase에서.

### D2-6. 성능 측정 (Phase 2 Acceptance)
- 방법: Playwright(Chromium headless, 이 Mac)에서 50페이지 합성 논문(페이지당 약 1000단어, 5페이지마다 그림)을 열고 `PerformanceObserver`로 `longtask`(> 50ms)와 `long-animation-frame`을 수집. 먼저 페이지 안에서 120ms busy loop를 실행해 관찰자가 실제로 잡는지 확인한다 (CDP `evaluate`로 돌린 busy loop는 잡히지 않아 처음 측정이 무의미했던 것을 발견하고 고침).
- 결과: PDF 패널·번역 패널 각각 처음부터 끝까지(16ms마다 300px wheel) 스크롤 시 long task 0, long animation frame 0. 별도로 초기 로딩(50장 카드 측정 포함)과 읽는 속도 스크롤(150ms마다 400px)에서도 long task 0.
- Chrome DevTools Performance 패널을 사람이 보는 수동 측정은 하지 않았다. 위 자동 측정이 `perf.spec.ts`로 매번 돈다.

### D2-7. 디자인 시스템 적용 (사용자 요청, `design.md`)
- 토큰(색·그림자·라운드), 서체 스택(Toss Product Sans → Pretendard → Apple SD Gothic Neo → Noto Sans KR), 굵기 400/600 두 가지, 버튼 7px·카드 12px, 입력창은 회색 채움 + 포커스 시 2px 파란 링, 눌림 scale(0.98)을 `styles.css`에 적용.
- 단색 파랑은 주요 동작(라이브러리 `열기`)에만 쓴다. 켜진 토글(사이드바·번역 패널·싱크)은 연한 파랑 보조 버튼, 꺼진 토글은 회색 고스트. 헤더의 이모지(🔒)는 선 아이콘으로 교체.
- 라이브러리는 design.md의 중앙 레인을 따르되 칩이 많아 480px 대신 720px로, 64px 행·헤어라인 구분선 목록으로 바꿨다.
- 리더는 원문·번역을 나란히 보는 데스크톱 도구라 모바일 우선 480px 레인은 적용하지 않고 토큰·컴포넌트만 적용했다. PDF 페이지는 문서 모양 유지를 위해 4px, 번역 카드는 12px 라운드.
- 웹 폰트는 내려받지 않는다 (로컬 전용 앱, 시스템 폰트 폴백).

---

## Phase 3

### D3-1. "아직 안 만든 것"과 "틀린 것"의 구분
- `highlights.md`/`figure_notes.md`가 없으면 검사를 건너뛴다 (오류 아님). `.ko.md`가 없는 페이지는 "미번역"으로 done/total에만 반영한다. Phase 5의 페이지 단위 번역(`translate_page`)이 부분 번역 상태를 정상으로 만들기 때문.
- 대신 존재하는 파일 안에서는 §5.5 그대로 엄격하다: `.ko.md`에 src 블록이 빠지면 ERROR, 모르는 ID ERROR, `figure_notes.md`가 있으면 모든 피규어에 F 블록이 있어야 ERROR가 없다.
- skill은 요약 줄의 `translation N/N`과 `figure notes N/N`을 완료 조건으로 확인한다. viewer.json의 `annotations_verify`는 주석 파일이 하나도 없으면 null.

### D3-2. 하이라이트 밀도 규칙의 짧은 논문 처리
- §6의 "15–40개이면서 ≤ 1.5 × 페이지 수"는 10페이지 미만 논문에서 모순이다 (예: 3페이지 → 상한 4 < 하한 15). 하한을 `min(15, 상한)`으로 둔다. 밀도는 WARN일 뿐이다.

### D3-3. evidence 파서
- `annotations.parse_evidence`를 새로 두고(loc·category·note까지 읽음) viewer 쪽은 모두 이것을 쓴다. `verify.py`의 `load_evidence`는 그대로 둔다 — digest 검증 동작을 바이트 단위로 유지하기 위해. 블록 문법은 같다.

### D3-4. 번들은 검증 결과에서 만든다
- `build_viewer`는 `verify_annotations`를 호출해 그 결과를 그대로 묶는다: 앵커링에 성공한 하이라이트, 형식이 맞는 F 블록만 들어간다. 검증과 번들이 다른 기준을 갖는 일을 막는다.
- §5.5 표 외에 추가한 WARN: 한국어 요약 120자 초과, `요약:` 줄 없음, 이유 없는 SKIP, 같은 피규어의 두 번째 F 블록(첫 번째 사용).
- golden 번들: `tests/fixtures/viewer.sample.json` (`built_at` 제외 비교). 갱신은 `scripts/internal/build_viewer.sh --update-golden`.
- fixture의 번역·하이라이트·해설 텍스트(good/bad)는 `fixtures.py`에 있다. 테스트 데이터일 뿐 논문 내용 생성이 아니다 (§14.5). e2e의 Demo 논문도 이제 주석이 붙은 상태로 준비된다.

### D3-5. skill이 쓰는 명령
- headless 세션은 `Bash(scripts/internal/*)`만 허용되므로, `layout.sh`가 폴더 경로 외에 폴더 이름·out_root 기준 상대경로도 받아 `[layout] folder: <path>`를 출력하게 했다. skill은 이 경로를 이후 단계에 쓴다.
- `scripts/annotate.sh`는 `-n` 없이 실행하면 "digest verify PASS + 주석 미완료(번역·하이라이트·피규어 해설 중 하나라도)"인 논문을 `max_papers`개까지 처리한다 (`python -m functions.papers`가 목록 제공).
- `viewer.auto_annotate: true`이면 `digest.sh`가 배치가 끝난 뒤 `annotate.sh`를 실행한다 (같은 선택 규칙이라 방금 PASS한 논문이 포함된다).

### D3-6. 전처리 job
- 동시에 1개, 나머지는 큐. 같은 폴더의 job이 대기·실행 중이면 새로 만들지 않고 그 job을 돌려준다.
- 로그는 메모리(SSE 스트림용)와 `.work/viewer/jobs/<timestamp>.log`에 남긴다. 서버 종료 시 실행 중인 프로세스를 terminate.
- `PAPER_VIEWER_ANNOTATE_CMD` 환경변수로 명령을 바꿀 수 있다. selftest와 e2e는 Claude를 부르지 않는 stub을 쓴다.

### D3-7. 실제 실행 1회 (Phase 3 Acceptance)
- 대상: vault의 `Robust Recovery Controller Quadrupedal Robot (2019)` (9페이지, 블록 172, 번역 대상 106, 피규어/표 13). 명령 `scripts/annotate.sh -n "Robust Recovery Controller Quadrupedal Robot (2019)"` (Claude Code 2.1.285, headless).
- 결과: 5분 7초, exit 0. 번역 106/106, 피규어 해설 13/13 (OK 13, SKIP 0), 하이라이트 45개(전부 evidence 유래, H 블록 0), verify_annotations PASS (ERROR 0, WARN 6 — 모두 밀도), viewer.json 생성.
- headless에서 PNG Read: 허용 플래그(`--allowedTools "Bash(scripts/internal/*)" "Read"`)로 동작했다. 해설에 이미지에서만 읽을 수 있는 내용을 `[FIG: …]`로 표시했고 SKIP이 없었다 (직접 증거는 아니고 결과로 판단).
- 품질 표본 확인: 번역은 문장 단위로 충실하고 인용 번호 `[16]`이 보존되며 glossary 용어(자세 복원, 행동 선택기 등)가 일관됨. 해설은 `[E#, p.N]`/`[FIG]`/`[INTERP]` 표시가 정확함.
- **발견:** evidence.md(57블록)의 problem/method/result 등이 자동으로 모두 하이라이트되어 45개가 된다. §6 밀도 규칙(9페이지 → 최대 13, 페이지당 4)을 evidence만으로 넘는다. skill은 evidence를 고칠 수 없으므로 WARN으로 남았다. 해결은 Phase 4(하이라이트 레이어)에서 정한다 — 후보: evidence 유래는 카테고리별 대표만 기본 표시 / 사이드바 필터로 충분 / 밀도 규칙을 H 블록에만 적용.

## Phase 3.5 — 논문 관리 재구성 (사용자 요청)

### D3.5-1. "Method Not Allowed"의 원인
- 8765 포트의 서버가 Phase 3 커밋(19:43)보다 먼저(19:27) `--reload` 없이 떠 있었다. 그 코드에는 `POST /annotate`가 없어서, POST가 GET 전용 SPA catch-all에 걸려 405가 났다. 코드 버그가 아니라 오래된 프로세스 문제다.
- 대응: 재시작. 다시 생겨도 원인을 알 수 있도록 클라이언트가 405를 "서버가 오래됨 — scripts/viewer.sh 재시작"으로 보여준다. 서버 버전 비교 같은 장치는 만들지 않았다 (로컬 1인용).

### D3.5-2. 레지스트리: 내용 해시를 키로 하는 YAML 하나
- 요구: src/를 지우지 않고, src/·출력 폴더·작업 상태를 한 파일에서 관리해 중복 처리를 막는다.
- 선택: `<out_dir>/.paper-registry.yaml`. 키 = PDF SHA-256 앞 16자. 항목 = `name`, `folder`(out_dir 기준, 미처리면 null), `sources`(src/ 경로 → `size-mtime_ns`), `state`, `digest`, `translation`, `highlights`, `figure_notes`.
  - 내용 해시라서 파일 이름이 바뀌거나 같은 PDF가 두 번 들어와도 한 논문이다. 파일 경로를 키로 쓰면 이름만 바꿔도 다시 처리된다.
  - 위치를 out_dir에 둔 이유: 레지스트리가 설명하는 대상(출력 폴더)과 함께 움직인다. 점 파일이라 Obsidian 색인에서 빠진다. §14의 vault 쓰기 허용 목록에 이 파일과 `.paper-jobs/`(아직 폴더가 없는 논문의 job 로그)를 추가한다.
  - YAML: 사람이 열어 볼 수 있는 로그가 요구였다. 그래프/DB는 수십~수백 편 규모에서 이득이 없다.
- **진실의 원천은 디스크**, 레지스트리는 캐시: `sync()`가 출력 폴더 스캔 + src/ 스캔으로 매번 다시 만든다. 지워도 해시 계산 한 번으로 복구되고, 출력 폴더를 지우면 그 논문은 다시 `new`가 된다. 폴더를 옮기면 해시로 같은 논문임을 알아본다. 해시는 src/ 파일의 `size-mtime`이 바뀔 때만 다시 계산하고, 출력 폴더의 PDF는 한 번 계산한 뒤 재사용한다 (iCloud에서 내려받지 않은 PDF는 해시를 못 하므로, 처음 내려받기 전까지는 중복 검사에서 빠진다).
- 쓰기는 임시 파일 + `os.replace`로 원자적. 서버와 CLI가 동시에 써도 반쪽 파일은 없고, 마지막 쓰기가 이긴다 (어차피 다시 만들 수 있는 캐시).

### D3.5-3. prepare 동작 변경
- PDF를 이동하지 않고 복사한다. src/는 읽기 전용 입력 폴더.
- `-n` 없이: 출력 폴더가 없는 src/ PDF만 선택 (`max_papers`는 거른 뒤에 적용).
- 같은 내용의 폴더가 있으면: digest PASS → `skip (already digested)`, exit 4 (`digest.sh`는 4를 "할 일 없음"으로 보고 0으로 끝냄). 폴더는 있는데 digest가 없거나 FAIL → 재추출 없이 `ready`(이어서). 이 덕분에 headless에서 `--force` 없이도 실패한 digest를 다시 돌릴 수 있다.
- exit 3은 이제 "다른 PDF의 폴더가 같은 이름" (이름 충돌)만 뜻한다.

### D3.5-4. 단계별 실행
- `POST /api/papers/{id}/run {"action": all|digest|translation|highlights|figures}`가 `/annotate`를 대체한다. job은 스크립트 단계 목록이며 첫 실패에서 멈춘다. 논문당 동시에 1개 (action과 무관하게 기존 job을 돌려줌).
- digest = `digest.sh -n <PDF>`, 주석 단계 = `annotate.sh -n <폴더> --only <part>`. all = (PASS가 아니면) digest → `annotate.sh -n` (`--only` 없음 → skill이 verify_annotations로 완료된 부분을 건너뜀). 새 논문은 아직 폴더가 없으므로 annotate 단계에 src/ PDF 경로를 넘기고, `papers.resolve_for_annotate`가 레지스트리로 폴더를 찾는다.
- "핵심 추출"은 별도 단계로 나누지 않았다: evidence 추출은 digest의 앞부분이고 report/summary와 분리하면 skill 순서(증거 → 검증 → 작성)가 깨진다. 핵심 문장 선택은 Highlights 단계다.
- 서버 검증: 새 논문에 주석 단계 → 409, digest PASS 논문에 digest → 409, 알 수 없는 action → 422.
- 테스트용 `PAPER_VIEWER_ANNOTATE_CMD`는 `PAPER_VIEWER_JOB_CMD`로 바뀌었다 (stub 뒤에 스크립트 이름과 인자가 붙는다). src/는 `PAPER_VIEWER_SRC`로 바꿀 수 있다.

### D3.5-5. 영어 UI, `target_lang`
- UI 문자열은 영어만 (`i18n.ts`의 `t()`는 유지해 호출부는 그대로).
- `configs/cfg.yaml` 최상위 `target_lang`(기본 `ko`). 적용 범위는 리더용 주석: `pNNN.<lang>.md`, figure_notes의 `#### <lang>`, highlights의 `note_<lang>`. 언어마다 파일이 따로라 언어를 바꿔도 기존 번역이 덮이지 않는다.
- viewer.json은 언어 중립 키로 바꿨다: `figures[].note.tr`, `highlights[].note_tr`, 최상위 `lang`. golden 갱신.
- 미번역 경고는 한글 검출 대신 "원문과 같음"으로 바꿔 모든 언어에서 동작한다. 해설 요약 줄 라벨은 `요약:`(한국어) 또는 `Summary:`.
- digest 보고서(한국어 → 영어)는 범위 밖으로 남겼다. verify.py의 ko/en 구간 검사와 paper-digest skill을 함께 바꿔야 하는 별도 작업이다.

### D3.5-6. AI 백엔드: Claude / ChatGPT / Gemini (배포용)
- 문제: 파이프라인이 `claude -p`(개발자 본인의 Claude Code 로그인)에 묶여 있었다. 다른 사용자는 자기 계정·키로 원하는 AI를 써야 한다.
- 선택: **각 회사의 에이전트 CLI를 그대로 쓴다** — Claude Code(`claude -p`), Codex CLI(`codex exec`, ChatGPT/OpenAI), Gemini CLI(`gemini -p`). 공용 진입점 `scripts/internal/agent.sh SKILL 'ARGS'`가 `configs/cfg.yaml`의 `agent.backend`/`agent.model`(또는 `$PAPER_AGENT`)에 따라 명령을 만든다. `digest.sh`·`annotate.sh`·리더의 job이 모두 이 스크립트를 거친다.
  - 대안이었던 API 직접 호출(Anthropic/OpenAI/Gemini SDK)은 파일 읽기·셸 실행·검증 루프를 갖춘 에이전트를 직접 만들어야 한다. CLI들은 이미 로그인(구독 또는 API 키), 파일 도구, 이미지 읽기, 권한 제어를 갖고 있다. 키는 각 CLI가 관리하므로 이 프로젝트는 키를 저장·전달하지 않는다.
  - skill은 평문 markdown이라 그대로 공유한다. Claude는 `/skill`로, Codex·Gemini는 "`.claude/skills/<skill>/SKILL.md`를 읽고 따르라, 규칙은 CLAUDE.md"라는 프롬프트로 실행한다. AGENTS.md/GEMINI.md 사본은 만들지 않았다 (규칙이 두 군데로 갈라짐).
  - 품질 보증은 모델이 아니라 스크립트(verify.sh, verify_annotations.sh)가 한다. 다른 모델은 수정 라운드가 늘 수 있지만 검증 안 된 인용은 통과하지 못한다.
- 권한 (설치된 버전의 `--help`와 공식 문서로 확인: Codex CLI 0.160.0, Gemini CLI 0.62.0):
  - claude: `--permission-mode acceptEdits --allowedTools "Bash(scripts/internal/*)" "Read" --add-dir <out_dir>` (기존과 같음; digest에도 Read 명시).
  - codex: `exec --sandbox workspace-write -c approval_policy=never -c sandbox_workspace_write.network_access=true --add-dir <out_dir> --skip-git-repo-check`. 셸 명령 자체는 제한되지 않지만 쓰기는 프로젝트와 out_dir로 제한. 네트워크는 prepare의 arXiv/Crossref 조회에 필요.
  - gemini: `-p … --approval-mode auto_edit --policy configs/gemini-policy.toml --include-directories <out_dir> --skip-trust`. 정책 파일이 `run_shell_command`를 `scripts/internal/` 접두어로만 허용한다. headless에서 `ask_user`는 deny로 처리되므로 나머지 셸 명령은 실행되지 않는다. (`--allowed-tools`는 deprecated라 정책 엔진을 썼다.)
- `agent.sh --check`: 백엔드·모델·CLI 버전·로그인 방법 출력, CLI가 없으면 설치 명령과 함께 exit 127. `digest.sh`/`annotate.sh`는 루프 전에 한 번 호출해 논문마다 같은 실패가 반복되지 않게 한다. `--dry-run`은 실행 없이 명령을 출력하며, selftest가 세 백엔드의 핵심 플래그를 이것으로 확인한다 (실제 AI 호출 없음).
- Codex·Gemini로 실제 논문을 돌려 보지는 않았다 (이 개발 환경에 설치·로그인 없음). 첫 실행에서 skill 해석이나 권한 문제를 확인해야 한다.
- 뷰어 계획의 `viewer.llm_backend`(Phase 5 대화형 기능용)는 아직 쓰이지 않는다. Phase 5에서는 같은 `agent.backend`를 쓰는 방향으로 정리한다.
- `configs/cfg.yaml`은 개인 `out_dir` 때문에 skip-worktree 상태다. 저장소에는 `out_dir`만 비운 같은 내용(새 키 포함)을 index에 직접 넣어 커밋했고, 로컬 파일은 그대로 둔다.
- 배포 문서: `README.md`(영어, 처음 쓰는 사용자 대상)를 새로 만들고, 내용이 낡은 `SETUP_GUIDE.md`(PDF 이동 등)는 README로 흡수해 삭제했다.

## Phase 4 — 오버레이 (하이라이트·피규어 해설; bbox 수정은 남음)

### D4-1. 하이라이트는 실시간 오버레이 (PDF에 굽지 않음)
- 사용자 제안: 실시간 렌더링이 비싸거나 불안정하면 하이라이트를 PDF에 넣은 별도 파일을 만들 것. 측정해 보니 오버레이로 충분해 굽지 않았다.
  - rect마다 절대 위치 div 하나, `pointer-events: none`, `mix-blend-mode: multiply`, 알파 0.24. 렌더된 페이지(화면 ±2)에만 존재하고 캔버스를 다시 그리지 않는다. 실제 논문(하이라이트 45개, 화면에 rect 81개)에서 문제없음, 50페이지 스크롤 long task 0 유지.
  - 정확도: fixture E1 시작점과 pdf.js text layer의 같은 단어 차이 dx 1.20pt, dy 0.24pt (기준 2pt, e2e로 매번 측정).
- 원본과 분리된 하이라이트 PDF는 Phase 6의 `<name> - annotated.pdf` 내보내기로 남긴다 (보기용으로는 필요 없음).
- hover tooltip은 오버레이 요소가 아니라 기존 hit-test(figure > highlight > block)로 띄운다. 그래서 하이라이트 위에서도 텍스트 선택이 그대로 된다.

### D4-2. 밀도 문제(D3-7)의 처리
- 사이드바 하이라이트 탭에 카테고리별 체크박스와 개수, 헤더 토글과 `H` 단축키를 두었다 (계획 §8.6, 이전에 권한 1번안). 기본은 전부 표시. 숨긴 카테고리는 localStorage에 기억.
- 밀도 규칙을 H 블록에만 적용하는 3번안은 사용자 결정이 없어 보류했다. verify_annotations의 WARN은 그대로다.

### D4-3. 피규어 해설 popover
- 열기: 피규어 영역에 350ms 체류, 또는 우하단 ⓘ 배지에 hover(즉시). 닫기: 피규어와 popover를 모두 벗어나고 200ms. 배지 클릭 또는 피규어 안 단순 클릭(텍스트 선택이 없을 때) → 고정, Esc·바깥 클릭·×로 닫음. 하나만 열린다. 타이밍은 `lib/popover.ts`(fake timer 단위 테스트).
- 위치: 처음엔 PDF 패널 스크롤 영역 안(absolute)에 두었으나, 실제 논문에서 피규어 아래 화면 끝에 잘렸다. → `position: fixed`로 바꾸고 `placePanel`(오른쪽 → 왼쪽 → 아래 → 위, 뷰포트 clamp)로 배치. 오른쪽 번역 패널 위로 뜰 수 있어 공간이 넉넉하다. PDF 패널 스크롤 시 rAF로 다시 배치해 피규어를 따라간다.
- 내용: label, 요약(굵게), 본문(`- ` 줄은 목록), 인용 마커 렌더(`[E#, p.N]` → 칩, hover 시 evidence 원문, 클릭 시 페이지 이동; `[FIG]`·`[CALC]`·`[INTERP]`·`[EXT]` → 회색 배지), 목표 언어/EN 토글(기억됨). SKIP이면 이유, 해설이 없으면 라이브러리에서 실행하라는 안내. confidence < 0.6이면 점선 외곽선, 배지 `?`, 경고 문구.
- 계획의 `[자세히]`·`[질문하기]`·`[지금 생성]` 버튼은 Phase 5(실시간 AI) 기능이라 넣지 않았다. `[FIG]` 배지 클릭 이동, 번역 패널 피규어 이미지의 popover도 이후로 미뤘다.

### D4-4. 사이드바·번역 패널
- 사이드바 탭: 아웃라인 · 하이라이트(카테고리 → 페이지 순 목록, 클릭 시 이동 + flash) · 피규어(썸네일 목록, 클릭 시 이동 + popover 고정).
- 번역 패널: 하이라이트가 걸린 블록 왼쪽에 카테고리 색 3px 막대 (블록 단위, rect 중심이 들어가는 가장 작은 블록).

### D4-5. viewer.json 스키마 버전
- 실제 논문에서 해설이 영어로만 나왔다. D3.5-5의 키 변경(`ko`→`tr`) 이전에 만든 viewer.json이 입력 파일 mtime 기준으로는 최신이라 재빌드되지 않았기 때문이다. → `VERSION = 2`, `ensure_viewer`가 저장된 버전이 다르면 재빌드 (키가 정렬돼 `"version"`이 파일 끝에 있으므로 끝 64바이트만 읽는다). 앞으로 스키마를 바꾸면 VERSION을 올린다.

### D4-7. 하이라이트 = 큰 틀의 읽기 지도 (evidence는 하이라이트하지 않음) — 사용자 요청
- 문제: evidence.md의 세부 인용이 전부 하이라이트되어(실제 논문 45개) 핵심이 묻혔다. 사용자 요청: evidence는 내부와 보고서에만 쓰고, 하이라이트는 논문 전체 구조를 잡는 핵심만 요약적으로.
- 변경:
  - 하이라이트 = `/paper-annotate`가 고른 H 블록만. evidence 자동 하이라이트와 "evidence와 중복" 경고 삭제. viewer.json의 `evidence`는 피규어 해설 인용 칩용으로 그대로 둔다.
  - 카테고리(읽는 순서): `problem`(풀려는 문제) · `assumption`(핵심 가정) · `prior_work`(기존 방법과 한계) · `contribution` · `method`(핵심 방법) · `result`(주요 결과) · `insight`(핵심 통찰 — 큰 틀에 도움이 되는 것 자유롭게) · `limitation`. 사용자가 든 예시 여섯에 자유 항목 둘을 더했다. 색과 사이드바 필터에 쓰이므로 자유 텍스트 카테고리는 두지 않았다.
  - 하이라이트 원문은 계속 verbatim(앵커링·검증 가능해야 하므로). "요약적으로"는 메모가 맡는다: `note_<lang>`이 "역할: 한 줄 요약" 형식이고, 사이드바는 메모를 앞에, 인용을 작게 보여 준다 → 사이드바 하이라이트 탭이 "이 논문의 핵심" 요약표가 된다. 하이라이트가 있는 논문은 이 탭으로 열린다.
  - skill 6단계: 먼저 한 줄씩 개요를 쓰고, 각 줄을 가장 잘 말하는 원문 한 문장에 고정하는 두 단계. 밀도 8–24(짧은 논문 3×페이지), 페이지당 6 (서론 페이지에 문제·기존 방법·가정·기여가 모이므로 4에서 올림).
  - 검증: 핵심 5개(problem, prior_work, contribution, method, result) 누락 시 WARN, 메모 없으면 WARN. `assumption`은 논문에 따라 없을 수 있어 필수에서 뺐다.
  - 스키마 VERSION 3 (`source` 필드 삭제). 쓰이지 않던 `viewer.highlight_default_categories` 설정 삭제.
- D4-2의 밀도 문제는 이것으로 해소된다 (3번안보다 근본적인 해결).
- 실제 실행 (vault `Robust Recovery Controller Quadrupedal Robot (2019)`, `scripts/annotate.sh -n … --only highlights`, Claude Code 2.1.285): 1분 17초, exit 0. 하이라이트 45개(evidence) → 20개 (problem 1, prior_work 3, assumption 1, contribution 3, method 4, result 4, insight 2, limitation 2), 페이지당 최대 6, verify_annotations PASS (ERROR 0, WARN 0). 메모가 "역할: 요약" 형식으로 쓰였고 숫자(97%, 50가지, 1 cm)는 인용 문장에 있는 값이었다.
- 기존 주석 논문의 highlights.md(H 블록 0개)는 하이라이트가 비게 된다. `Process ▸ Highlights`로 다시 만들어야 하며, Run all의 "완료" 판정도 H 블록 수 기준으로 바꿨다.

### D4-8. 뷰어 포트 충돌 (`[Errno 48] address already in use`)
- 원인: 에이전트가 확인용으로 `nohup scripts/viewer.sh &`로 띄운 서버(부모가 사라진 고아 프로세스)가 8765를 잡고 있었다. 정상 종료(Ctrl+C)하면 포트는 바로 풀린다. 문제는 남은 프로세스이며, 남은 서버는 예전 405 오류처럼 옛 코드를 계속 서빙한다.
- 대응 (`functions/viewer/port.py`, viewer.sh 시작 시 호출):
  - 포트가 비어 있으면 그대로 쓴다. 검사는 uvicorn처럼 `SO_REUSEADDR`로 바인드한다 (그렇지 않으면 직전 연결의 TIME_WAIT 때문에 빈 포트를 사용 중으로 오판한다 — 시험 중 실제로 발생).
  - `GET /api/health`가 `{"app": "paper-viewer"}`이면 남은 뷰어로 보고 SIGTERM으로 종료한 뒤 그 포트를 쓴다. 종료 대상은 health의 pid와 `lsof`로 찾은 그 포트의 LISTEN 프로세스(`--reload`에서는 소켓을 supervisor가 가짐)뿐이다. 처음에는 부모 프로세스를 명령줄에 "uvicorn"이 있는지로 판단했으나, 그 문자열을 포함한 셸까지 죽이는 것을 시험에서 확인해 버렸다.
  - 다른 프로그램이면 건드리지 않고 다음 빈 포트(최대 20개)로 옮기고 알린다.
- `--dev` 종료: trap이 자기 자식 트리(uvicorn reloader, npm → vite)만 재귀로 종료한다. `kill 0`은 호출한 쪽의 프로세스 그룹까지 죽여서 쓰지 않았다.
- 시험(별도 스크립트): 첫 뷰어 → 두 번째 실행이 교체, SIGINT 후 포트 해제, 다른 프로그램이 점유 시 8766으로 이동하고 그 프로그램은 유지, 남은 `--dev` 뷰어 교체, `--dev` SIGTERM 후 포트·프로세스 0. selftest에 포트 선택 검사 추가.
- health 엔드포인트가 없는 이전 버전 서버는 자동 식별이 안 된다 (이번 고아 프로세스는 수동 종료).

### D4-9. 모든 처리 단계를 독립 실행, 준비(복사·등록)는 항상 먼저 — 사용자 요청
- 문제: 아직 준비 안 된 src/ 논문은 Translation·Highlights·Figure notes가 비활성(서버 409)이어서 Summary를 먼저 돌려야 했다.
- 변경:
  - 리더의 모든 job 첫 단계 = `scripts/internal/prepare.sh --ensure -n <PDF>`: PDF 복사, 텍스트 추출, 레지스트리 등록 (AI 없음, 이미 준비됐으면 즉시 통과). `--ensure`는 digest PASS 논문도 exit 4 대신 `ready`/0으로 끝낸다.
  - 그다음 요청한 단계만: Translation/Highlights/Figure notes = `annotate.sh --only`, Summary = `digest.sh`, Run all = (PASS 아니면) digest → 남은 주석. 새 논문의 409 제거, 메뉴 전부 활성 (막는 것은 이미 PASS인 Summary 재실행뿐).
  - CLI도 같다: `annotate.sh -n NAME`에 준비 안 된 PDF(경로 또는 src/ 이름)를 주면 먼저 `prepare --ensure`. `papers.resolve_for_annotate`가 src/ 이름을 레지스트리로 폴더에 연결한다.
  - skill: digest(보고서·요약·evidence)는 있으면 참고, 없어도 pages.md만으로 진행. evidence가 없을 때 피규어 해설의 본문 숫자는 `[p.N]`으로 인용 (verify가 페이지 범위를 검사, 화면에서는 페이지 이동 칩).
- 하이라이트는 원래 evidence와 무관(D4-7)하고 번역은 pages.md·layout만 쓰므로, 실제로 digest에 기대던 것은 피규어 해설의 `[E#]` 인용뿐이었다.

### D4-10. 실행마다 모델·effort 선택 — 사용자 요청
- 라이브러리 상단에 Model(입력 + datalist 제안)과 Effort(select) 선택기. 고른 값은 이후 Process 실행에 쓰이고, 브라우저 localStorage에 backend별로 기억한다. 비우면 cfg.yaml의 `agent.model` / `agent.effort` (그것도 비면 CLI 기본값).
- 전달: `POST …/run {action, model, effort}` → job 환경변수 `PAPER_AGENT_MODEL` / `PAPER_AGENT_EFFORT` → `agent.sh`가 `claude --model … --effort …`, `codex -m … -c model_reasoning_effort=…`, `gemini -m …`로 변환 (Gemini CLI는 effort 옵션이 없어 무시하고 알림). 터미널에서도 같은 환경변수로 1회 지정.
- 모델 목록은 코드의 제안값(Claude: opus 5.5, sonnet 5.5, fable 5.1, haiku 4.5 ID)이고, Codex/Gemini는 모델명이 자주 바뀌어 제안 없이 직접 입력. `agent.models`로 목록을 바꿀 수 있다. CLI가 계정에서 쓸 수 있는 모델을 조회하는 공식 방법이 없어, "내 계정에서 되는 모델"은 실행 시 CLI가 판단한다 (안 되면 job 로그에 CLI 오류).
- 서버는 모델명을 `MODEL_RE`(영숫자 . _ : / @ -)로, effort를 backend의 허용 목록으로 검사한다 (명령줄로 가는 값). job 로그 첫 줄에 선택값을 남긴다.

### D4-11. 출력은 report 하나, 이름은 `<name> [summary].md` — 사용자 요청
- 1페이지 summary를 없애고 상세 report만 쓴다. 파일명은 `<name> - report.md` 대신 `<name> [summary].md` (`verify.output_path`).
- `templates/summary.md` 삭제, verify는 이 파일 하나만 검사. 기존 `- report.md` 폴더는 이름을 바꾸기 전까지 미완료로 보인다.

### D4-12. 출력 트리는 src/를 따른다, 라이브러리 폴더 트리, 병렬·일괄 처리 — 사용자 요청
- 새 논문은 원래부터 src/ 하위 경로를 따라 만들어졌다(`prepare.target_dir`). 추가: src/에서 PDF를 다른 폴더로 옮기면 출력 폴더도 따라간다 (`registry.relocate`). 실행 시점은 그 논문의 prepare, job이 없을 때 viewer의 목록 갱신, `registry.sh`. 실행 중인 job이 있으면 옮기지 않는다 (경로가 바뀌면 job이 깨진다). 목적지가 이미 있으면 그대로 둔다. 비워진 이전 폴더는 지운다.
  - 결과: Obsidian에서 출력 폴더를 직접 옮겨도 src/ 위치로 되돌아간다. 구조를 바꾸려면 src/에서 옮긴다. 폴더가 옮겨지면 paper id(folder_rel 해시)도 바뀐다.
  - CLI(`digest.sh`)와 viewer가 동시에 돌면 viewer가 CLI가 처리 중인 폴더를 옮길 수 있다 (viewer는 자기 job만 안다).
- 라이브러리: 평평한 `h2` 그룹 대신 `<details>` 폴더 트리(중첩, 접기). 폴더 체크박스는 하위 전체 선택(부분 선택은 indeterminate), "Select all"은 검색 결과 전체. "Run on selected"는 선택 순서가 아니라 목록 순서로 큐에 넣고, 이미 끝난 단계·실행 중·evicted는 건너뛴다.
- 병렬: `parallel`(cfg.yaml, 1..10, 기본 3)개 worker thread. 사용자가 5? 10?을 물어 상한 10. 각 job은 별도 에이전트 세션이라 요금제 rate limit이 실제 한계다. 값을 올리면 다음 submit에 반영, 내리면 재시작 후.
- job 진행 표시: 페이지당 job별 SSE(`/api/jobs/{id}/events`)를 없애고 `GET /api/jobs` 1초 폴링 하나로. HTTP/1.1 브라우저 동시 연결 6개 제한과 서버 스레드 점유 때문. 덤으로 새로고침해도 이번 서버 실행의 로그가 다시 보인다.
- job 로그 파일명에 job id 추가 (같은 초에 시작한 새 논문 job들이 `.paper-jobs/`에서 같은 파일을 쓰지 않게).
- CLI `digest.sh`/`annotate.sh`는 여전히 한 번에 한 논문.

### D4-13. VS Code식 트리, 원형 선택, 끊긴 job 이어하기, Process 3단계 — 사용자 요청
- 라이브러리는 `<details>` 카드 목록 대신 평평한 행의 트리: 들여쓰기 16px/단계, 부모 chevron 아래 1px 가이드(배경 gradient), 폴더 접힘 상태는 localStorage. 선택은 오른쪽 끝 원형 체크(`role=checkbox`, 폴더 부분 선택은 mixed), 선택된 행은 줄 전체 `--accent-soft`. 행이 한 줄이라 라이브러리 폭 720 → 960px, 760px 미만에선 칩을 숨긴다.
- Process: Summary / Translation / Annotation(= highlights + figures, `annotate.sh --only highlights,figures`). 요청은 "3가지"였지만 Run all은 단계가 아니라 묶음이라 맨 위에 남겼다. API action: `all | digest | translation | annotation`.
- job 상태 저장: 논문별 최신 job을 `<out_root>/.paper-jobs/jobs.json`에 기록(원자적 쓰기). 서버 시작 시 queued/running으로 남은 job은 `interrupted`("Stopped while running")로 복원, 로그 끝 200줄과 함께. 정상 종료(Ctrl+C) 중 끊긴 job도 interrupted. 에이전트가 실패하면(API 끊김 등) `failed`.
- job은 paper id 대신 PDF sha로 키를 잡는다(`PaperEntry.sha`): 새 논문이 준비되거나 폴더가 옮겨져 id가 바뀌어도, 재시작 후에도 같은 논문을 찾는다. paper id 자체는 viewer.json과 URL에 쓰이므로 그대로 둔다.
- Resume = 같은 action·model·effort로 다시 실행 + `--resume`. 스크립트(`digest.sh`, `annotate.sh`)와 두 skill이 이를 받아 verify를 통과한 작업(번역 페이지, evidence, F 블록, highlights)은 두고 나머지만 한다. 에이전트 세션 자체를 잇는(`claude --resume`) 방식은 백엔드마다 달라 쓰지 않았다. 결과물이 파일이고 verify가 완료를 판단하므로 파일 기준으로 잇는다.

### D4-14. 상태 아이콘, 진행 바, 논증 구조 기반 하이라이트 — 사용자 요청
- 논문 행의 칩(Summary PASS, Translation n/n, Highlights n, Figure notes n/n)을 선 아이콘 4개로 바꿨다: 출력 폴더에 준비됨 / 번역 완료 / 하이라이트 있음 / figure note 완료. 미완료는 회색 선, 완료는 `--accent` 선. 숫자는 tooltip과 aria-label("Translation 120/248: not yet")에 남긴다. 요청한 4개에 Summary가 없어 행에서 Summary 상태는 빠졌다. Process 메뉴의 체크 표시로는 여전히 볼 수 있다. New·iCloud 칩은 상태 경고라 유지. 760px 미만에선 이름이 첫 줄, 아이콘·버튼이 둘째 줄 오른쪽.
- 진행 바(검색창 아래): job에 `submitted / started / ended`(epoch 초)를 더해 `/api/jobs`와 jobs.json에 싣는다. 한 "실행"은 queued/running job 전부와, 그중 가장 이른 제출 시각 뒤에 끝난 job이다(그래서 새로고침이나 재시작 뒤에도 서버 데이터만으로 계산된다). 남은 시간은 이번 실행에서 성공한 job의 평균 소요 시간 × 남은 작업량 ÷ min(parallel, 남은 job 수)다. 첫 job이 끝나기 전에는 "Estimating…"을 보인다. 단계(요약·번역)가 달라도 평균 하나만 쓰는 대략값이다. 계산은 `web/src/pages/progress.ts`에 있고 unit test로 확인한다.
- 하이라이트: 실제 결과(RMA)는 문장 하나하나는 맞지만, 카테고리별로 따로 골라 기여–방법–결과의 연결이 없었고, 본문 중간(방법 세부, 실험)이 비어 PDF 위에서는 흩어져 보였다. skill 6단계를 4 pass로 다시 정의했다. (1) highlights.md 맨 위에 `## Reading map`(Thesis, Problem, Gap, 기여별 `C#: … | how: … | shown by: …`, Scope, Insight, Limits)을 먼저 쓴다. (2) map 줄마다 찾을 섹션과 cue phrase 표를 따라 한 문장에 앵커한다. how는 방법 섹션, shown by는 실험 섹션에서 찾고, abstract는 최대 2개다. (3) 필요·구체·자기완결·비중복 네 가지 기준으로 거른다. (4) 메모만 순서대로 읽어 초록이 되는지 감사한다. H 블록에 `claim: C#`을 달고, verify_annotations는 C#마다 contribution·method·result 하이라이트가 없으면 WARN을 낸다. viewer는 Reading map과 claim을 무시하므로 viewer.json 스키마는 그대로다. 기존 highlights.md는 그대로 유효하다. 새 방식으로 바꾸려면 `Process ▸ Annotation`이나 `annotate.sh --only highlights`로 다시 만든다.

### D4-15. 시작 시 새 PDF 바로 준비, 선택 모드, 상단 Process 메뉴 — 사용자 요청
- 뷰어가 뜨거나 목록을 다시 읽을 때 새 src/ PDF를 백그라운드(`Preparer`, jobs.py)에서 하나씩 `prepare.sh --ensure`로 준비한다. 이름 변환, 출력 폴더로 복사, 텍스트 추출까지다. PDF마다 뷰어 실행당 한 번만 시도한다(스캔본은 New로 남는다). 상태는 `GET /api/prepare`로 제공한다. 1초 넘게 걸리면 진행 바 위에 "Moving new PDFs to the output folder · n / N"(현재 파일명)을 보이고, 끝나면 사라진다. 하나 끝날 때마다 목록을 다시 읽는다.
- prepare.py는 출력 root의 `.paper-prepare.lock`(flock)으로 한 번에 하나만 돈다. 준비 중인 PDF에 job이 돌면 job의 prepare 단계는 잠금을 기다렸다가 "already prepared"로 지나간다. 병렬 job 두 개가 새 PDF를 동시에 준비하며 registry를 덮어쓰던 기존 경합도 함께 막힌다. 준비 중에는 폴더 이동(relocate)도 하지 않는다.
- 사고와 방지: 처음 구현 때 selftest가 stub을 설정하기 전에 `/api/papers`를 불렀다. 그 바람에 백그라운드 준비가 실제 prepare.sh를 실행했고, 테스트 PDF `fresh`가 cfg.yaml의 out_dir(실제 vault)에 만들어졌다. prepare.sh는 `PAPER_VIEWER_OUT`을 모르기 때문이다. 고친 점은 두 가지다. selftest는 서버를 띄우기 전에 stub을 설정한다. 서버는 `PAPER_VIEWER_OUT`이 설정됐는데 stub이 없으면 백그라운드 준비를 하지 않는다.
- 라이브러리 폭 960 → 1200px. 원형 선택과 Select all은 평소에 숨기고, 목록 우측 상단 **Select**를 누르면 나타난다. 다시 누르면(Done) 선택이 풀린다.
- 행마다 있던 Process 메뉴를 없앴다. 선택 모드의 상단 **Process ▾** 메뉴가 선택한 논문에 바로 실행한다(step select + "Run on selected" 두 번 누르던 것을 한 번으로 줄였다). 각 항목 옆 숫자는 선택한 논문 중 그 단계가 남은 수이고, 0이면 체크 표시와 함께 비활성이다. 한 편만 처리할 때도 Select → 체크 → Process를 거친다.

### D4-16. headless 에이전트 토큰 절감 — 사용자 요청
- 실측 근거: 최근 `claude -p` 세션 transcript를 분석했다. 세션마다 시작 context가 ~29k token이었다. 사용자 plugin의 skill 목록(~10k), SessionStart hook 주입(~3k), MCP, deferred tool 목록이 원인이다. 이 context는 매 turn 다시 읽힌다. claude-mem hook은 Read/Bash마다 돌았다. annotate 한 번은 Workflow와 subagent 6개를 띄웠다. subagent마다 ~50k context로 새로 시작해서 cache_read가 세션당 ~1.6M 늘었다.
- `agent.sh`(claude): `--setting-sources project,local --strict-mcp-config --tools "Bash,Read,Write,Edit,Glob,Grep"`. 시작 context는 28.6k → 7.6k(`/context`로 측정)다. `/SKILL` 확장은 그대로 동작한다(Skill tool 없이도 확인했다). 모델 기본값도 그대로다(opus). codex/gemini는 바꾸지 않았다.
- skill 수정: (1) annotate에서 번역을 할 때는 pages.md 대신 `pNNN.src.md`만 읽는다. 같은 본문을 두 번 읽던 것으로, 26쪽 논문에서 ~35k token이었다. (2) 리포트는 한 언어 판만 읽는다. evidence.md는 통째로 읽지 않고 grep한다. (3) 긴 파일은 한 turn에 범위를 모아서 읽는다. 순차 chunk 읽기는 turn마다 context 전체를 다시 읽는다. (4) 따옴표 매칭 규칙(글자·숫자만 비교)과 NOT_REPORTED WARN의 뜻을 skill에 적었다. 그 전에는 대부분의 세션이 `functions/verify*.py`를 읽어 규칙을 알아냈다. (5) Bash 변수는 호출 사이에 남지 않는다고 적었다(`$P`가 비어 verify를 4번 다시 돌린 세션이 있었다).
- 바꾸지 않은 것: figure crop 200 dpi(~1.5k px)는 API 이미지 한도 근처라, 더 줄이면 그래프 숫자 판독이 나빠진다. digest와 annotate를 한 세션으로 합치는 것은 context가 커져 오히려 turn당 비용이 오른다.

### D4-17. 분할 스냅, 한 단 번역, 피규어 클릭, 렌더링 최적화 — 사용자 요청
- divider는 1/3·1/2·2/3에서 20px 안이면 붙는다. 화살표 키로도 이 점들을 오간다(divider에 포커스, `role=separator`의 aria-valuenow). 원문이 2/3을 **넘으면**(2/3 자체는 아님) 번역 패널의 2단 페이지를 한 단으로 바꾼다. 블록은 본문 폭 전체, 읽는 순서, 글자 최소 14px. 1단 페이지는 그대로다. 기준을 글자 크기가 아니라 비율로 잡았다. 기존 최소 11px 때문에 보통 화면에서는 1/2에서도 글자가 이미 최소라, 글자 크기 기준이면 1/2에서도 바뀌기 때문이다.
- 피규어의 ⓘ 배지를 없애고, 피규어 영역 클릭으로 popover를 연다(고정). 다시 클릭하거나 페이지 다른 곳·바깥 클릭이나 Esc로 닫는다. hover로 여는 것은 없앴다. 클릭해야 뜨는데 hover로도 뜨면 읽는 중에 가린다. 키보드 접근은 사이드바 Figures 탭이 맡는다.
- 렌더링: Playwright로 실제 논문(RMA 16MB, 이미지 많음)을 1600×1000, DPR 2에서 측정했다(long task > 50ms, long-animation-frame). 원래는 divider 드래그 60프레임에 long task 61개, 합 7.2초였다. 지금은 0–1개다. 원인과 조치:
  - 드래그 프레임마다 PdfPane의 `clientHeight` 읽기가 강제 layout을 일으켰다. scale이 바뀌면 마운트된 페이지 text layer span 수천 개가 다시 배치됐다(CPU profile 1.4초). 그래서 드래그 중에는 text layer를 숨긴다.
  - 드래그 중 번역 카드 50장을 매 프레임 다시 배치했다. 지금은 드래그 동안 이전 배치를 CSS scale로만 맞추고, 놓을 때 한 번 배치한다. 배치가 바뀌면 sync가 켜져 있을 때 번역 쪽을 원문 위치에 다시 맞춘다.
  - pdf.js 렌더는 한 번에 한 job, 현재 페이지에 가까운 것부터다. text layer는 마운트당 한 번만 만든다(CSS 변수로 확대). canvas는 scale이 멈추고 150ms 뒤 새 canvas에 다시 그려 바꿔 끼운다(이전엔 프레임마다 지우고 다시 그려 흰 깜박임). 그린 페이지는 ±4까지 유지해 조금 되돌아갈 때 다시 그리지 않는다. pointermove는 rAF로 한 프레임에 한 번만 반영한다. `enableHWA: true`(GPU canvas)도 켰다.
  - divider의 잡는 영역(±4px) 오른쪽 절반이 번역 패널에 덮여 있었다. 그래서 z-index를 올렸다.
- 남은 것: 큰 이미지가 있는 페이지는 pdf.js가 그 이미지를 한 번에 그리느라 스크롤 중 한 프레임이 ~70ms 걸린다(headless 측정, GPU 없음). pdf.js 내부 동작이라 손대지 않았다. 실제 브라우저에서는 enableHWA로 줄어들 것으로 본다.

### D4-18. 줄 단위로 쪼개진 문단과 수식 조각 합치기 — 사용자 요청
- 증상: Benchmarking MPC/RL(2025)은 번역과 원문 연결이 줄 단위였고, 수식 자리에는 번역 창에 짧은 줄이 여러 개 쌓였다. OCR 문제가 아니었다. PyMuPDF가 줄 간격이 일정한(18pt) 문단을 1–3줄 블록으로 잘랐고(이 논문은 425블록), 화면에 띄운 수식은 `min( πθ`, `πold`, `, (3)` 같은 조각으로 잘랐다. 조각들은 문단으로 분류되어 따로 번역됐다.
- `layout.py`에 분류 뒤 두 단계를 추가했다.
  - (1) `merge_paragraphs`: 같은 열의 다음 문단 블록을 앞 블록에 붙인다. 조건은 줄 간격이 본문 줄 간격(문서 중앙값)의 1.25배 이내일 것, 들여쓰기가 없을 것, 앞 블록 마지막 줄이 오른쪽 끝까지 찰 것, 글자 크기가 같을 것이다. hanging indent(참고문헌)는 제외한다.
  - (2) `group_equations`: 60자 이하, 3줄 이하, 보통 단어 4개 미만인 조각을, 이미 묶인 수식 박스에서 가로 10pt, 세로 4pt 안에 있으면 그 묶음에 넣는다(조각끼리가 아니라 박스와 비교해야 적분 아래 `0` 같은 첨자가 따라온다). 묶음 안에 수식 글꼴이나 수식 기호가 있으면 수식 블록 하나가 된다(번역 창에는 crop 이미지 하나).
  - 문단을 먼저 합치는 이유: 2단 논문의 짧은 본문 줄이 `=`나 그리스 문자를 품고 있으면 수식으로 오인될 수 있어서다. 단어 수 조건도 같은 이유로 넣었다("where u ∈R2 is the Center of Pressure…" 같은 줄이 수식에 먹히던 것을 막는다).
- 23편으로 미리 돌려 봤다. figure 감지 결과는 전부 그대로였고, 문단 합치기 166건과 수식 묶음 183건을 확인했다. Benchmarking은 425 → 254블록이 됐다.
- 블록 ID는 첫 조각의 ID를 쓴다. 블록이 바뀐 페이지는 기존 번역 ID가 맞지 않으므로, `layout.sh --force` 뒤 `annotate.sh --only translation --resume`으로 그 페이지만 다시 번역한다. 옛 조각 번역을 코드로 이어 붙이지는 않았다. 사전 생성물은 skill 경로로만 쓰고, 줄마다 끊긴 번역을 이으면 한국어 어순이 어색해지기 때문이다. 하이라이트(인용 기반)와 figure note(figure ID 기반)는 영향이 없다.
- skill 번역 규칙에 "블록 하나의 번역은 줄바꿈 없는 한 문단"을 추가했다. 기존 번역에 블록 안 줄바꿈은 없었지만, 뷰어가 줄바꿈을 그대로 보여 주기 때문이다.

### D4-6. 남은 Phase 4 항목
- 피규어 bbox 수정(`PUT …/bbox`, figure_overrides.json)은 아직 구현하지 않았다. 요청 범위(보기)에 없었고, 실측 low_conf 0이라 급하지 않다.
