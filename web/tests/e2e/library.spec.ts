// Library processing: the server runs a stub instead of scripts/digest.sh / annotate.sh (PAPER_VIEWER_JOB_CMD in
// playwright.config.ts), so no Claude call happens. src/ holds a new paper and a copy of the demo PDF; the long
// paper's translation job was cut off by a viewer stop (functions/fixtures.py).
import { expect, test, type Page } from "@playwright/test";

/** Select mode, tick the papers, then pick the step in the Process menu above the list. */
async function runOn(page: Page, names: string[], step: string) {
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const name of names) await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  await page.getByRole("button", { name: "Process" }).click();
  await page.getByRole("menuitem", { name: step }).click();
}

// runs first: any later job on the long paper replaces the interrupted one
test("a job cut off by a viewer stop shows as stopped and resumes with the same effort", async ({ page }) => {
  await page.goto("/");
  const row = page.locator("[data-paper-id]", { hasText: "Long Paper (2024)" });
  const log = row.getByTestId("job-log");
  await expect(log.locator("[data-status]")).toHaveAttribute("data-status", "interrupted");
  await expect(log.locator("[data-status]")).toContainText("Translation · Stopped while running");
  await expect(log.locator("pre")).toContainText("p001 translated");
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(log.locator("pre")).toContainText("PAPER_AGENT_EFFORT=low");
  await expect(log.locator("pre")).toContainText("--only translation --resume");
  await expect(log).toHaveCount(0, { timeout: 15_000 }); // a done job hides its log
  await expect(row.getByRole("button", { name: "Resume" })).toHaveCount(0);
});

test("the select circles and the Process menu show only in select mode", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-paper-id]").first()).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Process" })).toHaveCount(0);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select all" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Process" })).toBeDisabled(); // nothing selected yet
  await page.getByRole("checkbox", { name: "Select fresh" }).check();
  await page.getByRole("button", { name: "Done" }).click(); // leaving drops the selection
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator(".tree-row.selected")).toHaveCount(0);
});

test("the Process menu runs one step and streams its log", async ({ page }) => {
  await page.goto("/");
  await runOn(page, ["Long Paper (2024)"], "Annotation");
  const row = page.locator("[data-paper-id]", { hasText: "Long Paper (2024)" });
  const log = row.getByTestId("job-log");
  await expect(log.locator("pre")).toContainText("stub annotate.sh -n");
  await expect(log.locator("pre")).toContainText("--only highlights,figures");
  await expect(log).toHaveCount(0, { timeout: 15_000 }); // a done job hides its log
});

test("a new src/ paper is listed once and any step runs on its own, preparing the paper first", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-paper-id]")).toHaveCount(3); // demo, long paper, fresh.pdf; dup.pdf is the demo
  const row = page.locator("[data-paper-id]", { hasText: "fresh" });
  await expect(row).toContainText("New");
  await expect(row.getByRole("button", { name: "Open" })).toBeDisabled();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await row.getByRole("checkbox", { name: "Select fresh" }).check();
  await page.getByRole("button", { name: "Process" }).click();
  const items = page.getByRole("menuitem");
  await expect(items).toHaveText([/^Run all/, /^Summary/, /^Translation/, /^Annotation/]);
  for (const item of await items.all()) await expect(item).toBeEnabled();
  await page.getByRole("menuitem", { name: "Annotation" }).click();
  const log = row.getByTestId("job-log");
  await expect(log.locator("pre")).toContainText("stub internal/prepare.sh --ensure -n");
  await expect(log.locator("pre")).toContainText("--only highlights,figures");
  await expect(log.locator("pre")).not.toContainText("digest.sh");
  await expect(log).toHaveCount(0, { timeout: 15_000 }); // a done job hides its log
});

