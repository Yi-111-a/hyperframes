/** Drives one edit accuracy case in the built Studio and measures it. All distances are composition px. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSITION, PLAYHEAD } from "./grid.mjs";
import {
  angleOf,
  centre,
  compositionMapper,
  dist,
  localToQuad,
  mid,
  normalizeAngle,
  parseInset,
  percentile,
  quadDistance,
  quadToLocal,
  toPoints,
  visibleQuad,
} from "./geometry.mjs";

const VIEWPORT = { width: 1600, height: 900 };
const STEPS = 20;
const MOVE_BY = [90, 60];
const RESIZE_BY = 60;
const ROTATE_BY = (25 * Math.PI) / 180;
const CROP_BY = 40;
const NUDGES = 5;
const ZOOM_SENSITIVITY = 0.007; // previewZoom.ts: one wheel unit scales zoom by exp(0.007)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const up = (port) =>
  fetch(`http://127.0.0.1:${port}/api/projects`).then(
    (r) => r.ok,
    () => false,
  );
const liveServers = new Set();
/** Signal-safe cleanup: servers run in their own process group so the CLI's children go with them. */
export function killServers() {
  for (const child of liveServers) process.kill(-child.pid, "SIGKILL");
}

// fallow-ignore-next-line complexity
export async function startServer(cli, dir, port, log) {
  // The CLI quietly takes the next free port when asked for a busy one, so a busy port would test a stale project.
  if (await up(port)) throw new Error(`port ${port} is already serving`);
  const child = spawn(
    "node",
    [cli, "preview", dir, "--port", String(port), "--no-open", "--foreground", "--force-new"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  liveServers.add(child);
  child.once("exit", () => liveServers.delete(child));
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(200)) {
    if (child.exitCode !== null)
      throw new Error(`studio exited ${child.exitCode}: ${log.join("").slice(-500)}`);
    if (await up(port)) return child;
  }
  await stopServer(child);
  throw new Error("studio did not start in 60s");
}

export async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  process.kill(-child.pid, "SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(5000)])) return;
  process.kill(-child.pid, "SIGKILL");
  await exited;
}

/** Runs in the top frame before Studio: the WebMCP host plus a frame-interval and long-task recorder. */
function instrumentPage() {
  if (window.top !== window) return;
  const tools = new Map();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool: async (tool) => void tools.set(tool.name, tool) },
  });
  const rec = { on: false, frames: [], long: [] };
  const call = (name, input) =>
    tools.get(name).execute(input, { signal: new AbortController().signal });
  window.__editBench = { has: (name) => tools.has(name), call, rec };
  // The callback's own clock: Chrome stamps a late frame with the vsync it missed, which hides a stall.
  const loop = () => {
    if (rec.on) rec.frames.push(performance.now());
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  new PerformanceObserver((list) => {
    if (rec.on) for (const e of list.getEntries()) rec.long.push(e.duration);
  }).observe({ type: "longtask" });
}

const nextFrame = (page, n = 1) =>
  page.evaluate(
    (count) =>
      new Promise((r) => {
        const tick = (left) => (left ? requestAnimationFrame(() => tick(left - 1)) : r());
        tick(count);
      }),
    n,
  );

function readFiles(dir, files) {
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}
const sameFiles = (a, b) => Object.keys(a).every((f) => a[f] === b[f]);

/** Waits until the files differ from `from` (or equal `want`) and then hold still for 300 ms. */
// fallow-ignore-next-line complexity
async function waitForFiles(ctx, { from, want, timeout = 5000 }) {
  const deadline = Date.now() + timeout;
  let last = readFiles(ctx.dir, ctx.files);
  let stableSince = Date.now();
  for (; Date.now() < deadline; await sleep(50)) {
    const now = readFiles(ctx.dir, ctx.files);
    if (!sameFiles(now, last)) [last, stableSince] = [now, Date.now()];
    const reached = want ? sameFiles(now, want) : !sameFiles(now, from);
    if (reached && Date.now() - stableSince >= 300) return { reached: true, files: now };
  }
  return { reached: false, files: last };
}

