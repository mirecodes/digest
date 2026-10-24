// Overlays (Phase 4, docs/viewer-plan.md §12.3 items 4-5): highlight layer, figure note popover (click), sidebar tabs.
import { expect, test, type Page } from "@playwright/test";

async function openDemo(page: Page) {
  await page.goto("/");
  await page.locator("[data-paper-id]", { hasText: "Demo (2024)" }).getByRole("button", { name: "Open" }).click();
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible();
}

/** Client position of a PDF point on a page (scale from the rendered page width; the fixture is US letter). */
async function ptToClient(page: Page, n: number, x: number, y: number) {
  const box = (await page.locator(`.pdf-page[data-page="${n}"]`).boundingBox())!;
  const s = box.width / 612;
  return { x: box.x + x * s, y: box.y + y * s, s };
}

test("4: clicking Figure 1 opens its note; a second click, a click elsewhere, or Esc closes it", async ({ page }) => {
  await openDemo(page);
  await page.locator('.pdf-page[data-page="2"]').scrollIntoViewIfNeeded();
  await expect(page.locator(".fig-badge")).toHaveCount(0); // no ⓘ marks over the page
  const c = await ptToClient(page, 2, 165, 160); // inside fig-p2-0 [85, 100, 245, 220]
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(600);
  const pop = page.getByTestId("figure-popover");
  await expect(pop).toHaveCount(0); // hovering alone does not open it

  await page.mouse.click(c.x, c.y);
  await expect(pop).toHaveAttribute("data-pinned", "true");
  await expect(pop).toContainText("Figure 1");
  await expect(pop).toContainText("FooNet 구조 개요도");
  await expect(pop.locator(".cite").first()).toBeVisible(); // [E#, p.N] rendered as a citation chip
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await expect(pop).toBeVisible(); // stays while the pointer is away
  await pop.getByRole("button", { name: "EN" }).click();
  await expect(pop).toContainText("Overview of FooNet");

  await page.mouse.click(c.x, c.y); // the same figure again
  await expect(pop).toHaveCount(0);
  await page.mouse.click(c.x, c.y);
  await expect(pop).toBeVisible();
  const text = await ptToClient(page, 2, 450, 400); // right column text, outside every figure
  await page.mouse.click(text.x, text.y);
  await expect(pop).toHaveCount(0);
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("4b: a skipped table explains why there is no note (opened from the sidebar)", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: "Figures" }).click();
  await page.locator(".fig-list button", { hasText: "Table 1" }).click();
  await expect(page.getByTestId("figure-popover")).toContainText("skipped");
});

test("5: H toggles the highlight layer; the sidebar filters and navigates", async ({ page }) => {
  await openDemo(page);
  const hls = page.locator('.pdf-page[data-page="1"] .hl');
  await expect(hls.first()).toBeVisible();
  await expect(page.locator(".tr-block.has-hl").first()).toBeVisible(); // bar in the translation pane
  await page.locator("body").press("h");
  await expect(hls).toHaveCount(0);
  await expect(page.locator(".tr-block.has-hl")).toHaveCount(0);
  await page.locator("body").press("h");
  await expect(hls.first()).toBeVisible();

  // a paper with highlights opens on its reading map: one-line summaries first, the quoted sentence below
  await expect(page.getByRole("tab", { name: "Highlights" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-hl-item="H1"] .hl-note')).toContainText("풀려는 문제");
  await expect(page.locator(".hl-panel h3")).toHaveText(
    ["Problem", "Key assumption", "Prior work & its gaps", "Contribution", "Core method", "Main result", "Key insight"]);
  await page.locator(".cats label", { hasText: "Problem" }).locator("input").uncheck();
  await expect(page.locator('.hl[data-hl-id="H1"]')).toHaveCount(0);
  await expect(page.locator('.hl[data-hl-id="H3"]').first()).toBeVisible();

  await page.locator('[data-hl-item="H8"]').click(); // page 3
  await expect(page.locator('.pdf-page[data-page="3"] .flash')).toBeAttached();
  await expect(page.getByTestId("page-indicator")).toHaveText("3 / 3");
});

test("hovering a highlight shows its category and note", async ({ page }) => {
  await openDemo(page);
  const c = await ptToClient(page, 1, 180, 173); // inside H1's first rect [101.02, 167.32, 264.57, 179.69]
  await page.mouse.move(c.x, c.y);
  const tip = page.getByTestId("highlight-tip");
  await expect(tip).toBeVisible({ timeout: 1500 });
  await expect(tip).toContainText("Problem");
  await expect(tip).toContainText("이차 복잡도");
});

test("highlight rects sit on the text-layer words within 2 pt", async ({ page }) => {
  await openDemo(page);
  const span = page.locator('.pdf-page[data-page="1"] .textLayer span', { hasText: "Existing methods" });
  await expect(span).toBeAttached();
  // the word "Existing" inside its text-layer span, measured with a Range
  const word = await span.evaluate((el) => {
    const node = el.firstChild!;
    const i = node.textContent!.indexOf("Existing");
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + "Existing".length);
    const b = r.getBoundingClientRect();
    return { left: b.left, mid: (b.top + b.bottom) / 2 };
  });
  const hl = (await page.locator('.hl[data-hl-id="H1"]').first().boundingBox())!;
  const { s } = await ptToClient(page, 1, 0, 0);
  const dx = Math.abs(hl.x - word.left) / s;
  const dy = Math.abs(hl.y + hl.height / 2 - word.mid) / s;
  console.log(`[overlay] H1 start vs text layer: dx=${dx.toFixed(2)}pt dy=${dy.toFixed(2)}pt`);
  expect(dx).toBeLessThan(2);
  expect(dy).toBeLessThan(2);
});
