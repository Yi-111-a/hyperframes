#!/usr/bin/env bun
/**
 * Edit accuracy benchmark: real pointer and keyboard gestures in the built CLI Studio, scored in composition px.
 * Build the CLI first. On a shared box, hold the suite lock:
 *   flock /tmp/hf-suite.lock bun run --cwd packages/studio test:edit-accuracy -- --grid full --jobs 4
 * Flags: --grid full|pr  --shard i/n  --jobs N  --filter <regex on case id>  --out <dir>  --port <first>  --cli <cli.js>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { resolveHeadlessShellPath } from "../../../../engine/src/index.ts";
import { buildGrid, writeFixture } from "./grid.mjs";
import { killServers, runCase, startServer, stopServer } from "./case.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const LIMIT_PX = 0.5;
const FRAME_MS = 16.7;
const METRICS = ["tracking", "drop", "reload", "undo", "smooth"];

const { values: opt } = parseArgs({
  options: {
    grid: { type: "string", default: "full" },
    shard: { type: "string", default: "1/1" },
    jobs: { type: "string", default: "1" },
    filter: { type: "string", default: "" },
    out: { type: "string" },
    port: { type: "string", default: "5800" },
    cli: { type: "string", default: join(REPO, "packages/cli/dist/cli.js") },
  },
});
const [shard, shards] = opt.shard.split("/").map(Number);
const filter = new RegExp(opt.filter);
const cases = buildGrid(opt.grid).filter((c, i) => filter.test(c.id) && i % shards === shard - 1);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(opt.out ?? join(HERE, "../evidence/edit-accuracy", runId));
const chrome = resolveHeadlessShellPath();
if (!chrome) throw new Error("no chrome-headless-shell: run `npx hyperframes browser ensure`");
mkdirSync(out, { recursive: true });

/** Worst-first value per metric; a failed byte check ranks above any box distance. */
const worstValue = {
  tracking: (r) => r.tracking.max,
  drop: (r) => r.drop,
  reload: (r) => r.reload,
  undo: (r) => (r.undo.bytes && r.undo.redoBytes ? 0 : 1e6) + Math.max(r.undo.box, r.undo.redoBox),
  smooth: (r) => r.smooth.p95,
};

function score(spec, r) {
  if (r.error)
    return {
      ...spec,
      ...r,
      pass: false,
      checks: Object.fromEntries(METRICS.map((m) => [m, false])),
    };
  const checks = {
    tracking: r.tracking.max <= LIMIT_PX,
    drop: r.drop <= LIMIT_PX,
    reload: r.reload <= LIMIT_PX,
    undo: r.undo.bytes && r.undo.redoBytes && Math.max(r.undo.box, r.undo.redoBox) <= LIMIT_PX,
    smooth: r.smooth.p95 !== null && r.smooth.p95 <= FRAME_MS,
  };
  return { ...spec, ...r, pass: Object.values(checks).every(Boolean), checks };
}

async function runOne(spec, browser, port) {
  const started = Date.now();
  const root = mkdtempSync(join(tmpdir(), "hf-edit-accuracy-"));
  const dir = join(root, "case");
  const files = writeFixture(spec, dir);
  const evidence = {};
  const log = [];
  let result;
  let server;
  try {
    server = await startServer(opt.cli, dir, port, log);
    result = await runCase({
      browser,
      spec,
      dir,
      files,
      url: `http://127.0.0.1:${port}/#project/case`,
      evidence,
    });
  } catch (error) {
    result = {
      error: `${error?.message ?? error}\n${error?.stack ?? ""}`.slice(0, 1200),
      serverLog: log.join("").slice(-600),
    };
  } finally {
    if (server) await stopServer(server);
  }
  const scored = { ...score(spec, result), seconds: (Date.now() - started) / 1000 };
  if (!scored.pass) {
    const caseDir = join(out, "cases", spec.id);
    mkdirSync(caseDir, { recursive: true });
    for (const [name, jpeg] of Object.entries(evidence.shots ?? {}))
      writeFileSync(join(caseDir, `${name}.jpg`), jpeg);
    for (const [name, text] of Object.entries(evidence.files ?? {}))
      writeFileSync(join(caseDir, `saved-${name.replace("/", "-")}`), text);
  }
  rmSync(root, { recursive: true, force: true });
  const fails = METRICS.filter((m) => !scored.checks[m]).join(",");
  console.log(
    `${scored.pass ? "PASS" : "FAIL"} ${spec.id} ${scored.seconds.toFixed(1)}s ${scored.error ? "ERROR" : fails}`,
  );
  return scored;
}