// fallow-ignore-next-line complexity
async function findTarget(page) {
  let best = null;
  for (const frame of page.frames()) {
    if (!frame.url().includes("/preview")) continue;
    const target = await frame.$("#target").catch(() => null);
    const host = target && (await frame.frameElement());
    const box = host && (await host.boundingBox());
    if (box && (!best || box.width * box.height > best.area))
      best = { area: box.width * box.height, frame, target };
  }
  return best;
}

// The handle's own session: remote object ids do not resolve in any other CDP session.
async function contentQuad(handle) {
  const { quads } = await handle.client.send("DOM.getContentQuads", {
    objectId: handle.remoteObject().objectId,
  });
  if (!quads.length) throw new Error("element has no rendered box");
  return toPoints(quads[0]);
}

async function findHandles(ctx) {
  const found = await findTarget(ctx.page);
  if (!found) throw new Error("target not found in preview");
  ctx.handles = { target: found.target, root: await found.frame.$('[data-composition-id="main"]') };
}

async function readQuads({ handles }) {
  return Promise.all([
    contentQuad(handles.root),
    contentQuad(handles.target),
    handles.target.evaluate((e) => ({
      width: e.offsetWidth,
      height: e.offsetHeight,
      clip: getComputedStyle(e).clipPath,
    })),
  ]);
}

/** The target's rendered quad, visible (cropped) quad and the screen/composition mapping, from CDP quads. */
async function measure(ctx) {
  if (!ctx.handles) await findHandles(ctx);
  // Studio can swap the preview into a fresh iframe; a cached handle then reads a hidden copy, so find it again.
  const [rootQuad, targetQuad, box] = await readQuads(ctx).catch(async () => {
    await findHandles(ctx);
    return readQuads(ctx);
  });
  const map = compositionMapper(rootQuad, COMPOSITION);
  const quad = targetQuad.map(map.toComp);
  const size = { width: box.width, height: box.height };
  return { map, quad, size, visible: visibleQuad(quad, size, parseInset(box.clip)) };
}

/** Measures until two reads a frame apart agree, so a settling soft reload is not caught mid-way. */
async function settled(ctx, tries = 20) {
  let prev = await measure(ctx);
  for (let i = 0; i < tries; i++) {
    await nextFrame(ctx.page, 2);
    const now = await measure(ctx);
    if (quadDistance(now.visible, prev.visible) < 0.01) return now;
    prev = now;
  }
  return prev;
}

/** Ready once Studio's own seek tool reports the composition and the playhead landed. */
// fallow-ignore-next-line complexity
async function openStudio(ctx) {
  ctx.handles = null;
  await ctx.page.waitForFunction(() => window.__editBench?.has("studio_seek"), { timeout: 90_000 });
  let seek = null;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
    seek = await ctx.page
      .evaluate((time) => window.__editBench.call("studio_seek", { time }), PLAYHEAD)
      .catch(String);
    if (seek?.ok && seek.duration > 0 && seek.playhead === PLAYHEAD && (await findTarget(ctx.page)))
      break;
    seek = null;
  }
  if (!seek) throw new Error("studio never reported a seekable composition");
  await sleep(1000);
  return settled(ctx);
}

/** Puppeteer presses one key at a time: hold the modifiers around the last key. */
async function chord(page, keys) {
  const [key, ...mods] = keys.split("+").reverse();
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of mods) await page.keyboard.up(m);
}

async function blurPreview(page) {
  await page.evaluate(() => {
    if (document.activeElement?.tagName === "IFRAME") document.activeElement.blur();
  });
}

/** Snapping deliberately pulls the box off the pointer, so the bench turns it off with Studio's own toggle. */
async function disableSnap(page) {
  const title = await page.$eval('[aria-label="Toggle snap"]', (b) => b.title);
  if (/enabled/i.test(title)) await page.click('[aria-label="Toggle snap"]');
  const after = await page.$eval('[aria-label="Toggle snap"]', (b) => b.title);
  if (!/disabled/i.test(after)) throw new Error(`snap toggle did not turn off: ${after}`);
}

