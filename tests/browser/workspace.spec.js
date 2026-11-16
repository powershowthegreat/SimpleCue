import { test, expect } from "@playwright/test";
import {
  formatTime,
  formatCropTime,
  parseCropTime,
} from "../../public/time.js";
async function signIn(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.locator(".cue-card").first()).toBeVisible();
}
test("compact layout, editable sliders, accent theme, centered dialogs, panel resizing, and drag reordering", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await expect(
    page.locator(".page-heading,.sequence-toolbar,.transport"),
  ).toHaveCount(0);
  await expect(page.locator("[data-master]")).toHaveCount(0);
  await expect(
    page.locator(".cue-card").first().locator(".track-transport"),
  ).toBeVisible();
  await expect(
    page.locator('.track-transport input[type="range"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Crop in for cue 1" }),
  ).toHaveValue("00:00:00");
  await expect(page.locator("[data-track-elapsed]").first()).toHaveText(
    "00:00.00",
  );
  const wave = page.locator("[data-seek-index]").first(),
    wr = await wave.boundingBox();
  await page.mouse.click(wr.x + wr.width * 0.3, wr.y + wr.height / 2);
  await expect
    .poll(() => page.locator("body > video").evaluate((el) => el.currentTime))
    .toBeGreaterThan(8);
  await page.locator('[data-action="reset-cue"]').first().click();
  await page
    .getByRole("textbox", { name: "Crop in for cue 1" })
    .fill("00:02:34");
  await page.getByRole("textbox", { name: "Crop in for cue 1" }).press("Tab");
  await page
    .getByRole("textbox", { name: "Crop out for cue 1" })
    .fill("00:20:56");
  await page.getByRole("textbox", { name: "Crop out for cue 1" }).press("Tab");
  await expect(page.locator(".in-marker").first()).toContainText("IN 00:02.34");
  await expect(page.locator(".out-marker").first()).toContainText(
    "OUT 00:20.56",
  );
  expect(
    await page
      .locator(".wave-trim-shade.before")
      .first()
      .evaluate((el) => parseFloat(el.style.width)),
  ).toBeCloseTo(7.8, 1);
  const trimmed = await page.locator("[data-seek-index]").first().boundingBox();
  await page.mouse.click(trimmed.x + 1, trimmed.y + trimmed.height / 2);
  await expect
    .poll(() => page.locator("body > video").evaluate((el) => el.currentTime))
    .toBeCloseTo(2.34, 2);

  await page.locator(".cue-card .cue-name").first().click();
  await page.keyboard.press("r");
  await expect(page.locator("[data-track-elapsed]").first()).toHaveText(
    "00:02.34",
  );
  await page.getByTitle("Click to enter gain").first().click();
  await page
    .getByRole("spinbutton", { name: "gain percentage for cue 1" })
    .fill("43");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("slider", { name: "Gain for cue 1" }),
  ).toHaveValue("43");
  await page.getByTitle("Click to enter speed").first().click();
  await page
    .getByRole("spinbutton", { name: "speed percentage for cue 1" })
    .fill("75");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("slider", { name: "Speed for cue 1" }),
  ).toHaveValue("75");
  const speed = page.getByRole("slider", { name: "Speed for cue 1" });
  await expect(speed).toHaveAttribute("max", "200");
  await expect(page.locator(".speed-reference").first()).toHaveText("100%");
  await page.getByTitle("Click to enter speed").first().click();
  const speedValue = page.getByRole("spinbutton", {
    name: "speed percentage for cue 1",
  });
  await expect(speedValue).toHaveAttribute("max", "200");
  await speedValue.fill("200");
  await speedValue.press("Enter");
  await expect(speed).toHaveValue("200");
  expect(
    await page.locator("body > video").evaluate((el) => el.playbackRate),
  ).toBe(2);
  await speed.evaluate((el) => {
    el.value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(speed).toHaveAttribute("aria-valuetext", "100%, normal speed");
  await expect(page.getByTitle("Click to enter speed").first()).toHaveText(
    "100%",
  );
  await expect(page.locator(".speed-reference").first()).toHaveText("100%");

  await page
    .getByRole("button", { name: "Theme and keyboard settings" })
    .click();
  const rect = await page.locator("dialog").boundingBox();
  expect(Math.abs(rect.x + rect.width / 2 - 720)).toBeLessThan(3);
  expect(Math.abs(rect.y + rect.height / 2 - 450)).toBeLessThan(3);
  await page.getByRole("button", { name: "Use #bccfe4 theme" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const waveColor = await page
    .locator("canvas")
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(waveColor).not.toBe("rgb(167, 181, 139)");
  const gainSlider = page.getByRole("slider", { name: "Gain for cue 1" }),
    gainRect = await gainSlider.boundingBox(),
    originalOrder = await page
      .locator(".cue-card")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.cueId));
  await page.mouse.move(
    gainRect.x + gainRect.width * 0.4,
    gainRect.y + gainRect.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    gainRect.x + gainRect.width * 0.95,
    gainRect.y + gainRect.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  expect(Number(await gainSlider.inputValue())).toBeGreaterThan(170);
  expect(
    await page
      .locator(".cue-card")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.cueId)),
  ).toEqual(originalOrder);
  const divider = page.getByRole("separator", { name: "Resize media sidebar" }),
    before = await page.locator(".sidebar").boundingBox(),
    d = await divider.boundingBox();
  await page.mouse.move(d.x + 3, d.y + 100);
  await page.mouse.down();
  await page.mouse.move(d.x + 75, d.y + 100);
  await page.mouse.up();
  expect((await page.locator(".sidebar").boundingBox()).width).toBeGreaterThan(
    before.width + 50,
  );
  const firstName = await page
    .locator(".cue-card .cue-name")
    .first()
    .textContent();
  await page
    .locator(".cue-card")
    .first()
    .dragTo(page.locator(".cue-card").nth(1), {
      sourcePosition: { x: 150, y: 18 },
      targetPosition: { x: 250, y: 170 },
    });
  await expect(page.locator(".cue-card .cue-name").nth(1)).toHaveText(
    firstName,
  );
  await expect(page.locator('.cue-card [data-action="cue-menu"]')).toHaveCount(
    0,
  );
  await expect(
    page
      .locator(".cue-card")
      .first()
      .getByRole("button", { name: /Duplicate/ }),
  ).toBeVisible();
  await expect(
    page
      .locator(".cue-card")
      .first()
      .getByRole("button", { name: /Delete/ }),
  ).toBeVisible();
  await page.locator('[data-tab="player"]').click();
  await expect(page.locator(".production-cue")).toHaveCount(6);
  const output = await page.locator(".output-panel").boundingBox();
  expect(output.width / 1440).toBeGreaterThan(0.14);
  expect(output.width / 1440).toBeLessThan(0.16);
  await expect
    .poll(async () => page.locator("#output-device-name").textContent())
    .not.toBe("");
  await expect(page.locator("#output-device-select")).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/player-dark.png",
    fullPage: true,
  });
});
test("FLAC upload uses chunked local requests and HTML gateway errors are actionable", async ({
  page,
}) => {
  await signIn(page);
  await page
    .locator("#upload-input")
    .setInputFiles("tests/fixtures/upload-test.flac");
  await expect(page.getByText("1 file added.", { exact: true })).toBeVisible();
  await page.locator('[data-tab="media"]').click();
  await page
    .getByRole("textbox", { name: "Search all files" })
    .fill("upload-test");
  await expect(page.locator(".media-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".media-table tbody")).toContainText("FLAC");
  await page.route("**/api/uploads", (route) =>
    route.fulfill({
      status: 413,
      contentType: "text/html",
      body: "<html><h1>Request Entity Too Large</h1></html>",
    }),
  );
  await page
    .locator("#upload-input")
    .setInputFiles("tests/fixtures/upload-test.flac");
  await expect(
    page.getByText(/hosting service rejected the upload size \(HTTP 413\)/),
  ).toBeVisible();
  await expect(page.getByText(/Unexpected token/)).toHaveCount(0);
});
test("end of cue waits unless the next cue is explicitly linked to it", async ({
  page,
}) => {
  await signIn(page);
  const ws = await (await page.request.get("/api/workspace")).json(),
    m = ws.media[0];
  const cues = [
    {
      id: "a",
      mediaId: m.id,
      start: 0,
      end: 0.8,
      speed: 1,
      volume: 70,
      follow: false,
    },
    {
      id: "b",
      mediaId: m.id,
      start: 1,
      end: 1.8,
      speed: 1,
      volume: 60,
      follow: false,
    },
    {
      id: "c",
      mediaId: m.id,
      start: 2,
      end: 4,
      speed: 1,
      volume: 50,
      follow: true,
      followFrom: "b",
    },
  ];
  const created = await (
    await page.request.post("/api/sequences", {
      data: { name: "Playback QA", cues },
    })
  ).json();
  await page.reload();
  await page
    .locator(".sequence-tile")
    .filter({ hasText: "Playback QA" })
    .click();
  await page.locator('[data-action="play-cue"]').nth(0).click();
  await expect(page.locator(".cue-card.active-cue")).toHaveAttribute(
    "data-index",
    "1",
  );
  await page.waitForTimeout(1100);
  expect(await page.locator("body > video").evaluate((el) => el.paused)).toBe(
    true,
  );
  await expect(page.locator(".cue-card.active-cue")).toHaveAttribute(
    "data-index",
    "1",
  );
  await page.locator('[data-action="play-cue"]').nth(1).click();
  await expect(page.locator(".cue-card.active-cue")).toHaveAttribute(
    "data-index",
    "2",
  );
  await expect
    .poll(() => page.locator("body > video").evaluate((el) => el.paused))
    .toBe(false);
  await page.locator('[data-action="stop-cue"]').nth(2).click();
  await page.request.delete("/api/sequences/" + created.id);
});
test("cached sequence restores after an offline reload and still plays", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Cache all", exact: true }).click();
  await expect(
    page.getByText("Cached on this device. Available offline.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".cue-card").first()).toBeVisible();
  await expect(page.locator("#connection-status")).toContainText("Offline");
  await expect(page.locator("#login-screen")).toHaveClass(/hidden/);
  await page.locator('[data-action="play-cue"]').first().click();
  await expect
    .poll(() => page.locator("body > video").evaluate((el) => el.currentTime))
    .toBeGreaterThan(0.1);
  await context.setOffline(false);
});
test("mobile panels fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator('[data-tab="player"]').click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
});

test("formatted crop inputs validate and waveform context menus set absolute In/Out points in both tabs", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  let card = page
    .locator(".cue-card")
    .filter({ has: page.locator(".cue-name", { hasText: "House open" }) });
  const cropIn = () => card.locator('[data-cue-setting="start"]'),
    cropOut = () => card.locator('[data-cue-setting="end"]');
  await cropIn().fill("00:02:34");
  await cropIn().press("Enter");
  await expect(cropIn()).toHaveValue("00:02:34");
  await cropIn().fill("00:03:45");
  await cropIn().press("Escape");
  await expect(cropIn()).toHaveValue("00:02:34");
  await cropOut().fill("00:24:00");
  await cropOut().press("Enter");
  await cropIn().fill("00:60:00");
  await cropIn().press("Enter");
  await expect(cropIn()).toHaveValue("00:02:34");
  await expect(page.getByText(/Use MM:SS:cc for crop times/)).toBeVisible();
  await cropIn().fill("00:25:00");
  await cropIn().press("Enter");
  await expect(cropIn()).toHaveValue("00:02:34");
  const active = await page.locator(".active-cue").getAttribute("data-cue-id");
  let rect = await card.locator(".wave-wrap").boundingBox();
  await page.mouse.click(rect.x + rect.width * 0.4, rect.y + 20, {
    button: "right",
  });
  await expect(
    page.getByRole("menu", { name: "Set crop point" }),
  ).toBeVisible();
  const expectedIn = parseCropTime(
    await page.locator(".wave-context-time").textContent(),
  );
  expect(expectedIn).toBeCloseTo(12, 1);
  await page.screenshot({ path: "test-results/crop-context-menu.png" });
  await page.getByRole("menuitem", { name: "Set crop In here" }).click();
  await expect(cropIn()).toHaveValue(formatCropTime(expectedIn));
  await expect(card.locator(".in-marker")).toContainText(
    `IN ${formatTime(expectedIn)}`,
  );
  await expect(page.locator(".active-cue")).toHaveAttribute(
    "data-cue-id",
    active,
  );
  rect = await card.locator(".wave-wrap").boundingBox();
  await page.mouse.click(rect.x + rect.width * 0.1, rect.y + 20, {
    button: "right",
  });
  await expect(
    page.getByRole("menuitem", { name: "Set crop Out here" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.locator('[data-tab="player"]').click();
  card = page
    .locator(".cue-card")
    .filter({ has: page.locator(".cue-name", { hasText: "House open" }) });
  rect = await card.locator(".wave-wrap").boundingBox();
  await page.mouse.click(rect.x + rect.width * 0.6, rect.y + 20, {
    button: "right",
  });
  const expectedOut = parseCropTime(
    await page.locator(".wave-context-time").textContent(),
  );
  expect(expectedOut).toBeCloseTo(18, 1);
  await page.getByRole("menuitem", { name: "Set crop Out here" }).click();
  await expect(card.locator(".out-marker")).toContainText(
    `OUT ${formatTime(expectedOut)}`,
  );
  await page.locator('[data-tab="editor"]').click();
  card = page
    .locator(".cue-card")
    .filter({ has: page.locator(".cue-name", { hasText: "House open" }) });
  await expect(cropOut()).toHaveValue(formatCropTime(expectedOut));
  await expect
    .poll(async () => {
      const ws = await (await page.request.get("/api/workspace")).json();
      const seq = ws.sequences.find((s) => s.id === "opening-night");
      return seq.cues.find((c) => c.mediaId === "house-open").end;
    })
    .toBe(expectedOut);
  await page.reload();
  await expect(cropIn()).toHaveValue(formatCropTime(expectedIn));
  await expect(cropOut()).toHaveValue(formatCropTime(expectedOut));
  expect(errors).toEqual([]);
});

test("cue configuration persists loops and next linkage, and direct header actions preserve media", async ({
  page,
}) => {
  await signIn(page);
  const ws = await (await page.request.get("/api/workspace")).json(),
    m = ws.media[0],
    mediaCount = ws.media.length;
  const created = await (
    await page.request.post("/api/sequences", {
      data: {
        name: "Loop configuration QA",
        cues: [
          {
            id: "loop-source",
            mediaId: m.id,
            start: 1,
            end: 1.5,
            volume: 100,
            speed: 1,
          },
          {
            id: "loop-next",
            mediaId: m.id,
            start: 2,
            end: 2.8,
            volume: 100,
            speed: 1,
          },
        ],
      },
    })
  ).json();
  await page.reload();
  await page
    .locator(".sequence-tile")
    .filter({ hasText: "Loop configuration QA" })
    .click();
  const source = () => page.locator(".cue-card").first();
  await expect(source()).not.toHaveAttribute("draggable", "true");
  await expect(source().locator(".cue-card-top")).toHaveAttribute(
    "draggable",
    "true",
  );
  await expect(page.locator('[data-cue-setting="follow"]')).toHaveCount(0);
  await source()
    .getByRole("button", { name: /Configure/ })
    .click();
  await page.getByRole("radio", { name: "On", exact: true }).check();
  await page.locator("#cue-loop-mode").selectOption("count");
  await page.getByRole("spinbutton", { name: "Number of plays" }).fill("3");
  await page.screenshot({ path: "test-results/cue-configuration.png" });
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(source().locator(".cue-modifiers")).toHaveText(
    "loop 3x | autoplay next",
  );
  const stored = await (await page.request.get("/api/workspace")).json(),
    saved = stored.sequences.find((s) => s.id === created.id);
  expect(saved.cues[0].loop).toBe(3);
  expect(saved.cues[1].followFrom).toBe("loop-source");
  await page.evaluate(() => {
    window.loopPasses = [];
    new MutationObserver(() => {
      const text = document.querySelector(
          '[data-track-status="0"]',
        )?.textContent,
        match = text?.match(/^Play (\d+)\/3$/);
      if (match && !window.loopPasses.includes(Number(match[1])))
        window.loopPasses.push(Number(match[1]));
    }).observe(document.querySelector("#main-content"), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await source().locator('[data-action="play-cue"]').click();
  await expect(page.locator(".active-cue")).toHaveAttribute("data-index", "1");
  await expect
    .poll(() => page.locator("body > video").evaluate((el) => el.paused))
    .toBe(false);
  expect(await page.evaluate(() => window.loopPasses)).toEqual([1, 2, 3]);
  await page.locator('[data-action="stop-cue"]').nth(1).click();
  await source()
    .getByRole("button", { name: /Configure/ })
    .click();
  await page.locator("#cue-loop-mode").selectOption("forever");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.reload();
  await expect(source().locator(".cue-modifiers")).toHaveText(
    "loop forever | autoplay next",
  );
  await source().locator('[data-action="play-cue"]').click();
  await expect(source().locator("[data-track-status]")).toHaveText(
    /Play [3-9]\/∞/,
  );
  await expect(page.locator(".active-cue")).toHaveAttribute("data-index", "0");
  await source().locator('[data-action="stop-cue"]').click();
  await expect(source().locator("[data-track-elapsed]")).toHaveText("00:01.00");
  await source()
    .getByRole("button", { name: /Configure/ })
    .click();
  await page.getByRole("radio", { name: "Off", exact: true }).check();
  await page.locator("#cue-loop-mode").selectOption("off");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(source().locator(".cue-modifiers")).toHaveText("");
  await source().locator('[data-action="play-cue"]').click();
  await expect(page.locator(".active-cue")).toHaveAttribute("data-index", "1");
  expect(await page.locator("body > video").evaluate((el) => el.paused)).toBe(
    true,
  );
  await source()
    .getByRole("button", { name: /Duplicate/ })
    .click();
  await expect(page.locator(".cue-card")).toHaveCount(3);
  await expect(page.locator(".active-cue")).toHaveAttribute(
    "data-cue-id",
    "loop-next",
  );
  await page
    .locator(".cue-card")
    .nth(1)
    .getByRole("button", { name: /Delete/ })
    .click();
  await expect(page.locator(".cue-card")).toHaveCount(2);
  expect(
    (await (await page.request.get("/api/workspace")).json()).media.length,
  ).toBe(mediaCount);
  await page.request.delete("/api/sequences/" + created.id);
});

test("cue and master gain amplify the actual output above 100 percent", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const ws = await (await page.request.get("/api/workspace")).json(),
    m = ws.media[0];
  const created = await (
    await page.request.post("/api/sequences", {
      data: {
        name: "Gain QA",
        cues: [
          {
            id: "gain-cue",
            mediaId: m.id,
            start: 3,
            end: 20,
            volume: 100,
            speed: 1,
          },
        ],
      },
    })
  ).json();
  await page.reload();
  await page.locator(".sequence-tile").filter({ hasText: "Gain QA" }).click();
  await page.locator('[data-action="play-cue"]').first().click();
  await expect
    .poll(() =>
      page
        .locator("audio[data-simplecue-output]")
        .evaluate((el) => Boolean(el.srcObject) && !el.paused),
    )
    .toBe(true);
  const rms = () =>
    page.locator("audio[data-simplecue-output]").evaluate(async (el) => {
      const ctx = new AudioContext(),
        source = ctx.createMediaStreamSource(el.srcObject),
        analyser = ctx.createAnalyser(),
        silent = ctx.createGain();
      analyser.fftSize = 8192;
      silent.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silent);
      silent.connect(ctx.destination);
      await ctx.resume();
      await new Promise((r) => setTimeout(r, 250));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, n) => sum + n * n, 0) / samples.length,
      );
      await ctx.close();
      return rms;
    });
  const before = await rms();
  expect(before).toBeGreaterThan(0.005);
  await page.getByRole("slider", { name: "Gain for cue 1" }).evaluate((el) => {
    el.value = "200";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.getByTitle("Click to enter gain")).toHaveText("200%");
  const boosted = await rms();
  expect(boosted / before).toBeGreaterThan(1.65);
  expect(boosted / before).toBeLessThan(2.35);
  await page.getByRole("slider", { name: "Gain for cue 1" }).evaluate((el) => {
    el.value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-tab="player"]').click();
  const master = page.getByRole("slider", { name: "Master output gain" });
  await expect(master).toHaveAttribute("max", "200");
  await master.evaluate((el) => {
    el.value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const masterBefore = await rms();
  await master.evaluate((el) => {
    el.value = "200";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const masterAfter = await rms();
  expect(masterAfter / masterBefore).toBeGreaterThan(1.65);
  expect(masterAfter / masterBefore).toBeLessThan(2.35);
  expect(errors).toEqual([]);
  await page.locator('[data-action="stop-cue"]').first().click();
  await page.request.delete("/api/sequences/" + created.id);
});

test("Ctrl/Cmd S commits focused edits, saves to server and refreshes existing caches", async ({
  page,
}) => {
  await signIn(page);
  const ws = await (await page.request.get("/api/workspace")).json(),
    m = ws.media[0];
  const created = await (
    await page.request.post("/api/sequences", {
      data: {
        name: "Shortcut QA",
        cues: [
          {
            id: "shortcut-cue",
            mediaId: m.id,
            start: 1,
            end: 3,
            volume: 100,
            speed: 1,
          },
        ],
      },
    })
  ).json();
  await page.reload();
  await page
    .locator(".sequence-tile")
    .filter({ hasText: "Shortcut QA" })
    .click();
  await page.getByRole("button", { name: "Cache all", exact: true }).click();
  await expect(
    page.getByText("Cached on this device. Available offline.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")
        window.saveDefaultPrevented = event.defaultPrevented;
    }),
  );
  const crop = page.getByRole("textbox", { name: "Crop in for cue 1" });
  await crop.fill("00:01:25");
  await page.keyboard.press("Control+s");
  await expect(
    page.getByText("Saved to server and refreshed local cache.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.saveDefaultPrevented)).toBe(true);
  const cached = () =>
    page.evaluate(async (id) => {
      const { cacheGet } = await import("/cache.js");
      const blob = await cacheGet("assets", `sequence:${id}`);
      return blob ? blob.text() : null;
    }, created.id);
  await expect.poll(cached).toContain('"start":1.25');
  expect(
    (await (await page.request.get("/api/workspace")).json()).sequences.find(
      (s) => s.id === created.id,
    ).cues[0].start,
  ).toBe(1.25);
  await page.getByTitle("Click to enter gain").click();
  await page
    .getByRole("spinbutton", { name: "gain percentage for cue 1" })
    .fill("175");
  await page.keyboard.press("Meta+s");
  await expect.poll(cached).toContain('"volume":175');
  expect(await page.evaluate(() => window.saveDefaultPrevented)).toBe(true);
  await page.getByRole("button", { name: /Configure/ }).click();
  await page.locator("#cue-loop-mode").selectOption("count");
  await page.getByRole("spinbutton", { name: "Number of plays" }).fill("3");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#modal")).not.toBeVisible();
  await expect.poll(cached).toContain('"loop":3');
  await crop.fill("00:60:00");
  await page.keyboard.press("Control+s");
  await expect(page.getByText(/Use MM:SS:cc for crop times/)).toBeVisible();
  expect(await page.evaluate(() => window.saveDefaultPrevented)).toBe(true);
  await crop.press("Escape");
  await expect(crop).toHaveValue("00:01:25");
  const tile = page
    .locator(".sequence-tile")
    .filter({ hasText: "Shortcut QA" });
  await tile
    .getByRole("button", { name: "Uncache sequence", exact: true })
    .click();
  await expect.poll(cached).toBe(null);
  await page.keyboard.press("Control+s");
  await expect(
    page.getByText("Saved to server.", { exact: true }),
  ).toBeVisible();
  expect(await cached()).toBe(null);
  await page.request.delete("/api/sequences/" + created.id);
});
