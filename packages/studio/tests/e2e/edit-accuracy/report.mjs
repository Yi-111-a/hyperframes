/** Scoring and the three report files (results.json, table.md, baseline.json) for the edit accuracy bench. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { percentile } from "./geometry.mjs";

const LIMIT_PX = 0.5;
// A frame over 1.5 vsyncs is dropped; raw rAF p95 stays reported so a different rule re-scores without a re-run.
const DROPPED_FRAME_MS = 25;
const WORK_MS = 8;
export const METRICS = ["tracking", "drop", "reload", "undo", "smooth"];

/** Worst-first value per metric; undo ranks by box distance, and its byte failures are counted apart. */
const worstValue = {
  tracking: (r) => r.tracking.max,
  drop: (r) => r.drop,
  reload: (r) => r.reload,
  undo: (r) => Math.max(r.undo.box, r.undo.redoBox),
  smooth: (r) => r.smooth.workP95,
};

/** Dropped frames and main-thread ms per frame at p95, from the raw intervals and trace work a case stores. */
const frameBudget = (smooth) => ({
  ...smooth,
  dropped: smooth.intervals.filter((d) => d > DROPPED_FRAME_MS).length,
  workP95: percentile(smooth.work, 95),
});

// fallow-ignore-next-line complexity
export function score(spec, r) {
  if (r.error)
    return {
      ...spec,
      ...r,
      pass: false,
      checks: Object.fromEntries(METRICS.map((m) => [m, false])),
    };
  const smooth = frameBudget(r.smooth);
  const checks = {
    tracking: r.tracking.max <= LIMIT_PX,
    drop: r.drop <= LIMIT_PX,
    reload: r.reload <= LIMIT_PX,
    undo: r.undo.bytes && r.undo.redoBytes && Math.max(r.undo.box, r.undo.redoBox) <= LIMIT_PX,
    smooth: smooth.dropped === 0 && smooth.workP95 !== null && smooth.workP95 <= WORK_MS,
  };
  return { ...spec, ...r, smooth, pass: Object.values(checks).every(Boolean), checks };
}

const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
// Rounded up for baseline.json, so a stored value is within a limit exactly when the measured one is.
const roundUp = (v) => Math.ceil(v * 100 - 1e-9) / 100;

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
    bytesDiffer: {
      undo: measured.filter((r) => !r.undo.bytes).length,
      redo: measured.filter((r) => !r.undo.redoBytes).length,
    },
    perMetric,
    seconds: Math.round(seconds),
  };
}

// fallow-ignore-next-line complexity
const metricRow = (m, total) =>
  `| ${m.metric} | ${m.pass}/${total} | ${m.worst?.value ?? "-"} | ${m.worst?.id ?? "-"} |`;

function table(summary, meta, results) {
  const lines = [
    `# Edit accuracy: ${summary.passing}/${summary.total} cases pass`,
    "",
    `${summary.accurate}/${summary.total} pass every metric except smoothness.`,
    "",
    `Studio ${meta.studio}, bench ${meta.bench}, grid \`${meta.grid}\`, ${meta.date}, ${summary.seconds}s with ${meta.jobs} jobs, ${summary.errors} harness errors.`,
    `Pass: tracking, drop and reload ≤ ${LIMIT_PX} px; undo and redo byte-identical with the box ≤ ${LIMIT_PX} px; no frame over ${DROPPED_FRAME_MS} ms and main-thread work ≤ ${WORK_MS} ms per frame at p95.`,
    "",
    `Undo or redo left different bytes in ${summary.bytesDiffer.undo} undo and ${summary.bytesDiffer.redo} redo cases.`,
    "",
    "| Metric | Pass | Worst | Worst case |",
    "|---|---|---|---|",
    ...summary.perMetric.map((m) => metricRow(m, summary.total)),
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
            tracking: roundUp(r.tracking.max),
            drop: roundUp(r.drop),
            reload: roundUp(r.reload),
            undo: r.checks.undo,
            dropped: r.smooth.dropped,
            work: roundUp(r.smooth.workP95),
            frameP95: roundUp(r.smooth.p95),
          };
      return `    ${JSON.stringify(r.id)}: ${JSON.stringify(v)}`;
    });
  return `{\n  "studio": ${JSON.stringify(meta.studio)},\n  "bench": ${JSON.stringify(meta.bench)},\n  "grid": ${JSON.stringify(meta.grid)},\n  "cases": {\n${entries.join(",\n")}\n  }\n}\n`;
}

/** Writes results.json, table.md and baseline.json into `out`; returns the table. */
export function writeReport(out, meta, results, seconds) {
  const summary = summarize(results, seconds);
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify({ meta, summary, cases: results }, null, 1),
  );
  writeFileSync(join(out, "table.md"), table(summary, meta, results));
  writeFileSync(join(out, "baseline.json"), baseline(meta, results));
  return table(summary, meta, results);
}