const zoomOf = (page) =>
  page.$eval('[data-testid="preview-zoom-stage"]', (e) => {
    const m = /scale\(([\d.]+)\)/.exec(e.style.transform);
    return m ? Number(m[1]) * 100 : 100;
  });

/** Ctrl+wheel over the target, as a person zooms; wheel units are solved exactly from the zoom law. */
async function setZoom(ctx, percent, anchor) {
  if (percent === 100) return 100;
  await ctx.page.mouse.move(anchor[0], anchor[1]);
  await ctx.page.keyboard.down("Control");
  let units = Math.log(percent / (await zoomOf(ctx.page))) / ZOOM_SENSITIVITY;
  while (Math.abs(units) > 1e-9) {
    const step = Math.max(-10, Math.min(10, units));
    await ctx.page.mouse.wheel({ deltaY: -step });
    units -= step;
  }
  await ctx.page.keyboard.up("Control");
  await sleep(400);
  const achieved = await zoomOf(ctx.page);
  if (Math.abs(achieved - percent) > 0.5)
    throw new Error(`zoom ${percent}% landed at ${achieved}%`);
  return achieved;
}

const overlayRect = (page, selector) =>
  page.$$eval(selector, (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
        label: e.getAttribute("aria-label"),
      };
    }),
  );

async function selectTarget(ctx, m) {
  const c = m.map.toScreen(centre(m.visible));
  const want = m.visible.map(m.map.toScreen);
  const isSelected = async () => {
    const [box] = await overlayRect(ctx.page, "[data-dom-edit-selection-box]");
    if (!box) return false;
    const xs = want.map((p) => p[0]);
    const ys = want.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return Math.abs(box.w - w) < 4 && Math.abs(box.h - h) < 4 && dist([box.x, box.y], c) < 4;
  };
  const waitSelected = async () => {
    for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(100))
      if (await isSelected()) return true;
    return false;
  };
  await ctx.page.mouse.click(c[0], c[1]);
  if (await waitSelected()) return;
  // A nested composition's child takes a second click to enter the composition.
  await ctx.page.mouse.click(c[0], c[1], { count: 2 });
  if (!(await waitSelected())) {
    const boxes = await overlayRect(ctx.page, "[data-dom-edit-selection-box]");
    throw new Error(
      `could not select #target at ${c.map(Math.round)}; selection ${JSON.stringify(boxes)}`,
    );
  }
}

// fallow-ignore-next-line complexity
async function handlePoint(ctx, m, gesture) {
  if (gesture === "move" || gesture === "nudge") return m.map.toScreen(centre(m.visible));
  if (gesture === "rotate") {
    const [h] = await overlayRect(ctx.page, '[aria-label="Rotate selection"]');
    if (!h) throw new Error("no rotate handle");
    return [h.x, h.y];
  }
  if (gesture === "crop") {
    const [h] = await overlayRect(ctx.page, '[aria-label="Crop right"]');
    if (!h) throw new Error("no crop right handle");
    return [h.x, h.y];
  }
  const corner = m.map.toScreen(m.visible[2]);
  const dots = await overlayRect(ctx.page, "div.pointer-events-auto.absolute.h-4.w-4");
  if (!dots.length) throw new Error("no resize handles");
  const dot = dots.reduce((a, b) => (dist([a.x, a.y], corner) <= dist([b.x, b.y], corner) ? a : b));
  return [dot.x, dot.y];
}

async function cropOutline(ctx, map) {
  const h = await ctx.page.$("[data-dom-edit-crop-frame] > div.border-dashed");
  if (!h) throw new Error("no crop outline");
  return (await contentQuad(h)).map(map.toComp);
}

