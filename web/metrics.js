/* Pure trial-evidence and energy-class maths. No DOM: unit-tested with node --test (tests/web/).
   H is the client history: { t: [seconds], cols: { key: [value|null] } }. */

export const LETTERS = "ABCDEFG";
export const SETTLE_S = 10;   // after Apply, ignore this long while clocks settle
export const WINDOW_S = 30;   // before-window and class median window
export const MIN_N = 3;       // fewer samples than this: no baseline, no class
export const MIN_AFTER = 10;  // after-window samples before a trial verdict (fewer: "measuring")
const ANY = Number.MIN_VALUE; // decode gate for "any decode at all" (tok/s > 0)
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

/* The server sends no start time; it is a function of the countdown. remaining_s is whole seconds from another
   clock read than snap.t, so the start is exact to ±1 s (a reload can move it by one sample). */
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

/* Lag-1 autocorrelation (bias-corrected), clamped to [0, 0.9]. Power under load drifts, so neighbouring samples are not independent. */
function rho1(a) {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { den += (a[i] - m) ** 2; if (i) num += (a[i] - m) * (a[i - 1] - m); }
  const r = den ? num / den : 0;
  return Math.min(0.9, Math.max(0, r + (1 + 4 * r) / a.length)); // + the small-sample bias of the estimate
}
/* Median change with a noise judgement. Noise is the largest of: 2 MAD of the baseline; the uncertainty of a
   difference of two medians, 2.5 × 1.4826 MAD × sqrt(f (1/nb + 1/na)) with f = (1 + rho) / (1 − rho) for
   correlated samples, so small or drifting windows need a larger change; 2 % of the baseline; a per-metric floor. */
export function delta(key, before, after) {
  if (before.length < MIN_N || after.length < MIN_N) return null;
  const mb = median(before), ma = median(after), d = ma - mb, m = mad(before), r = rho1(before);
  const se = 2.5 * 1.4826 * m * Math.sqrt(((1 + r) / (1 - r)) * (1 / before.length + 1 / after.length));
  const noise = Math.max(2 * m, se, 0.02 * Math.abs(mb), FLOOR[key] ?? 0);
  const better = BETTER[key] ?? 0;
  let verdict = "within noise";
  if (Math.abs(d) > noise) verdict = better === 0 ? (d > 0 ? "higher" : "lower") : d * better > 0 ? "better" : "worse";
  return { key, d, noise, verdict, pct: mb ? (100 * d) / Math.abs(mb) : null, before: mb, after: ma };
}

/* Evidence for one metric during a trial: measuring, no decode traffic, decode below the minimum, or a delta.
   The decode minimum only picks the baseline. After the start, tok/s and W keep every sample with any decode,
   so a trial that slows decode below the minimum shows as slower, not as "no traffic". */
export function trialDelta(H, key, started, now, scale = SCALE_DEFAULT) {
  const ready = started + SETTLE_S + MIN_AFTER;
  if (now < started + SETTLE_S) return { state: "measuring", wait: Math.ceil(ready - now) };
  const decoding = windowSamples(H, "llm.tok_s", started - WINDOW_S, started, scale.min).length >= MIN_N;
  const gated = DECODE.has(key) || (key === "gpu.power_w" && decoding);
  const before = windowSamples(H, key, started - WINDOW_S, started, gated ? scale.min : null);
  const gateAfter = !gated ? null : key === "llm.j_per_tok" ? scale.min : ANY;
  const after = windowSamples(H, key, started + SETTLE_S, now, gateAfter, true);
  const d = after.length >= MIN_AFTER && delta(key, before, after);
  if (d) return { state: "ok", ...d };
  if (now < ready) return { state: "measuring", wait: Math.ceil(ready - now) };
  if (!gated) return { state: "measuring", wait: 0 };
  if (key === "llm.j_per_tok" && before.length >= MIN_N
    && windowSamples(H, "llm.tok_s", started + SETTLE_S, now, ANY, true).length >= MIN_AFTER) return { state: "below-min", min: scale.min };
  return { state: "no-decode" };
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
  if (c) return { state: "ok", ...c };
  // Decoding right now but too few samples yet (e.g. just after page load): warming up, not idle.
  const tok = windowSamples(H, "llm.tok_s", now - WINDOW_S, now, null, true)[0];
  if (tok != null && tok >= scale.min) {
    return { state: "warming", n: windowSamples(H, "llm.j_per_tok", now - WINDOW_S, now, scale.min, true).length };
  }
  return { state: "idle" };
}
/* During a trial: the class before (30 s up to the start) and now (from start + 10 s).
   "below-min": decode goes on after the start, but below the minimum, so there is no class. */
export function classTrial(H, started, now, scale = SCALE_DEFAULT) {
  const before = jClass(H, started - WINDOW_S, started, scale, false);
  if (now < started + SETTLE_S) return { state: "settling", before, now: null, wait: Math.ceil(started + SETTLE_S - now) };
  const after = jClass(H, started + SETTLE_S, now, scale, true);
  if (after) return { state: "ok", before, now: after, wait: 0 };
  const below = before && windowSamples(H, "llm.tok_s", started + SETTLE_S, now, ANY, true).length >= MIN_N;
  return { state: below ? "below-min" : "settling", before, now: null, wait: 0 };
}

/* A better class must not hide a slower decode (and the mirror case). belowMin: the trial has no class
   because decode fell below the minimum. */
export function honesty(beforeK, nowK, tok, belowMin = null) {
  if (!tok || tok.pct == null) return null;
  const p = Math.round(Math.abs(tok.pct));
  if (belowMin != null && tok.verdict === "worse") return `No class: decode is ${p} % slower, below ${belowMin} tok/s.`;
  if (beforeK == null || nowK == null) return null;
  if (nowK < beforeK && tok.verdict === "worse") return `Lower class, but decode is ${p} % slower.`;
  if (nowK > beforeK && tok.verdict === "better") return `Higher class, but decode is ${p} % faster.`;
  return null;
}

/* A usable scale: finite, a > 0, r > 1, min >= 0, and the top edge (a × r^5) still finite. */
export const validScale = (a, r, min) => a > 0 && r > 1 && min >= 0 && Number.isFinite(a + r + min) && Number.isFinite(a * r ** 5);
/* Stored scale (localStorage string). Anything invalid falls back to the defaults. */
export function loadScale(raw) {
  try {
    const v = JSON.parse(raw);
    const a = Number(v?.a), r = Number(v?.r), min = Number(v?.min);
    if (validScale(a, r, min)) return { a, r, min };
  } catch { /* fall through */ }
  return { ...SCALE_DEFAULT };
}

/* How a trial ended, from the server's event log (newest last). Keep after reboot logs "kept" (persist false)
   and then "persisted" or "persist_failed". boot: "saved" | "failed" | null. */
export function trialOutcome(events) {
  const i = events.findLastIndex((e) => e.kind === "kept" || e.kind === "reverted" || e.kind === "trial_dropped_by_reboot");
  const ev = events[i];
  if (ev?.kind !== "kept") return { kind: "reverted", ev, boot: null };
  const next = events.slice(i + 1).find((e) => e.kind === "persisted" || e.kind === "persist_failed");
  return { kind: "kept", ev, boot: next ? (next.kind === "persisted" ? "saved" : "failed") : null };
}
