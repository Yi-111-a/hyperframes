#!/usr/bin/env bun
/**
 * Edit accuracy benchmark: real pointer and keyboard gestures in the built CLI Studio, scored in composition px.
 * Build the CLI first (core, parsers, lint and studio-server included), then:
 *   bun run --cwd packages/studio test:edit-accuracy -- --grid full --jobs 4
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
import { METRICS, score, writeReport } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");

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

/** Evidence for a failing case only: the Studio screens at each stage and the saved files. */
// fallow-ignore-next-line complexity
function saveEvidence(id, evidence) {
  const caseDir = join(out, "cases", id);
  mkdirSync(caseDir, { recursive: true });
  for (const [name, jpeg] of Object.entries(evidence.shots ?? {}))
    writeFileSync(join(caseDir, `${name}.jpg`), jpeg);
  for (const [name, text] of Object.entries(evidence.files ?? {}))
    writeFileSync(join(caseDir, `saved-${name.replace("/", "-")}`), text);
}

function verdict(r) {
  const fails = r.error ? "ERROR" : METRICS.filter((m) => !r.checks[m]).join(",");
  return `${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.seconds.toFixed(1)}s ${fails}`;
}

// fallow-ignore-next-line complexity
const errorResult = (error, log) => ({
  error: `${error?.message ?? error}\n${error?.stack ?? ""}`.slice(0, 1200),
  serverLog: log.join("").slice(-600),
});

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
    result = errorResult(error, log);
  } finally {
    if (server) await stopServer(server);
  }
  const scored = { ...score(spec, result), seconds: (Date.now() - started) / 1000 };
  if (!scored.pass) saveEvidence(spec.id, evidence);
  rmSync(root, { recursive: true, force: true });
  console.log(verdict(scored));
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

process.on("exit", killServers);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    killServers();
    process.exit(130);
  });
}
// Stamped at start. Studio is the last commit to shipped package code, which the built CLI is assumed to come from.
const git = (args) => execSync(`git ${args}`, { cwd: REPO }).toString().trim();
const studio = git(
  "log -1 --format=%h -- packages :!packages/studio/tests :!packages/studio/package.json",
);
const bench = git("rev-parse --short HEAD");
const started = Date.now();
const queue = [...cases];
const results = [];
const jobs = Math.max(1, Math.min(Number(opt.jobs), cases.length));
console.log(`edit accuracy: ${cases.length} cases, ${jobs} jobs, chrome ${chrome}, out ${out}`);
await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i, queue, results)));
results.sort((a, b) => a.id.localeCompare(b.id));
const meta = {
  studio,
  bench,
  grid:
    opt.grid +
    (opt.filter ? ` filter ${opt.filter}` : "") +
    (shards > 1 ? ` shard ${opt.shard}` : ""),
  date: new Date().toISOString(),
  jobs,
  chrome,
};
console.log(writeReport(out, meta, results, (Date.now() - started) / 1000));