/** Screen path (one point per frame) and the per-frame tracking error for each pointer gesture. */
function plan(gesture, pre, pressComp) {
  const at = (p) => pre.map.toScreen(p);
  const steps = Array.from({ length: STEPS }, (_, i) => (i + 1) / STEPS);
  const follow = (point) => ({
    point,
    error: (s, s0) =>
      dist([s.p[0] - s0.p[0], s.p[1] - s0.p[1]], [s.c[0] - s0.c[0], s.c[1] - s0.c[1]]),
  });
  if (gesture === "move") {
    const local = quadToLocal(pre.quad, pre.size, pressComp);
    return {
      path: steps.map((k) => at([pressComp[0] + MOVE_BY[0] * k, pressComp[1] + MOVE_BY[1] * k])),
      ...follow((m) => localToQuad(m.quad, m.size, local)),
    };
  }
  if (gesture === "resize") {
    const c = centre(pre.visible);
    const d = dist(pre.visible[2], c);
    const u = [(pre.visible[2][0] - c[0]) / d, (pre.visible[2][1] - c[1]) / d];
    return {
      path: steps.map((k) =>
        at([pressComp[0] + u[0] * RESIZE_BY * k, pressComp[1] + u[1] * RESIZE_BY * k]),
      ),
      ...follow((m) => m.visible[2]),
    };
  }
  if (gesture === "crop") {
    const n = [pre.quad[0][0] - pre.quad[1][0], pre.quad[0][1] - pre.quad[1][1]];
    const len = Math.hypot(...n);
    return {
      path: steps.map((k) =>
        at([pressComp[0] + (n[0] / len) * CROP_BY * k, pressComp[1] + (n[1] / len) * CROP_BY * k]),
      ),
      ...follow((m) => mid(m.outline[1], m.outline[2])),
    };
  }
  const c = centre(pre.visible);
  const r = dist(pressComp, c);
  const a0 = Math.atan2(pressComp[1] - c[1], pressComp[0] - c[0]);
  const angle = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  return {
    path: steps.map((k) =>
      at([c[0] + r * Math.cos(a0 + ROTATE_BY * k), c[1] + r * Math.sin(a0 + ROTATE_BY * k)]),
    ),
    point: (m) => [angleOf(m.quad), 0],
    error: (s, s0) => Math.abs(normalizeAngle(s.p[0] - s0.p[0] - (angle(s.c) - angle(s0.c)))) * r,
  };
}

async function sample(ctx, gesture, point, pointerScreen) {
  const m = await measure(ctx);
  if (gesture === "crop") m.outline = await cropOutline(ctx, m.map);
  return { m, p: point(m), c: m.map.toComp(pointerScreen) };
}

async function recording(page, on) {
  return page.evaluate((flag) => {
    const rec = window.__editBench.rec;
    if (flag) [rec.frames, rec.long, rec.on] = [[], [], true];
    else rec.on = false;
    return { frames: rec.frames, long: rec.long };
  }, on);
}

function smoothness({ frames, long }) {
  const intervals = frames.slice(1).map((t, i) => t - frames[i]);
  return {
    p95: percentile(intervals, 95),
    over: intervals.filter((d) => d > 16.7).length,
    frames: intervals.length,
    longTasks: long.length,
  };
}