async function worker(index, queue, results) {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      results.push(await runOne(spec, browser, Number(opt.port) + index));
    }
  } finally {
    await browser.close();
  }
}

const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);

function summarize(results, seconds) {
  const passing = results.filter((r) => r.pass).length;
  // Smoothness is still ungated in CI, so the score is also shown without it.
  const accurate = results.filter((r) =>
    METRICS.every((m) => m === "smooth" || r.checks[m]),
  ).length;
  const measured = results.filter((r) => !r.error);
  const perMetric = METRICS.map((m) => {
    const worst = measured.reduce(
      (a, r) => (!a || worstValue[m](r) > worstValue[m](a) ? r : a),
      null,
    );
    return {
      metric: m,
      pass: results.filter((r) => r.checks[m]).length,
      worst: worst && { id: worst.id, value: round(worstValue[m](worst)) },
    };
  });
  return {
    passing,
    accurate,
    total: results.length,
    errors: results.length - measured.length,
    perMetric,
    seconds: Math.round(seconds),
  };
}

function table(summary, meta, results) {
  const lines = [
    `# Edit accuracy: ${summary.passing}/${summary.total} cases pass`,
    "",
    `${summary.accurate}/${summary.total} pass every metric except smoothness.`,
    "",
    `Commit ${meta.commit}, grid \`${meta.grid}\`, ${meta.date}, ${summary.seconds}s with ${meta.jobs} jobs, ${summary.errors} harness errors.`,
    `Pass: tracking, drop and reload ≤ ${LIMIT_PX} px; undo and redo byte-identical with the box ≤ ${LIMIT_PX} px; frame p95 ≤ ${FRAME_MS} ms.`,
    "",
    "| Metric | Pass | Worst | Worst case |",
    "|---|---|---|---|",
    ...summary.perMetric.map(
      (m) =>
        `| ${m.metric} | ${m.pass}/${summary.total} | ${m.worst?.value ?? "-"} | ${m.worst?.id ?? "-"} |`,
    ),
    "",
    "| Gesture | Cases | Pass | " + METRICS.join(" | ") + " |",
    "|---|---|---|" + METRICS.map(() => "---").join("|") + "|",
  ];
  for (const g of [...new Set(results.map((r) => r.gesture))]) {
    const rs = results.filter((r) => r.gesture === g);
    lines.push(
      `| ${g} | ${rs.length} | ${rs.filter((r) => r.pass).length} | ${METRICS.map((m) => rs.filter((r) => r.checks[m]).length).join(" | ")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** One line per case, so a baseline diff reads case by case. */
function baseline(meta, results) {
  const entries = [...results]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => {
      const v = r.error
        ? { pass: false, error: true }
        : {
            pass: r.pass,
            tracking: round(r.tracking.max),
            drop: round(r.drop),
            reload: round(r.reload),
            undo: r.checks.undo,
            smooth: round(r.smooth.p95),
          };
      return `    ${JSON.stringify(r.id)}: ${JSON.stringify(v)}`;
    });
  return `{\n  "commit": ${JSON.stringify(meta.commit)},\n  "grid": ${JSON.stringify(meta.grid)},\n  "cases": {\n${entries.join(",\n")}\n  }\n}\n`;
}

process.on("exit", killServers);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    killServers();
    process.exit(130);
  });
}
const started = Date.now();
const queue = [...cases];
const results = [];
const jobs = Math.max(1, Math.min(Number(opt.jobs), cases.length));
console.log(`edit accuracy: ${cases.length} cases, ${jobs} jobs, chrome ${chrome}, out ${out}`);
await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i, queue, results)));
results.sort((a, b) => a.id.localeCompare(b.id));
const meta = {
  commit: execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim(),
  grid:
    opt.grid +
    (opt.filter ? ` filter ${opt.filter}` : "") +
    (shards > 1 ? ` shard ${opt.shard}` : ""),
  date: new Date().toISOString(),
  jobs,
  chrome,
};
const summary = summarize(results, (Date.now() - started) / 1000);
writeFileSync(
  join(out, "results.json"),
  JSON.stringify({ meta, summary, cases: results }, null, 1),
);
writeFileSync(join(out, "table.md"), table(summary, meta, results));
writeFileSync(join(out, "baseline.json"), baseline(meta, results));
console.log(table(summary, meta, results));
