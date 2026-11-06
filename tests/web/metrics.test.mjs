// Unit tests for web/metrics.js (pure functions). Run: node --test tests/web/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edges, classIdx, bandText, classNow, classTrial, trialStart, delta, honesty, loadScale, SCALE_DEFAULT,
  trialDelta, trialOutcome, validScale, linkState, notSaved, revertReason, errorText,
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

test("classNow warms up while decoding but with too few samples", () => {
  // Page just loaded: two decoding samples so far, tok/s clearly above the minimum.
  const H = hist(range(1000, 1002, () => ({ "llm.tok_s": 43.6, "llm.j_per_tok": 0.5 })));
  const c = classNow(H, 1001);
  assert.equal(c.state, "warming");
  assert.equal(c.n, 2);
  // Not decoding now: still idle, even with a few gated samples earlier in the window.
  const H2 = hist(range(1000, 1010, (t) => ({ "llm.tok_s": t < 1002 ? 40 : 1, "llm.j_per_tok": 0.5 })));
  assert.equal(classNow(H2, 1009).state, "idle");
});

test("classNow ignores samples below the decode minimum", () => {
  // 30 s of 0.42 J/tok, but only 2 samples with tok/s >= 5.
  const H = hist(range(1000, 1030, (t) => ({ "llm.tok_s": t >= 1028 ? 40 : 2, "llm.j_per_tok": 0.42 })));
  assert.equal(classNow(H, 1029).state, "warming");  // decoding now, but only 2 gated samples
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

test("trialDelta: decode that drops below the minimum reads as slower, not as no traffic", () => {
  // Before: 12 tok/s at 60 W. From the start: 4 tok/s at 30 W (below the 5 tok/s minimum).
  const H = hist(range(950, 1031, (t) => (t < 1000
    ? { "llm.tok_s": 12, "gpu.power_w": 60, "llm.j_per_tok": 5 }
    : { "llm.tok_s": 4, "gpu.power_w": 30, "llm.j_per_tok": 7.5 })));
  const tok = trialDelta(H, "llm.tok_s", 1000, 1030);
  assert.equal(tok.state, "ok");
  assert.equal(tok.verdict, "worse");
  assert.equal(Math.round(tok.pct), -67);
  const w = trialDelta(H, "gpu.power_w", 1000, 1030);
  assert.equal(w.state, "ok");
  assert.equal(w.verdict, "better");
  assert.deepEqual(trialDelta(H, "llm.j_per_tok", 1000, 1030), { state: "below-min", min: 5 });
  const ct = classTrial(H, 1000, 1030);
  assert.equal(ct.state, "below-min");
  assert.equal(ct.now, null);
  assert.equal(honesty(ct.before.k, null, tok, 5), "No class: decode is 67 % slower, below 5 tok/s.");
});

test("trialDelta: no decode after the start is no-decode; no baseline is no-decode", () => {
  const stopped = hist(range(950, 1031, (t) => ({ "llm.tok_s": t < 1000 ? 12 : 0, "gpu.power_w": 40 })));
  assert.equal(trialDelta(stopped, "llm.tok_s", 1000, 1030).state, "no-decode");
  const idle = hist(range(950, 1031, () => ({ "llm.tok_s": 0, "gpu.power_w": 40 })));
  assert.equal(trialDelta(idle, "llm.tok_s", 1000, 1030).state, "no-decode");
});

test("trialDelta: GPU power is gated only when the baseline was decoding", () => {
  // Idle LLM: every power sample counts.
  const idle = hist(range(950, 1031, (t) => ({ "llm.tok_s": null, "gpu.power_w": t < 1000 ? 40 : 30 })));
  const a = trialDelta(idle, "gpu.power_w", 1000, 1030);
  assert.equal(a.state, "ok");
  assert.equal(a.d, -10);
  // Decoding baseline: power samples without decode are left out on both sides.
  const busy = hist(range(950, 1031, (t) => {
    const dec = t % 2 === 0;
    return { "llm.tok_s": dec ? 20 : 0, "gpu.power_w": dec ? (t < 1000 ? 60 : 50) : 5 };
  }));
  const b = trialDelta(busy, "gpu.power_w", 1000, 1030);
  assert.equal(b.before, 60);
  assert.equal(b.after, 50);
});

test("trialDelta: settle, minimum after-window and window edges", () => {
  // The sample at t = started is in neither window: before is 30, after is 20, t = 1000 is 999.
  const H = hist(range(950, 1041, (t) => ({ "gpu.power_w": t === 1000 ? 999 : t < 1000 ? 30 : 20 })));
  assert.deepEqual(trialDelta(H, "gpu.power_w", 1000, 1004), { state: "measuring", wait: 16 });
  // At 1015 the after-window holds 6 samples (1010..1015): still measuring.
  assert.deepEqual(trialDelta(H, "gpu.power_w", 1000, 1015), { state: "measuring", wait: 5 });
  const d = trialDelta(H, "gpu.power_w", 1000, 1020);
  assert.equal(d.state, "ok");
  assert.equal(d.before, 30);
  assert.equal(d.after, 20);
});

test("delta: a flat noisy series stays within noise", () => {
  // Seeded AR(1) noise (rho 0.8), sigma 3 W around 60 W: 300 no-change trials of 30 s before, 10 s after.
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let false_ = 0;
  for (let n = 0; n < 300; n++) {
    let e = gauss() * 3;
    const xs = Array.from({ length: 40 }, () => (e = 0.8 * e + Math.sqrt(1 - 0.64) * 3 * gauss(), 60 + e));
    if (delta("gpu.power_w", xs.slice(0, 30), xs.slice(30)).verdict !== "within noise") false_++;
  }
  assert.ok(false_ / 300 < 0.1, `false verdicts: ${false_} of 300`);
});

test("trialOutcome reads Keep after reboot from the events after kept", () => {
  const kept = { kind: "kept", persist: false, values: {} };
  assert.deepEqual(trialOutcome([{ kind: "applied" }, kept]), { kind: "kept", ev: kept, boot: null });
  assert.equal(trialOutcome([kept, { kind: "persisted", gpu: true }]).boot, "saved");
  assert.equal(trialOutcome([kept, { kind: "persist_failed", error: "x" }]).boot, "failed");
  // An older persisted event before the keep does not count.
  assert.equal(trialOutcome([{ kind: "persisted" }, kept]).boot, null);
  const rev = { kind: "reverted", why: "timeout" };
  assert.deepEqual(trialOutcome([kept, { kind: "persisted" }, { kind: "applied" }, rev]), { kind: "reverted", ev: rev, boot: null });
});

test("validScale rejects values that overflow", () => {
  assert.ok(validScale(0.25, 1.41, 5));
  assert.ok(!validScale(1e308, 1.41, 5));
  assert.ok(!validScale(0.25, 1e100, 5));
  assert.ok(!validScale(0.25, 1.41, Infinity));
});

test("linkState: connecting, lost, stale and live", () => {
  assert.equal(linkState({ open: null, age: 1 }), "connecting");
  assert.equal(linkState({ open: false, age: 1 }), "lost");
  assert.equal(linkState({ open: true, age: null }), "stale");
  assert.equal(linkState({ open: true, age: 5 }), "live");
  assert.equal(linkState({ open: true, age: 5.1 }), "stale");
});

test("linkState: a (re)opened stream keeps the old state until its first message, for at most 5 s", () => {
  assert.equal(linkState({ open: true, age: 30, held: 0.15, prev: "lost" }), "lost", "lost goes to live, not via stale");
  assert.equal(linkState({ open: true, age: null, held: 0.15, prev: "connecting" }), "connecting");
  assert.equal(linkState({ open: true, age: 30, held: 5.1, prev: "lost" }), "stale", "open but silent: stale after 5 s");
  assert.equal(linkState({ open: true, age: 0.2, held: null, prev: "lost" }), "live");
});

test("notSaved compares the running value with the boot value", () => {
  const limits = { x925: [1000000, 3900000], a725: [1000000, 2808000] };
  assert.equal(notSaved("epp", 192, { epp: 192 }), false, "equal");
  assert.equal(notSaved("gpu_cap_mhz", 2000, { gpu_cap_mhz: 2100 }), true, "different");
  assert.equal(notSaved("gpu_cap_mhz", null, {}), false, "no clocklock line: no cap at boot");
  assert.equal(notSaved("gpu_cap_mhz", 2000, {}), true, "a cap that boot does not set");
  assert.equal(notSaved("x925_max_khz", 3900000, {}, limits), false, "CPU max absent: hardware max at boot");
  assert.equal(notSaved("x925_max_khz", 3000000, {}, limits), true, "CPU max below the hardware max");
  assert.equal(notSaved("epp", 192, {}), false, "EPP boot value unknown");
  assert.equal(notSaved("governor", "ondemand", {}), false, "governor boot value unknown");
});

test("revertReason turns event codes into words", () => {
  assert.equal(revertReason({ kind: "reverted", why: "timeout" }), "not kept in time");
  assert.equal(revertReason({ kind: "reverted", why: "user" }), "");
  assert.equal(revertReason({ kind: "reverted", why: "shutdown" }), "the server stopped");
  assert.equal(revertReason({ kind: "reverted", why: "recovered after restart" }), "the server restarted");
  assert.equal(revertReason({ kind: "trial_dropped_by_reboot" }), "a reboot ended the trial");
  assert.equal(revertReason(undefined), "the server restarted");
  assert.equal(revertReason({ kind: "reverted", why: "odd" }), "odd");
});

test("errorText names the console server or the helper", () => {
  const net = /console server did not answer/;
  assert.match(errorText(new TypeError("Failed to fetch"), "keep"), net);
  assert.match(errorText({ status: 502, message: "HTTP 502" }, "keep"), net, "a proxy 502 has no server error body");
  assert.doesNotMatch(errorText(new TypeError("Failed to fetch"), "keep"), /Live/, "the stream can stay live while a POST fails");
  assert.equal(errorText({ status: 502, server: true, message: "helper failed: no sudo" }, "keep-boot"),
    "Kept until reboot; saving for boot failed: no sudo.");
  assert.equal(errorText({ status: 409, server: true, message: "a trial is open" }, "apply"), "A trial is already open: Keep or Revert it first.");
});