async function pointerGesture(ctx, gesture, pre) {
  const press = await handlePoint(ctx, pre, gesture);
  const pressComp = pre.map.toComp(press);
  const g = plan(gesture, pre, pressComp);
  const hit = await ctx.page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x, y);
    return e
      ? `${e.tagName.toLowerCase()}${e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")}]` : ""}`
      : null;
  }, press);
  await ctx.page.mouse.move(press[0], press[1]);
  await ctx.page.mouse.down();
  await nextFrame(ctx.page);
  const s0 = await sample(ctx, gesture, g.point, press);
  await recording(ctx.page, true);
  const errors = [];
  let last = s0;
  for (const p of g.path) {
    await ctx.page.mouse.move(p[0], p[1]);
    await nextFrame(ctx.page);
    last = await sample(ctx, gesture, g.point, p);
    errors.push(g.error(last, s0));
  }
  const rec = await recording(ctx.page, false);
  const smooth = smoothness(rec);
  await ctx.page.mouse.up();
  const lastQuad = gesture === "crop" ? last.m.outline : last.m.visible;
  return {
    errors,
    lastQuad,
    smooth,
    diag: {
      hit,
      grabOffset: gesture === "rotate" ? 0 : dist(s0.p, s0.c),
      errors: errors.map((e) => Math.round(e * 1000) / 1000),
    },
  };
}

async function nudgeGesture(ctx, pre) {
  await recording(ctx.page, true);
  for (let i = 0; i < NUDGES; i++) {
    await ctx.page.keyboard.press("ArrowRight");
    await nextFrame(ctx.page);
  }
  await nextFrame(ctx.page, 2);
  const smooth = smoothness(await recording(ctx.page, false));
  const m = await measure(ctx);
  const [a, b] = [centre(pre.visible), centre(m.visible)];
  return {
    errors: [dist([b[0] - a[0], b[1] - a[1]], [NUDGES, 0])],
    lastQuad: m.visible,
    smooth,
    diag: {},
  };
}

/** One case, end to end, in a fresh browser context against a Studio already serving `dir`. */
// fallow-ignore-next-line complexity
export async function runCase({ browser, spec, dir, files, url, evidence }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const ctx = { page, dir, files, handles: null };
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  evidence.shots = {};
  const shoot = async (name) =>
    (evidence.shots[name] = await page.screenshot({ type: "jpeg", quality: 70 }));
  let committedFiles = null;
  try {
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument(instrumentPage);
    await page.goto(url);
    let pre = await openStudio(ctx);
    await disableSnap(page);
    const zoom = await setZoom(ctx, spec.zoom, pre.map.toScreen(centre(pre.visible)));
    pre = await settled(ctx);
    await selectTarget(ctx, pre);
    pre = await settled(ctx);
    const original = readFiles(dir, files);

    const drive =
      spec.gesture === "nudge"
        ? await nudgeGesture(ctx, pre)
        : await pointerGesture(ctx, spec.gesture, pre);
    await waitForFiles(ctx, { from: original, timeout: spec.gesture === "nudge" ? 6000 : 5000 });
    await nextFrame(page, 2);
    await blurPreview(page);
    await page.keyboard.press("Escape");
    const committed = await settled(ctx);
    await shoot("committed");
    committedFiles = readFiles(dir, files);
    const saved = !sameFiles(committedFiles, original);

    // Undo and redo run before any reload, against the files as they stood once the commit settled.
    await chord(page, "Control+z");
    const undo = await waitForFiles(ctx, { want: original, timeout: 4000 });
    const undone = await settled(ctx);
    await shoot("undone");
    await blurPreview(page);
    await chord(page, "Control+Shift+z");
    const redo = await waitForFiles(ctx, { want: committedFiles, timeout: 4000 });
    const redone = await settled(ctx);

    await page.reload();
    const reloaded = await openStudio(ctx);
    await shoot("reloaded");
    const quads = { pre, committed, undone, redone, reloaded };
    const round = (m) => m.visible.map((p) => p.map((v) => Math.round(v * 100) / 100));
    return {
      zoom,
      saved,
      tracking: {
        max: Math.max(...drive.errors),
        p95: percentile(drive.errors, 95),
        frames: drive.errors.length,
      },
      drop: quadDistance(drive.lastQuad, committed.visible),
      reload: quadDistance(committed.visible, reloaded.visible),
      undo: {
        bytes: saved && undo.reached,
        box: quadDistance(undone.visible, pre.visible),
        redoBytes: saved && redo.reached,
        redoBox: quadDistance(redone.visible, committed.visible),
      },
      smooth: drive.smooth,
      diag: {
        ...drive.diag,
        consoleErrors: consoleErrors.slice(0, 5),
        quads: Object.fromEntries(Object.entries(quads).map(([k, m]) => [k, round(m)])),
      },
    };
  } catch (error) {
    await shoot("error").catch(() => undefined);
    throw error;
  } finally {
    evidence.files = committedFiles;
    await context.close().catch(() => undefined);
  }
}