test("the chosen model and effort reach the job", async ({ page }) => {
  await page.goto("/");
  const model = page.getByLabel("Model");
  await expect(model).toHaveAttribute("list", "agent-models");
  await expect(page.locator("#agent-models option[value='claude-sonnet-5-5']")).toHaveCount(1);
  await model.fill("claude-sonnet-5-5");
  await page.getByLabel("Effort").selectOption("high");
  await runOn(page, ["Long Paper (2024)"], "Translation");
  const log = page.locator("[data-paper-id]", { hasText: "Long Paper (2024)" }).getByTestId("job-log");
  await expect(log.locator("pre")).toContainText("PAPER_AGENT_EFFORT=high  PAPER_AGENT_MODEL=claude-sonnet-5-5");
  await expect(log).toHaveCount(0, { timeout: 15_000 }); // a done job hides its log
  await page.reload();
  await expect(page.getByLabel("Model")).toHaveValue("claude-sonnet-5-5"); // remembered in this browser
});

test("a src/ folder collapses, and its circle selects every paper in it with a tinted row", async ({ page }) => {
  await page.goto("/");
  const folder = page.locator('[data-folder="inbox"]');
  const row = folder.locator("[data-paper-id]", { hasText: "fresh" });
  const toggle = folder.getByRole("button", { name: /inbox/ });
  await expect(row).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(folder.getByRole("button", { name: /inbox/ })).toHaveAttribute("aria-expanded", "false"); // remembered
  await toggle.click();
  await expect(row).toBeVisible();

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await folder.getByRole("checkbox", { name: "Select inbox" }).check();
  await expect(row.getByRole("checkbox", { name: "Select fresh" })).toBeChecked();
  await expect(row.locator(".tree-row")).toHaveClass(/selected/);
  await expect(page.locator(".batch-bar")).toContainText("1 selected");
  await page.getByRole("button", { name: "Process" }).click();
  await page.getByRole("menuitem", { name: "Translation" }).click();
  await expect(page.getByRole("status")).toContainText("1 queued");
  const log = row.getByTestId("job-log");
  await expect(log.locator("pre")).toContainText("--only translation");
  await expect(log).toHaveCount(0, { timeout: 15_000 }); // a done job hides its log
});

test("select all queues the papers with work left and skips the finished ones", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all" }).check();
  await expect(page.locator(".batch-bar")).toContainText("3 selected");
  await expect(page.locator(".tree-row.paper-row.selected")).toHaveCount(3);
  await page.getByRole("button", { name: "Process" }).click();
  // the demo paper already has its highlights and every figure note
  await expect(page.getByRole("menuitem", { name: "Annotation" }).locator(".todo")).toHaveText("2");
  await page.getByRole("menuitem", { name: "Annotation" }).click();
  await expect(page.getByRole("status")).toContainText("2 queued · 1 skipped");
  const logs = ["Long Paper (2024)", "fresh"].map((name) =>
    page.locator("[data-paper-id]", { hasText: name }).getByTestId("job-log"));
  // both logs first: a job that is done hides its log, and the two may run at once
  for (const log of logs) await expect(log.locator("pre")).toContainText("--only highlights,figures");
  for (const log of logs) await expect(log).toHaveCount(0, { timeout: 15_000 });
});

test("annotated paper shows the bundled translation and blue status marks", async ({ page }) => {
  await page.goto("/");
  const row = page.locator("[data-paper-id]", { hasText: "Demo (2024)" });
  for (const name of ["In the output folder", "Translation 16/16", "Highlights", "Figure notes 3/3"])
    await expect(row.getByRole("img", { name: new RegExp(`^${name}.*: done$`) })).toHaveClass(/\bon\b/);
  const fresh = page.locator("[data-paper-id]", { hasText: "fresh" });
  await expect(fresh.getByRole("img", { name: "In the output folder: not yet" })).not.toHaveClass(/\bon\b/);
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.locator('.tr-block[data-block-id="p1-b5"]')).toContainText("FooNet을 제안한다");
  await expect(page.locator('.tr-block[data-block-id="p1-b5"]')).not.toHaveClass(/untranslated/);
});
