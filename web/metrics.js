/* Pure trial-evidence and energy-class maths. No DOM: unit-tested with node --test (tests/web/).
   H is the client history: { t: [seconds], cols: { key: [value|null] } }. */

export const LETTERS = "ABCDEFG";
export const SETTLE_S = 10;   // after Apply, ignore this long while clocks settle
export const WINDOW_S = 30;   // before-window and class median window
export const MIN_N = 3;       // fewer samples than this: no verdict
export const SCALE_DEFAULT = Object.freeze({ a: 0.25, r: 1.41, min: 5 });

/* Per-metric noise floor and direction: -1 lower is better, +1 higher is better, 0 neutral. */
const FLOOR = { "gpu.power_w": 0.5, "llm.tok_s": 0.5, "llm.j_per_tok": 0.01, "gpu.tlimit_c": 1, "gpu.util": 2, "mem.avail_gib": 0.2 };
const BETTER = { "gpu.power_w": -1, "llm.tok_s": 1, "llm.j_per_tok": -1, "gpu.tlimit_c": 1, "gpu.util": 0, "mem.avail_gib": 0 };
const DECODE = new Set(["llm.tok_s", "llm.j_per_tok"]);

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function mad(a) {
  const m = median(a);
  return m == null ? null : median(a.map((x) => Math.abs(x - m)));
}

/* The server sends no start time; it is a pure function of the countdown, so a reload gives the same baseline. */
export const trialStart = (snap, trial) => snap.t - (trial.total_s - trial.remaining_s);

/* Values of `key` with from <= t < to (or t <= to when `incl`). With `gate`, only samples where decode >= gate. */
export function windowSamples(H, key, from, to, gate = null, incl = false) {
  const col = H.cols[key] || [], tok = H.cols["llm.tok_s"] || [], out = [];
  for (let i = H.t.length - 1; i >= 0; i--) {
    const t = H.t[i];
    if (t < from) break;
    if (incl ? t > to : t >= to) continue;
    const v = col[i];
    if (v == null || Number.isNaN(v)) continue;
    if (gate != null && !(tok[i] >= gate)) continue;
    out.push(v);
  }
  return out;
}

/* Median change with a noise judgement: noise = max(2 MAD, 2 % of baseline, floor). */
export function delta(key, before, after) {
  if (before.length < MIN_N || after.length < MIN_N) return null;
  const mb = median(before), ma = median(after), d = ma - mb;
  const noise = Math.max(2 * mad(before), 0.02 * Math.abs(mb), FLOOR[key] ?? 0);
  const better = BETTER[key] ?? 0;
  let verdict = "within noise";
  if (Math.abs(d) > noise) verdict = better === 0 ? (d > 0 ? "higher" : "lower") : d * better > 0 ? "better" : "worse";
  return { key, d, noise, verdict, pct: mb ? (100 * d) / Math.abs(mb) : null, before: mb, after: ma };
}

/* Evidence for one metric during a trial: measuring, no decode traffic, or a delta. */
export function trialDelta(H, key, started, now, scale = SCALE_DEFAULT) {
  if (now < started + SETTLE_S) return { state: "measuring", wait: Math.ceil(started + SETTLE_S - now) };
  let gate = DECODE.has(key) ? scale.min : null;
  if (key === "gpu.power_w" && windowSamples(H, "llm.tok_s", started - WINDOW_S, started, scale.min).length >= MIN_N) gate = scale.min;
  const before = windowSamples(H, key, started - WINDOW_S, started, gate);
  const after = windowSamples(H, key, started + SETTLE_S, now, gate, true);
  const d = delta(key, before, after);
  if (d) return { state: "ok", ...d };
  return gate != null ? { state: "no-decode" } : { state: "measuring", wait: 0 };
}

/* Energy classes: log-spaced edges, A below edges[0], G at edges[5] or more. */
export const edges = (scale = SCALE_DEFAULT) => [0, 1, 2, 3, 4, 5].map((k) => scale.a * scale.r ** k);
export function classIdx(j, scale = SCALE_DEFAULT) {
  const e = edges(scale);
  let k = 0;
  while (k < 6 && j >= e[k] - 1e-12) k++;
  return k;
}
export function bandText(k, scale = SCALE_DEFAULT) {
  const e = edges(scale), f = (x) => x.toFixed(2);
  if (k === 0) return `under ${f(e[0])}`;
  if (k === 6) return `${f(e[5])} or more`;
  return `${f(e[k - 1])}–${f(e[k])}`;
}

function jClass(H, from, to, scale, incl) {
  const s = windowSamples(H, "llm.j_per_tok", from, to, scale.min, incl);
  if (s.length < MIN_N) return null;
  const m = median(s);
  return { k: classIdx(m, scale), median: m, n: s.length };
}
/* The class now: 30 s median of J/token while decoding. */
export function classNow(H, now, scale = SCALE_DEFAULT) {
  const c = jClass(H, now - WINDOW_S, now, { ...scale }, true);
  return c ? { state: "ok", ...c } : { state: "idle" };
}
/* During a trial: the class before (30 s up to the start) and now (from start + 10 s). */
export function classTrial(H, started, now, scale = SCALE_DEFAULT) {
  const before = jClass(H, started - WINDOW_S, started, scale, false);
  if (now < started + SETTLE_S) return { state: "settling", before, now: null, wait: Math.ceil(started + SETTLE_S - now) };
  const after = jClass(H, started + SETTLE_S, now, scale, true);
  return after ? { state: "ok", before, now: after, wait: 0 } : { state: "settling", before, now: null, wait: 0 };
}

/* A better class must not hide a slower decode (and the mirror case). */
export function honesty(beforeK, nowK, tok) {
  if (beforeK == null || nowK == null || !tok || tok.pct == null) return null;
  const p = Math.round(Math.abs(tok.pct));
  if (nowK < beforeK && tok.verdict === "worse") return `Lower class, but decode is ${p} % slower.`;
  if (nowK > beforeK && tok.verdict === "better") return `Higher class, but decode is ${p} % faster.`;
  return null;
}

/* Stored scale (localStorage string). Anything invalid falls back to the defaults. */
export function loadScale(raw) {
  try {
    const v = JSON.parse(raw);
    const a = Number(v?.a), r = Number(v?.r), min = Number(v?.min);
    if (a > 0 && r > 1 && min >= 0 && Number.isFinite(a + r + min)) return { a, r, min };
  } catch { /* fall through */ }
  return { ...SCALE_DEFAULT };
}
