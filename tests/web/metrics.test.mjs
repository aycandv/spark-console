// Unit tests for web/metrics.js (pure functions). Run: node --test tests/web/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edges, classIdx, bandText, classNow, classTrial, trialStart, delta, honesty, loadScale, SCALE_DEFAULT,
} from "../../web/metrics.js";

// A history like the client's H: one sample per second.
function hist(rows) {
  const H = { t: [], cols: {} };
  for (const [t, row] of rows) {
    H.t.push(t);
    for (const k of Object.keys(row)) H.cols[k] ??= new Array(H.t.length - 1).fill(null);
    for (const [k, arr] of Object.entries(H.cols)) arr.push(row[k] ?? null);
  }
  return H;
}
const range = (from, to, f) => Array.from({ length: to - from }, (_, i) => [from + i, f(from + i)]);

test("edges() with the default scale", () => {
  // 0.25 × 1.41^k. The spec table rounds the last edge to 1.40; the exact value is 1.393.
  const e = edges();
  [0.25, 0.35, 0.50, 0.70, 0.99, 1.39].forEach((x, i) => assert.ok(Math.abs(e[i] - x) <= 0.005, `edge ${i}: ${e[i]}`));
});

test("classIdx maps J/token to a band", () => {
  assert.equal(classIdx(0.24), 0);
  assert.equal(classIdx(0.25), 1);
  assert.equal(classIdx(0.42), 2);
  assert.equal(classIdx(1.40), 6);
});

test("bandText names the open ends", () => {
  assert.equal(bandText(0), "under 0.25");
  assert.equal(bandText(6), "1.39 or more");
  assert.equal(bandText(2), "0.35–0.50");
});

test("classNow ignores samples below the decode minimum", () => {
  // 30 s of 0.42 J/tok, but only 2 samples with tok/s >= 5.
  const H = hist(range(1000, 1030, (t) => ({ "llm.tok_s": t >= 1028 ? 40 : 2, "llm.j_per_tok": 0.42 })));
  assert.equal(classNow(H, 1029).state, "idle");
  const H2 = hist(range(1000, 1030, () => ({ "llm.tok_s": 40, "llm.j_per_tok": 0.42 })));
  const c = classNow(H2, 1029);
  assert.equal(c.state, "ok");
  assert.equal(c.k, 2);
  assert.ok(Math.abs(c.median - 0.42) < 1e-9);
});

test("classTrial settles for 10 s and keeps the trial out of the baseline", () => {
  // Before the trial: 0.42 (C). From the trial start: 0.30 (B).
  const H = hist(range(950, 1030, (t) => ({ "llm.tok_s": 40, "llm.j_per_tok": t < 1000 ? 0.42 : 0.30 })));
  const early = classTrial(H, 1000, 1005);
  assert.equal(early.state, "settling");
  assert.equal(early.before.k, 2);
  assert.equal(early.wait, 5);
  const late = classTrial(H, 1000, 1029);
  assert.equal(late.state, "ok");
  assert.ok(Math.abs(late.before.median - 0.42) < 1e-9, "baseline holds only pre-trial samples");
  assert.equal(late.now.k, 1);
});

test("trialStart derives the start from the countdown", () => {
  assert.equal(trialStart({ t: 1000 }, { total_s: 60, remaining_s: 45 }), 985);
});

test("delta judges noise, floors and direction", () => {
  const flat = Array(10).fill(30);
  // MAD is 0, so the 0.5 W floor applies: +0.3 W is noise.
  assert.equal(delta("gpu.power_w", flat, Array(10).fill(30.3)).verdict, "within noise");
  const lower = delta("gpu.power_w", flat, Array(10).fill(20.4));
  assert.equal(lower.verdict, "better");
  assert.ok(Math.abs(lower.d + 9.6) < 1e-9);
  const slow = delta("llm.tok_s", Array(10).fill(40), Array(10).fill(28));
  assert.equal(slow.verdict, "worse");
  assert.equal(Math.round(slow.pct), -30);
  assert.equal(delta("gpu.util", Array(5).fill(50), Array(5).fill(90)).verdict, "higher");
  assert.equal(delta("gpu.power_w", [30, 30], flat), null, "fewer than 3 samples: no verdict");
});

test("honesty warns when a better class hides a slower decode", () => {
  const slower = delta("llm.tok_s", Array(10).fill(40), Array(10).fill(28));
  assert.equal(honesty(2, 1, slower), "Lower class, but decode is 30 % slower.");
  const same = delta("llm.tok_s", Array(10).fill(40), Array(10).fill(40.2));
  assert.equal(honesty(2, 1, same), null);
  const faster = delta("llm.tok_s", Array(10).fill(40), Array(10).fill(44.8));
  assert.equal(honesty(1, 2, faster), "Higher class, but decode is 12 % faster.");
});

test("loadScale rejects bad stored values", () => {
  assert.deepEqual(loadScale('{"a":0,"r":1.41,"min":5}'), SCALE_DEFAULT);
  assert.deepEqual(loadScale('{"a":0.25,"r":1,"min":5}'), SCALE_DEFAULT);
  assert.deepEqual(loadScale('{"a":0.25,"r":1.41,"min":-1}'), SCALE_DEFAULT);
  assert.deepEqual(loadScale("not json"), SCALE_DEFAULT);
  assert.deepEqual(loadScale(null), SCALE_DEFAULT);
  assert.deepEqual(loadScale('{"a":0.3,"r":1.5,"min":2}'), { a: 0.3, r: 1.5, min: 2 });
});
