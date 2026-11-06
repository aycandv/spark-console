/* spark-console client (ES module). One SSE stream drives everything; controls stage values,
   Apply opens a trial on the server, Keep / Revert close it. Nodes are built once and patched per tick. */
import { trialStart, trialDelta, classNow, classTrial, honesty, loadScale, trialOutcome, SETTLE_S, linkState, notSaved, revertReason, errorText } from "./metrics.js";
import { initEnergy } from "./energy.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const NF = {};
const fmt = (v, d = 0) => {
  if (v == null || Number.isNaN(v)) return "—";
  NF[d] ??= new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return NF[d].format(v);
};
const signed = (v, d = 0) => {
  const r = Math.round(v * 10 ** d) / 10 ** d; // sign of the shown value, so no "−0.0"
  return (r > 0 ? "+" : r < 0 ? "−" : "±") + fmt(Math.abs(r), d);
};
const TF = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const clock = (t) => TF.format(new Date(t * 1000));
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const setHTML = (el, html) => { if (el._h !== html) { el.innerHTML = html; el._h = html; } };
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
/* Snap to where the server says we are, then glide linearly to the next second (WAAPI: no forced layout). */
function glide(el, prop, from, to) {
  el._glide?.cancel();
  el._glide = el.animate([{ [prop]: from }, { [prop]: reduced.matches ? from : to }], { duration: 1000, easing: "linear", fill: "forwards" });
}
/* A verdict or a class letter lands once: opacity and a 2 px blur; opacity only with reduced motion. */
function crossfade(el) {
  if (reduced.matches) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease" }); return; }
  el.animate([{ opacity: 0, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
}
const store = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const LABEL = { gpu_cap_mhz: "GPU cap", x925_max_khz: "X925 max", a725_max_khz: "A725 max", epp: "EPP", governor: "Governor" };
function knobShort(k, v) {
  if (k === "gpu_cap_mhz") return v == null ? "no cap" : fmt(v);
  if (k.endsWith("_khz")) return v == null ? "—" : fmt(v / 1000);
  return v == null ? "—" : String(v);
}
function knobText(k, v) {
  if (k === "gpu_cap_mhz") return v == null ? "no cap" : `${fmt(v)} MHz`;
  if (k.endsWith("_khz")) return v == null ? "—" : `${fmt(v / 1000)} MHz`;
  return v == null ? "—" : String(v);
}
const changeList = (obj) => Object.entries(obj).map(([k, v]) => `${LABEL[k]} ${knobText(k, v)}`).join(", ");
const chgHTML = (k, from, to) => `<span class="chg">${esc(LABEL[k])} <span class="sr-only">, was </span><s>${esc(knobShort(k, from))}</s><span aria-hidden="true">→</span><span class="sr-only">, now </span>${esc(knobText(k, to))}</span>`;

const S = {
  snap: null, control: null, profiles: [], staged: {}, stagedProfile: null, window: 120, sort: "cpu",
  busy: null, busyLabel: false, error: "", errorNet: false, clamp: null, link: null, gotAt: 0,
  trialKey: null, trialStarted: null, armedAt: 0, warned: false, lastRemaining: null, ev: null, lastEvidence: null, outcome: null,
  scale: loadScale(store.get("sc-energy-scale")), keys: store.get("sc-keys", "on") !== "off",
};

/* --- live-region helper: clear, then set next frame, so repeats are spoken again ------------------------- */
function announce(text) {
  const el = $("#commit-announce");
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = text; });
}

/* --- client-side history (mirrors the server's 1 h ring) -------------------------------------------------- */
const H = { t: [], cols: {} };
const H_MAX = 3600;
function seedHistory(cols) {
  H.t = cols.t || [];
  H.cols = {};
  for (const [k, v] of Object.entries(cols)) if (k !== "t") H.cols[k] = v;
}
function pushHistory(t, row) {
  if (H.t.length && t <= H.t[H.t.length - 1]) return;
  const n = H.t.length;
  H.t.push(t);
  for (const k of Object.keys(row)) if (!H.cols[k]) H.cols[k] = new Array(n).fill(null);
  for (const [k, arr] of Object.entries(H.cols)) arr.push(row[k] ?? null);
  if (H.t.length > H_MAX) {
    H.t.shift();
    for (const arr of Object.values(H.cols)) arr.shift();
  }
}
function windowData(keys) {
  const from = (H.t[H.t.length - 1] ?? 0) - S.window;
  let i = 0;
  while (i < H.t.length && H.t[i] < from) i++;
  return [H.t.slice(i), ...keys.map((k) => (H.cols[k] || []).slice(i))];
}

/* --- theme + canvas colours ---------------------------------------------------------------------------------- */
const C = {};
let probe;
const resolvedTheme = () => {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || t === "light" ? t : darkMQ.matches ? "dark" : "light";
};
function refreshColors() {
  if (!probe) { probe = document.createElement("span"); probe.hidden = true; document.body.append(probe); }
  for (const [k, v] of Object.entries({ ink: "--ink", ink2: "--ink-2", ink3: "--ink-3", amber: "--amber-edge", amberText: "--amber-text" })) {
    probe.style.color = `var(${v})`;
    C[k] = getComputedStyle(probe).color;
  }
  // A surface, so read it as one: forced colours map a background to Canvas (a text colour would be CanvasText).
  probe.style.backgroundColor = "var(--well)";
  C.well = getComputedStyle(probe).backgroundColor;
}
function themeChanged() {
  refreshColors();
  for (const c of charts) c.u.redraw();
  document.documentElement.dataset.chartTheme = resolvedTheme();
}
function setTheme(t) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.dataset.theme = t;
  store.set("sc-theme", t);
  const [mDark, mLight] = $$('meta[name="theme-color"]');
  mDark.content = t === "light" ? "#e9ebee" : "#141619";
  mLight.content = t === "dark" ? "#141619" : "#e9ebee";
  for (const b of $$("#theme [data-theme-set]")) b.setAttribute("aria-pressed", String(b.dataset.themeSet === t));
  themeChanged();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

/* --- charts -------------------------------------------------------------------------------------------------------- */
const charts = [];
const knobInTrial = (knob) => !!(knob && S.control?.trial && knob in S.control.trial.applied);
/* Read-back stroke: ink-3 before the trial start, ink after (a hard stop in a canvas gradient). */
function readStroke(u, base) {
  const col = C[base];
  const st = S.trialStarted;
  if (st == null || base !== "ink" || !u.data[0].length) return col;
  const { left, width } = u.bbox;
  const f = (u.valToPos(st, "x", true) - left) / width;
  if (!(f > 0)) return col;
  if (f >= 1) return C.ink3;
  const g = u.ctx.createLinearGradient(left, 0, left + width, 0);
  g.addColorStop(0, C.ink3); g.addColorStop(f, C.ink3); g.addColorStop(f, col); g.addColorStop(1, col);
  return g;
}
function drawOverlay(u, chart) {
  const ctx = u.ctx, px = uPlot.pxRatio, { left, top, width, height } = u.bbox;
  ctx.save();
  if (S.trialStarted != null) {
    const x = Math.round(u.valToPos(S.trialStarted, "x", true)) + 0.5;
    if (x >= left && x <= left + width) {
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
  }
  if (chart.labels && u.data[0].length) {
    ctx.font = `500 ${12 * px}px "Plex Cond", "Arial Narrow", sans-serif`;
    // Text on a small plate of the well colour, so it never sits on a line.
    const label = (text, x, y, align, base, color) => {
      const w = ctx.measureText(text).width, h = 14 * px, pad = 3 * px;
      const x0 = align === "right" ? x - w : x, y0 = base === "top" ? y : y - h;
      ctx.fillStyle = C.well;
      ctx.fillRect(x0 - pad, y0, w + 2 * pad, h);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = base;
      ctx.fillText(text, x, base === "top" ? y + px : y - px);
    };
    const { min, max } = u.scales.y;
    const step = max - min > 400 ? 50 : max - min > 40 ? 10 : 1;
    const r = (v) => fmt(Math.max(0, Math.round(v / step) * step)); // MHz never goes below 0
    const sp = u.data[2];
    const v = sp ? sp[sp.length - 1] : null;
    const y = v == null ? null : u.valToPos(v, "y", true);
    const above = y != null && y - top > 18 * px;
    // The setpoint label at the top already names the top of the scale: skip the max label then.
    if (y == null || (above ? y - 16 * px : y) - top > 16 * px) label(r(max), left + 5 * px, top + 3 * px, "left", "top", C.ink3);
    label(r(min), left + 5 * px, top + height - 3 * px, "left", "bottom", C.ink3);
    if (v != null) label(`${chart.capWord} ${fmt(v)}`, left + width - 5 * px, above ? y - 2 * px : y + 2 * px, "right", above ? "bottom" : "top", knobInTrial(chart.knob) ? C.amberText : C.ink3);
  }
  ctx.restore();
}
function makeChart(el, series, { unit = "", digits = 0, pad = 0.15, labels = false, knob = null, capWord = "cap" } = {}) {
  const tip = document.createElement("span");
  tip.className = "tip";
  el.append(tip);
  const chart = { keys: series.map((s) => s.key), el, labels, knob, capWord };
  const opts = {
    width: el.clientWidth || 300, height: el.clientHeight || 60,
    legend: { show: false },
    cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
    axes: [{ show: false }, { show: false }],
    scales: {
      x: { time: true },
      y: { range: (u, lo, hi) => {
        if (lo == null || hi == null) return [0, 1];
        // Labelled MHz traces: at least a 15 % span, so ±10 MHz of jitter does not fill the well.
        const span = Math.max(hi - lo, Math.abs(hi) * (labels ? 0.15 : 0.05), 1);
        return [lo - span * pad, hi + span * pad];
      } },
    },
    series: [{}, ...series.map((s) => ({
      stroke: s.setpoint ? () => (knobInTrial(knob) ? C.amber : C.ink3) : (u) => readStroke(u, s.color || "ink"),
      width: s.setpoint ? 1 : 1.5,
      dash: s.setpoint ? [4, 4] : undefined,
      paths: s.setpoint ? uPlot.paths.stepped({ align: 1 }) : undefined,
      spanGaps: false,
      points: { show: false },
    }))],
    hooks: {
      setCursor: [(u) => {
        const i = u.cursor.idx;
        if (i == null) { tip.textContent = ""; return; }
        const ago = Math.round(u.data[0][u.data[0].length - 1] - u.data[0][i]);
        tip.textContent = `${ago ? `−${ago} s · ` : "now · "}${fmt(u.data[1][i], digits)}${unit}`;
      }],
      draw: [(u) => drawOverlay(u, chart)],
    },
  };
  chart.u = new uPlot(opts, [[], ...series.map(() => [])], el);
  new ResizeObserver(() => chart.u.setSize({ width: el.clientWidth, height: el.clientHeight })).observe(el);
  charts.push(chart);
  return chart;
}
function redrawCharts() {
  for (const c of charts) c.u.setData(windowData(c.keys));
}
const WIN_TEXT = { 120: "last 2 min", 600: "last 10 min", 3600: "last hour" };
function labelTraces() {
  for (const c of charts) {
    if (!c.labels) continue;
    const vals = (windowData([c.keys[0]])[1] || []).filter((v) => v != null);
    const range = vals.length ? `, ${fmt(Math.min(...vals))} to ${fmt(Math.max(...vals))} MHz` : "";
    c.el.setAttribute("aria-label", `${c.name}, ${WIN_TEXT[S.window]}${range}`);
  }
}

/* --- network ------------------------------------------------------------------------------------------------------------ */
const BUSY = { apply: ["#apply", "Applying…"], keep: ["#keep", "Keeping…"], "keep-boot": ["#keep-boot", "Keeping…"], revert: ["#revert", "Reverting…"] };
async function post(path, body = {}, action = path) {
  S.busy = action;
  S.busyLabel = false;
  S.error = "";
  setTimeout(() => { if (S.busy === action) { S.busyLabel = true; renderCommit(); } }, 150);
  renderCommit();
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Spark-Console": "1" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    // server: the console server answered with its own error (a proxy 502 or a fetch failure has none).
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, server: !!data.error });
    if (data.control) S.control = data.control;
    if (data.profiles) S.profiles = data.profiles;
    return data;
  } catch (e) {
    S.error = errorText(e, action);
    S.errorNet = !e.server;
    S.errorAction = action;
    throw e;
  } finally {
    S.busy = null;
    S.busyLabel = false;
    render(false);
  }
}

/* One link state drives the header word, the dot and the dimming of every live reading. It is written only
   on a change, so the polite status region speaks once. Age is time since the last message on this clock,
   so a phone with a skewed clock is not "stale" for ever. */
let linkOpen = null;
const LINK_TEXT = { connecting: "Connecting…", live: "Live · 1 s", stale: "Stale data", lost: "Reconnecting…" };
function setLink() {
  const st = linkState({ open: linkOpen, age: S.gotAt ? (Date.now() - S.gotAt) / 1000 : null });
  if (st === S.link) return;
  S.link = st;
  document.documentElement.dataset.link = st;
  $("#link").dataset.state = st;
  $("#link-text").textContent = LINK_TEXT[st];
  render(false);
}
function connect() {
  const es = new EventSource("api/stream");
  es.onopen = () => {
    linkOpen = true;
    // A request that got no answer is stale news once the server is back: show the trial outcome instead.
    if (S.errorNet) { S.error = ""; S.errorNet = false; }
    setLink();
  };
  es.onerror = () => {
    linkOpen = false;
    setLink();
    // After a non-200 answer (a 502 from tailscale serve while the server restarts) the browser gives up.
    // shortcut: fixed 3 s retry, add backoff if many tabs hammer a down server
    if (es.readyState === EventSource.CLOSED) { es.close(); setTimeout(connect, 3000); }
  };
  es.onmessage = (ev) => {
    const st = JSON.parse(ev.data);
    if (st.snapshot?.series) pushHistory(st.snapshot.t, st.snapshot.series);
    ingest(st);
    setLink();
  };
}

function ingest(st) {
  // Simulate mode only: a handle for scripts/ui_smoke.mjs to feed synthetic decode samples.
  if (st.control?.simulate && !window.__sc) window.__sc = { H, S, render };
  S.snap = st.snapshot;
  S.gotAt = Date.now();
  S.control = st.control;
  S.profiles = st.profiles;
  // Drop staged values that the machine now has anyway.
  for (const [k, v] of Object.entries(S.staged)) if (S.control?.current?.[k] === v) delete S.staged[k];
  if (!Object.keys(S.staged).length) S.stagedProfile = null;
  render(true);
}

/* --- staging ------------------------------------------------------------------------------------------------------------- */
function stage(knob, value) {
  if (S.control?.current?.[knob] === value) delete S.staged[knob];
  else S.staged[knob] = value;
  S.stagedProfile = null;
  S.error = "";
  S.clamp = null;
  render(false);
}
const effective = (knob) => (knob in S.staged ? S.staged[knob] : S.control?.current?.[knob]);

/* --- trial life cycle: start (arm, baseline), each tick (evidence), end (outcome) ---------------------------------------- */
function trackTrial() {
  const t = S.control?.trial;
  const key = t ? `${JSON.stringify(t.applied)}|${t.total_s}` : null;
  if (key && key !== S.trialKey) {
    S.trialKey = key;
    S.trialStarted = trialStart(S.snap, t);
    S.armedAt = performance.now() + 600;
    S.warned = t.remaining_s <= 20;
    S.lastRemaining = null;
    S.outcome = null;
    setTimeout(() => renderCommit(), 620);
  } else if (!key && S.trialKey) {
    S.trialKey = null;
    S.trialStarted = null;
    S.outcome = { ...trialOutcome(S.control?.events || []), until: Date.now() + 4000, evidence: S.lastEvidence };
    announce(outcomeText(true));
    // Ended by the timeout or elsewhere: the Keep/Revert row is about to hide, so do not lose focus with it.
    if ($("#commit-trial").contains(document.activeElement)) queueMicrotask(() => $("#commit-text").focus({ preventScroll: true }));
    setTimeout(() => render(false), 4050);
  }
  const now = H.t[H.t.length - 1];
  S.ev = S.trialStarted != null && now != null ? Object.fromEntries(RAIL.map((r) => [r.key, trialDelta(H, r.key, S.trialStarted, now, S.scale)])) : null;
  if (S.ev) S.lastEvidence = S.ev;
}
function evidenceWords(ev) {
  if (!ev) return "";
  const w = ev["gpu.power_w"], tok = ev["llm.tok_s"];
  const parts = [];
  if (w?.state === "ok") parts.push(w.verdict === "within noise" ? "power within noise" : `${signed(w.d, 1)} W`);
  if (tok?.state === "ok") parts.push(tok.verdict === "within noise" ? "decode within noise" : `decode ${signed(tok.pct, 0)} %`);
  return parts.join(", ");
}
/* The outcome after the chip word ("Kept" / "Reverted"), so the bar does not repeat it. sentence: the
   full text with the chip word, for the announcement. */
function outcomeText(sentence = false) {
  const o = S.outcome;
  if (!o) return "";
  const e = o.ev, vals = changeList(e?.values || {});
  let text;
  if (o.kind === "kept") text = o.boot === "saved" ? `and saved for boot: ${vals}` : o.boot === "failed" ? `until reboot; saving for boot failed: ${vals}` : `until reboot: ${vals}`;
  else if (e?.kind === "trial_dropped_by_reboot") text = `${revertReason(e)}, the boot values apply`;
  else text = [revertReason(e), e?.values && `back to ${vals}`].filter(Boolean).join(", ");
  const words = evidenceWords(o.evidence);
  if (!sentence) return words ? `${text} · trial: ${words}` : text;
  return `${o.kind === "kept" ? "Kept" : "Reverted"} ${text}.${words ? ` Trial: ${words}.` : ""}`;
}
/* The bar's evidence: the only place that counts the measuring seconds. Verdict dots and words match the rail
   and the phone pill: "● −13.4 W · ● decode −30 %", "power ≈ same". */
function evidenceCompact(ev) {
  if (!ev) return "";
  const w = ev["gpu.power_w"], tok = ev["llm.tok_s"];
  if (w?.state === "measuring") return `<span class="noise">measuring…${w.wait ? ` ${w.wait} s` : ""}</span>`;
  const dot = (d) => (d.verdict === "better" || d.verdict === "worse" ? `<span class="vdot" data-v="${d.verdict}"></span><span class="sr-only">${d.verdict}: </span>` : "");
  const out = [];
  if (w?.state === "ok") out.push(w.verdict === "within noise" ? '<span class="noise">power ≈ same</span>' : `${dot(w)}${signed(w.d, 1)} W`);
  if (tok?.state === "ok") out.push(tok.verdict === "within noise" ? '<span class="noise">decode ≈ same</span>' : `${dot(tok)}decode ${signed(tok.pct, 0)} %`);
  else if (tok?.state === "no-decode") out.push('<span class="noise">no decode</span>');
  return out.join(" · ");
}

/* --- render: header, commit bar ------------------------------------------------------------------------------------------ */
function renderLinks() {
  const h = location.hostname;
  const local = h === "127.0.0.1" || h === "localhost";
  for (const a of $$(".to-sparkdash")) a.href = local ? "http://127.0.0.1:5555/" : `https://${h}:8443/`;
  for (const a of $$(".to-dgx")) a.href = local ? "http://127.0.0.1:11000/" : `https://${h}/`;
  $("#host").textContent = local ? "this host" : h.split(".")[0];
}
function renderAnnun() {
  const c = S.control, a = $("#annun"), note = $("#mode-note");
  if (!c) return;
  const kind = c.simulate ? "sim" : !c.helper_installed ? "ro" : "";
  a.hidden = !kind;
  if (a.dataset.kind === kind) return;
  a.dataset.kind = kind;
  $("#annun-text").textContent = kind === "sim" ? "Sim" : "Read-only";
  note.innerHTML = kind === "sim" ? "Simulation: controls change an in-memory copy, not the hardware."
    : "Read-only: the root helper is not installed. Run <code>sudo deploy/install.sh</code> in the repo on this machine to enable the controls.";
  if (kind === "ro") $("#apply").setAttribute("aria-describedby", "mode-note");
  else $("#apply").removeAttribute("aria-describedby");
}

function commitMode() {
  if (S.control?.trial) return "trial";
  if (S.error) return "failed";
  if (Object.keys(S.staged).length) return "staged";
  if (S.outcome && Date.now() < S.outcome.until) return "outcome";
  return "idle";
}
const isDis = (b) => b.getAttribute("aria-disabled") === "true";
const setDis = (b, v) => b.setAttribute("aria-disabled", String(!!v));
const trialArmed = () => performance.now() >= S.armedAt;

function renderCommit() {
  const bar = $("#commit"), c = S.control || {}, t = c.trial;
  const nStaged = Object.keys(S.staged).length;
  const mode = commitMode();
  // Apply: the change chips slide from where they were staged (FLIP, the one layout read per mode change).
  const flip = bar.dataset.mode === "staged" && mode === "trial" && !reduced.matches ? $("#commit-text").getBoundingClientRect().left : null;
  bar.dataset.mode = mode;
  bar.toggleAttribute("data-urgent", !!t && t.remaining_s <= 10);
  bar.toggleAttribute("data-arming", !!t && !trialArmed());
  const ro = c.helper_installed === false;
  bar.toggleAttribute("data-ro", ro);
  const title = t ? `${mmss(t.remaining_s)} trial · spark-console` : "spark-console";
  if (document.title !== title) document.title = title; // a background tab still shows the trial
  if (S.busyLabel) bar.setAttribute("aria-busy", "true"); else bar.removeAttribute("aria-busy");
  setText($("#staged-count"), `${nStaged} staged`);
  const outOn = S.outcome && Date.now() < S.outcome.until;
  const chip = $("#chip-out");
  chip.hidden = !(mode === "failed" || (outOn && (mode === "outcome" || mode === "staged")));
  if (mode === "failed") { chip.dataset.kind = "failed"; setText(chip, "Failed"); }
  else if (outOn) { chip.dataset.kind = S.outcome.kind; setText(chip, S.outcome.kind === "kept" ? "Kept" : "Reverted"); }

  let html = "", ev = "";
  if (t) {
    html = t.revert_error ? `<span>Revert failed, retrying · ${esc(t.revert_error)}</span>`
      : Object.keys(t.applied).map((k) => chgHTML(k, t.prev[k], t.applied[k])).join("");
    ev = t.revert_error ? "" : evidenceCompact(S.ev);
    setText($("#countdown"), mmss(t.remaining_s));
    if (t.remaining_s <= 20 && !S.warned) {
      S.warned = true;
      announce(`20 seconds left in the trial. Press ${S.keys ? "K or " : ""}Keep to keep these values.`);
    }
    if (S.lastRemaining !== t.remaining_s) {
      S.lastRemaining = t.remaining_s;
      const f = (r) => `scaleX(${Math.max(0, r) / (t.total_s || 1)})`;
      glide($("#drain"), "transform", f(t.remaining_s), f(t.remaining_s - 1));
    }
  } else if (nStaged) {
    html = (S.stagedProfile ? `<span class="chg-prefix">Profile ${esc(S.stagedProfile)} staged ·</span>` : "")
      + Object.entries(S.staged).map(([k, v]) => chgHTML(k, c.current?.[k], v)).join("");
  } else if (mode === "outcome") {
    html = esc(outcomeText());
  } else if (mode === "failed" && S.errorAction === "apply") {
    html = "Nothing changed.";
  } else if (ro) {
    html = "Read-only: the root helper is not installed, so the controls are off. Run <code>sudo deploy/install.sh</code> in the repo on this machine, then reload.";
  } else {
    const last = (c.events || []).at(-1);
    html = esc(last ? `${eventText(last)} · ${clock(last.t)}` : "No changes staged. Use the channels, the CPU policy or a profile.");
  }
  setHTML($("#commit-text"), html);
  setHTML($("#commit-ev"), ev);
  // The verdict lands once, when the bar stops counting.
  const phase = !ev ? "" : S.ev?.["gpu.power_w"]?.state === "measuring" ? "wait" : "ok";
  if (S.evPhase === "wait" && phase === "ok") crossfade($("#commit-ev"));
  S.evPhase = phase;
  // Keep stays enabled with no live data: a POST may still get through, and a blocked Keep could lose a change.
  const second = $("#commit-second");
  const lines = [t && (S.link === "lost" || S.link === "stale") && "No live data, so the countdown here is stopped. The server still reverts this trial on time unless Keep gets through.",
    t && nStaged && `<b>${nStaged} staged</b> · apply after this trial ends`].filter(Boolean);
  second.hidden = !lines.length;
  setHTML(second, lines.join("<br>"));

  $("#commit-trial").hidden = !t;
  $("#commit-staged").hidden = !!t || !nStaged;
  const armed = trialArmed();
  setDis($("#apply"), S.busy || !c.helper_installed || !nStaged || !!t);
  setDis($("#discard"), S.busy);
  setDis($("#keep"), !armed || S.busy || !!t?.revert_error);
  setDis($("#keep-boot"), !armed || S.busy || !!t?.revert_error);
  setDis($("#revert"), !armed || S.busy);
  for (const [action, [sel, busyText]] of Object.entries(BUSY)) {
    const b = $(sel);
    // Measure once, when the button is first visible (hidden ones would force a layout on every tick).
    if (!b.style.minWidth && !b.closest("[hidden]") && b.offsetWidth) b.style.minWidth = `${b.offsetWidth}px`;
    const lab = $("[data-label]", b);
    lab.dataset.idle ??= lab.textContent;
    setText(lab, S.busyLabel && S.busy === action ? busyText : lab.dataset.idle);
  }
  $("#reapply-boot").disabled = !!S.busy || !!t || !c.helper_installed;
  if (flip != null) {
    const dx = flip - $("#commit-text").getBoundingClientRect().left;
    if (dx) $("#commit-text").animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
  const err = $("#commit-error");
  err.hidden = !S.error;
  setText(err, S.error);
}

function eventText(e) {
  switch (e.kind) {
    case "applied": return `Trial started: ${changeList(e.applied)}`;
    case "reverted": { const why = revertReason(e); return `Reverted${why ? ` (${why})` : ""}: ${changeList(e.values)}`; }
    case "kept": return `Kept${e.persist ? " after reboot" : " until reboot"}: ${changeList(e.values)}`;
    case "persisted": return `Saved for boot: ${[e.gpu && "GPU", e.cpu && "CPU"].filter(Boolean).join(" + ")}`;
    case "failed": return `Failed: ${e.error}`;
    case "trial_dropped_by_reboot": return `Trial ended by a reboot; boot values apply: ${changeList(e.values)}`;
    case "boot_reapplied": return "Boot values re-applied (nv-cpu-governor, gb10-clocklock and cpu-epp restarted)";
    case "persist_failed": return `Kept, but saving for boot failed: ${e.error}`;
    case "revert_failed": return `Revert failed: ${e.error}`;
    case "rollback_failed": return `Rollback of ${LABEL[e.knob] || e.knob} failed: ${e.error}`;
    default: return e.kind;
  }
}

/* --- render: channels ----------------------------------------------------------------------------------------------------------- */
/* [reason, short visible label, level, full name for screen readers] */
const LAMPS_GPU = [
  ["sw_power_cap", "Pwr cap", "serious", "Power cap"], ["sw_thermal_slowdown", "SW therm", "serious", "Software thermal slowdown"],
  ["hw_thermal_slowdown", "HW therm", "crit", "Hardware thermal slowdown"], ["hw_slowdown", "HW slow", "crit", "Hardware slowdown"],
  ["hw_power_brake_slowdown", "Pwr brake", "crit", "Power brake slowdown"], ["gpu_idle", "Idle", "info", "Idle"],
];
function renderLamps(ul, list) {
  if (ul.children.length !== list.length) {
    ul.innerHTML = list.map(() => '<li class="lamp" data-on=""><span data-l aria-hidden="true"></span><span class="sr-only" data-s></span></li>').join("");
  }
  list.forEach(([on, label, level, full], i) => {
    const li = ul.children[i];
    const v = on ? level : "";
    if (li.dataset.on !== v) li.dataset.on = v;
    setText($("[data-l]", li), label);
    setText($("[data-s]", li), `${full || label}, ${on ? "active" : "off"}`);
  });
  ul.dataset.none = list.every(([on]) => !on) ? "1" : "0";
}

function renderChannel(id, knob, read, sub, range, lamps) {
  const el = $(id), c = S.control || {}, t = c.trial;
  const cur = c.current?.[knob], eff = effective(knob), pending = knob in S.staged;
  const inTrial = !!(t && knob in t.applied);
  const isGpu = knob === "gpu_cap_mhz", ro = c.helper_installed === false;
  el.dataset.pending = pending ? "1" : "0";
  el.dataset.trial = inTrial && !pending ? "1" : "0";
  $("[data-trialchip]", el).hidden = !inTrial;
  const set = $("[data-set]", el);
  set.dataset.amber = pending || inTrial ? "1" : "0";
  setHTML(set, pending
    ? `<span class="sr-only">staged </span>${esc(knobText(knob, eff))}<span class="was"><span class="sr-only">, was </span>${esc(knobText(knob, cur))}</span>`
    : inTrial
      ? `<span class="sr-only">in trial </span>${esc(knobText(knob, cur))}<span class="was"><span class="sr-only">, was </span>${esc(knobText(knob, t.prev[knob]))}</span>`
      : esc(knobText(knob, cur)));
  const boot = c.persisted?.[knob];
  // A running value that boot does not set: quiet ink and words, no amber (amber is staged or trial).
  const volatile = !pending && !inTrial && notSaved(knob, cur, c.persisted, c.limits);
  el.dataset.volatile = volatile ? "1" : "0";
  // Without a spark-console drop-in the CPU max is the hardware max at boot.
  setText($("[data-boot]", el), `${knob in (c.persisted || {}) ? `Boot ${knobText(knob, boot)}` : isGpu ? "Boot no cap" : "Boot full range"}${volatile ? " · not saved for boot" : ""}`);
  const rv = $("[data-read]", el);
  setText(rv, fmt(read));
  rv.dataset.empty = read == null ? "1" : "0";
  setText($("[data-sub]", el), sub);
  const input = $("[data-input]", el);
  const mhz = eff == null ? null : isGpu ? eff : Math.round(eff / 1000);
  if (document.activeElement !== input) input.value = mhz ?? "";
  input.min = range[0];
  input.max = range[1];
  input.disabled = (isGpu && eff == null) || ro;
  // aria-disabled, not disabled: a stepper at its limit keeps focus.
  for (const b of el.querySelectorAll("[data-step]")) {
    const d = Number(b.dataset.step);
    setDis(b, ro || mhz == null || (d < 0 ? mhz <= range[0] : mhz >= range[1]));
  }
  setText($("[data-limit]", el), mhz == null ? "" : mhz >= range[1] ? `At max ${fmt(range[1])} MHz` : mhz <= range[0] ? `At min ${fmt(range[0])} MHz` : "");
  setText($("[data-clamp]", el), S.clamp?.id === id ? S.clamp.text : "");
  const nocap = $("[data-nocap]", el);
  if (nocap) { nocap.checked = eff == null; nocap.disabled = ro; }
  renderLamps($("[data-lamps]", el), lamps);
}

function bindChannel(id, knob, rangeOf) {
  const el = $(id), isGpu = knob === "gpu_cap_mhz";
  const toValue = (mhz) => (isGpu ? mhz : mhz * 1000);
  const input = $("[data-input]", el);
  const clampStage = (mhz, note) => {
    const [lo, hi] = rangeOf();
    if (!Number.isFinite(mhz)) return;
    const want = Math.round(mhz), v = Math.min(hi, Math.max(lo, want));
    stage(knob, toValue(v));
    if (note && v !== want) {
      S.clamp = { id, text: `${v === hi ? "Max" : "Min"} is ${fmt(v)} MHz. Set to ${fmt(v)}.` };
      announce(S.clamp.text);
      render(false);
    }
  };
  const stepBy = (delta) => {
    const eff = effective(knob);
    if (eff == null) return;
    const mhz = isGpu ? eff : eff / 1000;
    // Snap to the 100 MHz grid first, then step.
    clampStage(delta > 0 ? Math.floor(mhz / 100) * 100 + delta : Math.ceil(mhz / 100) * 100 + delta, false);
  };
  for (const b of el.querySelectorAll("[data-step]")) {
    const d = Number(b.dataset.step) * 100;
    let t1, t2;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    const once = () => (isDis(b) ? stop() : stepBy(d));
    // Press and hold repeats: first repeat at 400 ms, then every 80 ms.
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || isDis(b)) return;
      once();
      t1 = setTimeout(() => { t2 = setInterval(once, 80); }, 400);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stop);
    b.addEventListener("click", (e) => { if (e.detail === 0) once(); }); // keyboard and programmatic clicks
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      stepBy((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 500 : 100));
      const eff = effective(knob);
      input.value = eff == null ? "" : isGpu ? eff : Math.round(eff / 1000);
    } else if (e.key === "Enter") clampStage(Number(input.value), true);
  });
  input.addEventListener("change", (e) => clampStage(Number(e.target.value), true));
  const nocap = $("[data-nocap]", el);
  if (nocap) nocap.addEventListener("change", (e) => {
    const persisted = S.control?.persisted?.gpu_cap_mhz;
    stage(knob, e.target.checked ? null : (S.control?.current?.gpu_cap_mhz ?? persisted ?? 2100));
  });
}

/* --- render: policy, profiles ------------------------------------------------------------------------------------------------------- */
const EPP_STOPS = [[0, "Perf"], [64, ""], [128, "Balanced"], [192, ""], [255, "Power"]];
function buildPolicy() {
  $("#epp-stops").innerHTML = EPP_STOPS.map(([v, l]) =>
    `<button type="button" data-epp="${v}" aria-pressed="false">${v}${l ? ` <small>${l}</small>` : ""}<span class="sr-only" data-sr></span></button>`).join("");
}
function renderPolicy() {
  const c = S.control, snap = S.snap;
  if (!c || !snap) return;
  const cur = c.current, t = c.trial, effEpp = effective("epp"), effGov = effective("governor"), ro = c.helper_installed === false;
  const eppStaged = "epp" in S.staged, govStaged = "governor" in S.staged;
  const eppTrial = !!(t && "epp" in t.applied), govTrial = !!(t && "governor" in t.applied);
  const pol = $("#policy");
  pol.dataset.pending = eppStaged || govStaged ? "1" : "0";
  pol.dataset.trial = (eppTrial || govTrial) && !(eppStaged || govStaged) ? "1" : "0";
  for (const b of $$("#epp-stops [data-epp]")) {
    const v = Number(b.dataset.epp);
    const isCur = cur.epp === v, isStaged = eppStaged && effEpp === v, isTrial = !eppStaged && eppTrial && cur.epp === v;
    b.setAttribute("aria-pressed", String(isCur));
    b.classList.toggle("is-amber", isStaged || isTrial);
    setDis(b, ro);
    setText($("[data-sr]", b), isStaged ? ", staged" : isTrial ? ", in trial" : isCur ? ", current" : "");
  }
  const epp = $("#epp");
  if (document.activeElement !== epp) epp.value = effEpp;
  epp.dataset.pending = eppStaged ? "1" : "0";
  epp.disabled = ro;
  const bootTag = (el, text, knob, staged, inTrial) => {
    const v = !staged && !inTrial && notSaved(knob, cur[knob], c.persisted, c.limits);
    el.dataset.volatile = v ? "1" : "0";
    setText(el, text && `${text}${v ? " · not saved for boot" : ""}`);
  };
  bootTag($("#epp-boot"), c.persisted?.epp != null ? `Boot ${c.persisted.epp}` : "", "epp", eppStaged, eppTrial);
  setText($("#epp-now"), eppStaged ? `now ${cur.epp}` : eppTrial ? `was ${t.prev.epp}` : "");
  const gov = $("#governor");
  const opts = snap.cpu.governors.join(",");
  if (gov.dataset.opts !== opts) {
    gov.innerHTML = snap.cpu.governors.map((g) => `<option>${esc(g)}</option>`).join("");
    gov.dataset.opts = opts;
  }
  if (document.activeElement !== gov) gov.value = effGov;
  gov.dataset.pending = govStaged ? "1" : "0";
  gov.disabled = ro;
  bootTag($("#gov-boot"), `Boot ${c.persisted?.governor || "nv-cpu-governor"}`, "governor", govStaged, govTrial);
  setText($("#gov-now"), govStaged ? `now ${cur.governor}` : govTrial ? `was ${t.prev.governor}` : "");
}

const profileVals = (p) => Object.entries(p.values).map(([k, v]) => `${k === "gpu_cap_mhz" ? "GPU" : LABEL[k]} ${knobShort(k, v)}`).join(" · ");
function renderProfiles() {
  const list = $("#profiles");
  const key = JSON.stringify(S.profiles);
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = S.profiles.map((p, i) => {
      const note = p.note || "";
      const short = note && note.length < 40;
      return `<div class="pf" data-i="${i}"><button type="button" class="pf-btn" data-profile="${i}"${note && !short ? ` aria-describedby="pf-note-${i}"` : ""}>
        <span class="pf-name">${esc(p.name)}</span><span class="pf-vals">${esc(profileVals(p))}</span>${short ? `<span class="pf-note">${esc(note)}</span>` : ""}<span class="sr-only" data-sr></span></button>${
        note && !short ? `<span class="sr-only" id="pf-note-${i}">${esc(note)}</span>` : ""}${
        p.builtin ? "" : `<button type="button" class="pf-del" data-del="${i}" aria-label="Delete profile ${esc(p.name)}">×</button>`}</div>`;
    }).join("");
  }
  const cur = S.control?.current || {};
  const anyStaged = Object.keys(S.staged).length > 0;
  S.profiles.forEach((p, i) => {
    const pf = list.children[i];
    if (!pf) return;
    const vals = Object.entries(p.values);
    const isCur = vals.every(([k, v]) => cur[k] === v);
    const isStaged = anyStaged && vals.every(([k, v]) => effective(k) === v) && vals.some(([k]) => k in S.staged);
    const btn = $(".pf-btn", pf);
    setDis(btn, S.control?.helper_installed === false);
    if (isCur) btn.setAttribute("aria-current", "true"); else btn.removeAttribute("aria-current");
    pf.dataset.staged = isStaged ? "1" : "0";
    setText($("[data-sr]", btn), isStaged ? ", staged" : isCur ? ", current" : "");
  });
}

/* --- render: effect rail ------------------------------------------------------------------------------------------------------------ */
const RAIL = [
  { key: "gpu.power_w", label: "GPU power", unit: "W", word: "watts", d: 1, val: (s) => s.gpu?.power_w, meta: () => `measured · ${statMeta("gpu.power_w", 1, "W")}` },
  { key: "llm.tok_s", label: "Decode", unit: "tok/s", word: "tokens per second", d: 1, val: (s) => s.llm?.tok_s, meta: (s) => (s.llm?.endpoints || []).filter((e) => e.ok).map((e) => e.model || e.engine).join(", ") || "no LLM server answering" },
  { key: "llm.j_per_tok", label: "Energy", unit: "J/tok", word: "joules per token", d: 2, val: (s) => s.llm?.j_per_tok, meta: () => "GPU W ÷ tok/s (GPU only)" },
  { key: "gpu.tlimit_c", label: "GPU headroom", unit: "°C", word: "degrees", d: 0, val: (s) => s.gpu?.tlimit_c, meta: (s) => `GPU ${fmt(s.gpu?.temp_c)} °C · min ${fmt(S.snap?.stats?.["gpu.tlimit_c"]?.min)} °C` },
  { key: "gpu.util", label: "GPU busy", unit: "%", word: "percent", d: 0, val: (s) => s.gpu?.util, meta: (s) => `${s.gpu?.pstate ?? ""} · SM ${fmt(s.gpu?.sm_mhz)} MHz` },
  { key: "mem.avail_gib", label: "Memory free", unit: "GiB", word: "GiB", d: 1, val: (s) => s.mem?.avail_kib / 1048576, meta: (s) => `PSI ${fmt(s.mem?.psi?.some?.avg10, 1)} % · swap ${fmt(s.mem?.swap_used_kib / 1048576, 1)} GiB` },
];
function statMeta(key, d, unit) {
  const st = S.snap?.stats?.[key];
  return st ? `avg ${fmt(st.avg, d)} · max ${fmt(st.max, d)} ${unit}` : "";
}
function buildRail() {
  const rail = $("#rail");
  rail.innerHTML = RAIL.map((r, i) => `<div class="readout" data-i="${i}">
      <span class="silk">${esc(r.label)}</span>
      <span class="r-val"><span data-v>—</span><small>${esc(r.unit)}</small></span>
      <span class="r-meta" data-m></span>
      <span class="r-delta" data-d hidden></span>
      <div class="spark" data-spark role="img" aria-label="${esc(r.label)} over the selected window"></div>
    </div>`).join("");
  RAIL.forEach((r, i) => makeChart($(`.readout[data-i="${i}"] [data-spark]`, rail), [{ key: r.key, color: "ink2" }], { unit: ` ${r.unit}`, digits: r.d }));
}
function deltaLine(r, d) {
  if (!d) return null;
  if (d.state === "measuring") return { v: "wait", html: "measuring" }; // the bar holds the one count
  if (d.state === "no-decode") return { v: "wait", html: "no decode traffic" };
  if (d.state === "below-min") return { v: "wait", html: `no class: decode below ${fmt(d.min)} tok/s` };
  const pct = r.key === "llm.tok_s" && d.verdict !== "within noise" && d.pct != null ? ` (${signed(d.pct, 0)} %)` : "";
  const dot = d.verdict === "better" || d.verdict === "worse" ? `<span class="vdot" data-v="${d.verdict}"></span>` : "";
  const sr = `${r.label} ${fmt(Math.abs(d.d), r.d)} ${r.word} ${d.d < 0 ? "lower" : "higher"} than before the trial, ${d.verdict}.`;
  return {
    v: d.verdict === "within noise" ? "noise" : d.verdict,
    html: `<span aria-hidden="true">${signed(d.d, r.d)} ${esc(r.unit)}${pct} ·</span>${dot}<span aria-hidden="true">${d.verdict}</span><span class="sr-only">${esc(sr)}</span>`,
  };
}
function renderRail() {
  const s = S.snap;
  RAIL.forEach((r, i) => {
    const el = $(`.readout[data-i="${i}"]`), v = r.val(s), vEl = $("[data-v]", el);
    setText(vEl, fmt(v, r.d));
    vEl.dataset.empty = v == null || Number.isNaN(v) ? "1" : "0";
    const line = S.ev ? deltaLine(r, S.ev[r.key]) : null;
    const m = $("[data-m]", el), dl = $("[data-d]", el);
    m.hidden = !!line;
    dl.hidden = !line;
    if (line) {
      if (dl.dataset.v === "wait" && line.v !== "wait") queueMicrotask(() => crossfade(dl));
      dl.dataset.v = line.v;
      setHTML(dl, line.html);
    } else setText(m, r.meta(s));
  });
}

/* --- render: details (rows patched in place) ------------------------------------------------------------------------------------------ */
/* rows: arrays of cells; a cell is text or { t, cls, pad, title }. */
function patchRows(tbody, rows, cls = []) {
  while (tbody.rows.length > rows.length) tbody.deleteRow(-1);
  rows.forEach((r, i) => {
    const tr = tbody.rows[i] || tbody.insertRow();
    while (tr.cells.length > r.length) tr.deleteCell(-1);
    r.forEach((v, j) => {
      const td = tr.cells[j] || tr.insertCell();
      const o = v && typeof v === "object" ? v : { t: v };
      setText(td, o.t == null ? "" : String(o.t));
      const c = [cls[j], o.cls].filter(Boolean).join(" ");
      if (td.className !== c) td.className = c;
      if (o.colspan) td.colSpan = o.colspan; else if (td.colSpan !== 1) td.colSpan = 1;
      const pad = o.pad == null ? "" : `${o.pad}px`;
      if (td.style.paddingLeft !== pad) td.style.paddingLeft = pad;
      if (o.title != null) td.title = o.title; else if (td.title) td.removeAttribute("title");
      if (o.translate === false) td.setAttribute("translate", "no");
    });
  });
}
function setSum(id, text, alarm) {
  setHTML($(`${id} [data-sum]`), `${alarm ? `<span class="chip chip-alarm">${esc(alarm)}</span>` : ""}<span>${esc(text)}</span>`);
  setText($(`${id} [data-alarm]`), alarm ? `, ${alarm}` : "");
}
function renderCores(s) {
  const box = $("#cores");
  const key = s.cpu.cores.map((c) => `${c.cluster}:${c.cpu}`).join(",");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = ["x925", "a725"].map((k) => `<div class="cluster-row"><span class="meta">${k.toUpperCase()} · <span data-n="${k}"></span> cores</span><div class="cells">${
      s.cpu.cores.filter((c) => c.cluster === k).map((c) => `<div class="cell" data-cpu="${c.cpu}"><div class="fill"></div><span>cpu${c.cpu}</span><b></b></div>`).join("")}</div></div>`).join("");
  }
  for (const k of ["x925", "a725"]) { const n = $(`[data-n="${k}"]`, box); if (n) setText(n, String(s.cpu.clusters[k]?.cores ?? 0)); }
  for (const c of s.cpu.cores) {
    const cell = $(`.cell[data-cpu="${c.cpu}"]`, box);
    if (!cell) continue;
    cell.dataset.limited = c.perf_limited ? "1" : "0";
    $(".fill", cell).style.transform = `scaleY(${(c.util ?? 0) / 100})`;
    setText($("b", cell), fmt(c.mhz));
  }
}
function renderDetails() {
  const s = S.snap;
  const cl = s.cpu.clusters;
  setSum("#d-cores", ["x925", "a725"].filter((k) => cl[k]).map((k) => `${k.toUpperCase()} ${fmt(cl[k].mhz / 1000, 2)} GHz ${fmt(cl[k].util)} %`).join(" · "));
  if ($("#d-cores").open) renderCores(s);
  const m = s.mem, gib = (k) => fmt(k / 1048576, 1);
  setSum("#d-mem", `${gib(m.avail_kib)} of ${gib(m.total_kib)} GiB free`);
  if ($("#d-mem").open) {
    const p = m.psi || {};
    const kv = { avail: `${gib(m.avail_kib)} GiB`, total: `${gib(m.total_kib)} GiB`, cached: `${gib(m.cached_kib)} GiB`, swap: `${gib(m.swap_used_kib)} of ${gib(m.swap_total_kib)} GiB` };
    for (const [k, v] of Object.entries(kv)) setText($(`[data-mem="${k}"]`), v);
    patchRows($("#psi"), ["some", "full"].map((k) => [k === "some" ? "Some tasks stalled" : "All tasks stalled", fmt(p[k]?.avg10, 2), fmt(p[k]?.avg60, 2), fmt(p[k]?.avg300, 2)]), ["", "num", "num", "num"]);
  }
  const hot = [...s.sensors].sort((a, b) => b.temp_c - a.temp_c)[0];
  const head = s.gpu?.tlimit_c;
  setSum("#d-sensors", hot ? `hottest ${hot.name} ${fmt(hot.temp_c)} °C · ${s.sensors.length} sensors` : "", head != null && head < 10 ? "near limit" : "");
  if ($("#d-sensors").open) {
    setText($("#stats-since"), `min / max since ${clock(s.stats_since)}`);
    const rows = [{ name: "GPU", temp_c: s.gpu?.temp_c, key: "gpu.temp_c" }, ...s.sensors.map((x) => ({ ...x, key: `temp.${x.id}` }))];
    patchRows($("#sensors"), rows.map((x) => {
      const st = s.stats?.[x.key] || {};
      return [x.name, fmt(x.temp_c, 1), fmt(st.min, 1), fmt(st.max, 1), fmt(st.avg, 1)];
    }), ["", "num", "num", "num", "num"]);
  }
  const top = s.procs[0];
  setSum("#d-procs", top ? `top ${top.comm} ${fmt(top.cpu)} % · ${s.procs.length} shown` : "");
  if ($("#d-procs").open) renderProcs();
  const up = s.llm.endpoints.filter((e) => e.ok);
  setSum("#d-llm", `${up.length} of ${s.llm.endpoints.length} answering`, s.llm.endpoints.length && !up.length ? "0 answering" : "");
  if ($("#d-llm").open) {
    patchRows($("#llm"), s.llm.endpoints.map((e) => [{ t: e.url, translate: false }, e.engine || "—", e.ok ? e.model || "—" : "not answering", fmt(e.tok_s, 1), fmt(e.running)]), ["", "", "", "num", "num"]);
  }
  const sv = Object.entries(s.services || {});
  const bad = sv.filter(([, v]) => v.active !== "active" && v.active !== "running" && !(v.active === "inactive" && v.sub === "dead" && v.enabled === "enabled"));
  setSum("#d-services", sv.length ? (bad.length ? bad.map(([k]) => k).join(", ") : "all as expected") : "", bad.length ? "check" : "");
  if ($("#d-services").open) {
    patchRows($("#services"), sv.map(([k, v]) => [{ t: k, translate: false }, [v.active, v.sub].filter(Boolean).join(" / "), v.enabled || "—"]));
  }
  const ev = S.control?.events || [];
  setSum("#d-activity", ev.length ? eventText(ev.at(-1)) : "nothing yet");
  if ($("#d-activity").open) renderActivity(ev);
}
function renderActivity(ev) {
  const ol = $("#activity");
  const items = ev.length ? ev.slice().reverse() : [null];
  while (ol.children.length > items.length) ol.lastElementChild.remove();
  items.forEach((e, i) => {
    let li = ol.children[i];
    if (!li) { li = document.createElement("li"); li.innerHTML = "<time></time><span></span>"; ol.append(li); }
    const time = $("time", li);
    if (e) {
      const iso = new Date(e.t * 1000).toISOString();
      if (time.getAttribute("datetime") !== iso) time.setAttribute("datetime", iso);
      setText(time, clock(e.t));
    } else setText(time, "");
    setText($("span", li), e ? eventText(e) : "No control changes since the server started.");
  });
}
let procStatusT;
/* announce: the filter or the tree changed (a user action); the 1 Hz render never speaks */
function renderProcs(announce = false) {
  const q = $("#proc-filter").value.trim().toLowerCase();
  let rows = S.snap.procs.filter((p) => !q || p.comm.toLowerCase().includes(q) || String(p.pid).startsWith(q));
  const key = S.sort;
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  const depth = new Map();
  if ($("#proc-tree").checked) {
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const kids = new Map();
    for (const r of rows) {
      const parent = byPid.has(r.ppid) ? r.ppid : 0;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(r);
    }
    const out = [];
    const walk = (pid, d) => { for (const r of kids.get(pid) || []) { depth.set(r.pid, d); out.push(r); walk(r.pid, d + 1); } };
    walk(0, 0);
    rows = out;
  }
  const body = $("#procs");
  if (!rows.length) patchRows(body, [[{ t: `No process matches “${q}”.`, cls: "muted", colspan: 6 }]]);
  else patchRows(body, rows.slice(0, 200).map((p) => [p.pid,
    { t: `${depth.get(p.pid) ? "└ " : ""}${p.comm}`, cls: "name", pad: 8 + 14 * (depth.get(p.pid) || 0), title: p.comm, translate: false },
    fmt(p.cpu, 1), fmt(p.rss_mib), p.gpu_mib == null ? "" : fmt(p.gpu_mib), p.state]), ["num", "", "num", "num", "num", ""]);
  if (!announce) return;
  clearTimeout(procStatusT);
  procStatusT = setTimeout(() => setText($("#proc-status"), q ? `${rows.length} of ${S.snap.procs.length} processes match` : ""), 300);
}

/* --- energy class --------------------------------------------------------------------------------------------------------------------- */
let energy;
function energyView() {
  const t = S.control?.trial, now = H.t[H.t.length - 1] ?? 0;
  const v = { scale: S.scale, staged: Object.keys(S.staged).length > 0 && !t, tokNow: S.snap?.llm?.tok_s, trial: null, deltas: null };
  if (t && S.trialStarted != null) {
    const ct = classTrial(H, S.trialStarted, now, S.scale);
    v.trial = { remaining: t.remaining_s, total: t.total_s, key: S.trialKey };
    v.before = ct.before;
    v.now = ct.now;
    v.deltas = S.ev ? { j: S.ev["llm.j_per_tok"], tok: S.ev["llm.tok_s"], w: S.ev["gpu.power_w"] } : null;
    if (t.revert_error) v.state = "hold";
    else if (ct.state === "ok") v.state = ct.before ? "trial" : "ok";
    else if (ct.state === "below-min") v.state = "below";
    else if (!ct.before && now >= S.trialStarted + SETTLE_S) v.state = "idle";
    else v.state = "settling";
    v.honesty = v.deltas?.tok?.state === "ok" ? honesty(ct.before?.k, ct.now?.k, v.deltas.tok, v.state === "below" ? S.scale.min : null) : null;
  } else {
    const cn = classNow(H, now, S.scale);
    v.state = cn.state;
    v.now = cn.state === "ok" ? cn : null;
    v.warmN = cn.n;
    // After a trial, the tab keeps the decode change for the 4 s outcome window.
    if (S.outcome && Date.now() < S.outcome.until) v.deltas = { tok: S.outcome.evidence?.["llm.tok_s"] };
  }
  return v;
}

/* --- main render -------------------------------------------------------------------------------------------------------------------------- */
function render(tick = true) {
  if (!S.snap || !S.control) return;
  const s = S.snap, c = S.control, lim = c.limits || {};
  trackTrial();
  renderAnnun();
  renderCommit();
  const g = s.gpu || {};
  const reasons = new Set(g.reasons || []);
  renderChannel("#ch-gpu", "gpu_cap_mhz", g.sm_mhz,
    s.gpu ? `${fmt(g.util)} % busy · ${fmt(g.power_w, 1)} W · headroom ${fmt(g.tlimit_c)} °C` : s.gpu_error || "no GPU data",
    [300, 3100], LAMPS_GPU.map(([k, l, lvl, full]) => [reasons.has(k), l, lvl, full]));
  for (const k of ["x925", "a725"]) {
    const cl = s.cpu.clusters[k] || {};
    const r = lim[k] || [0, 0];
    renderChannel(`#ch-${k}`, `${k}_max_khz`, cl.mhz, `${fmt(cl.util)} % busy · ${cl.cores ?? 0} cores`,
      [Math.ceil(r[0] / 1000), Math.floor(r[1] / 1000)],
      [[cl.perf_limited > 0, cl.perf_limited > 0 ? `Perf limited · ${cl.perf_limited}` : "Perf limited", "serious", "Performance limited"]]);
  }
  renderPolicy();
  renderProfiles();
  renderRail();
  energy.render(energyView());
  if (tick) {
    renderDetails();
    redrawCharts();
    // Trace ranges move with the clocks; the labels only set attributes, so every 10 s is enough.
    if (!(S.labelledAt > Date.now() - 10000)) { S.labelledAt = Date.now(); labelTraces(); }
  }
}

/* --- actions (click and key run the same code) ------------------------------------------------------------------------------------------------ */
function doApply() {
  const b = $("#apply");
  if (isDis(b) || !Object.keys(S.staged).length) return;
  const changes = { ...S.staged };
  const trial_s = Number($("#trial-s").value);
  post("api/apply", { changes, trial_s }, "apply").then(() => {
    S.staged = {};
    S.stagedProfile = null;
    announce(`Trial started. It reverts in ${$("#trial-s").selectedOptions[0].text} unless you keep it.`);
    render(false);
    $("#keep").focus({ preventScroll: true });
  }).catch(() => { /* shown in the bar */ });
}
function doKeep(persist) {
  if (isDis($(persist ? "#keep-boot" : "#keep")) || !trialArmed()) return;
  post("api/keep", { persist }, persist ? "keep-boot" : "keep").then(() => $("#commit-text").focus({ preventScroll: true })).catch(() => {});
}
function doRevert() {
  if (isDis($("#revert")) || !trialArmed()) return;
  post("api/revert", {}, "revert").then(() => $("#commit-text").focus({ preventScroll: true })).catch(() => {});
}
function setKeys(on) {
  S.keys = on;
  store.set("sc-keys", on ? "on" : "off");
  document.documentElement.dataset.keys = on ? "on" : "off";
  $("#keys-switch").setAttribute("aria-pressed", String(on));
  for (const [sel, key] of [["#apply", "A"], ["#keep", "K"], ["#keep-boot", "B"], ["#revert", "R"], ["#ec-tab", "E"]]) {
    if (on) $(sel).setAttribute("aria-keyshortcuts", key); else $(sel).removeAttribute("aria-keyshortcuts");
  }
}
function onKey(e) {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  if ($("dialog[open]")) return;
  // Escape closes the drawer wherever focus is (a field keeps its own Escape only when the drawer is shut).
  if (e.key === "Escape") {
    if (energy.isOpen()) { e.preventDefault(); energy.close(); }
    return;
  }
  if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
  if (!S.keys) return;
  const k = e.key.toLowerCase();
  const act = { e: () => energy.toggle(), a: doApply, k: () => doKeep(false), b: () => doKeep(true), r: doRevert }[k];
  if (!act) return;
  e.preventDefault();
  act();
}

/* --- wiring ---------------------------------------------------------------------------------------------------------------------------------------- */
function bind() {
  bindChannel("#ch-gpu", "gpu_cap_mhz", () => [300, 3100]);
  for (const k of ["x925", "a725"]) {
    bindChannel(`#ch-${k}`, `${k}_max_khz`, () => {
      const r = S.control?.limits?.[k] || [0, 0];
      return [Math.ceil(r[0] / 1000), Math.floor(r[1] / 1000)];
    });
  }
  $("#epp-stops").addEventListener("click", (e) => {
    const b = e.target.closest("[data-epp]");
    if (b && !isDis(b)) stage("epp", Number(b.dataset.epp));
  });
  $("#epp").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (Number.isFinite(v)) stage("epp", Math.min(255, Math.max(0, v)));
  });
  $("#governor").addEventListener("change", (e) => stage("governor", e.target.value));
  $("#apply").addEventListener("click", doApply);
  $("#discard").addEventListener("click", () => {
    if (isDis($("#discard"))) return;
    S.staged = {}; S.stagedProfile = null; S.error = ""; S.clamp = null;
    render(false);
    $("#commit-text").focus({ preventScroll: true }); // Discard hides itself
  });
  $("#keep").addEventListener("click", () => doKeep(false));
  $("#keep-boot").addEventListener("click", () => doKeep(true));
  $("#revert").addEventListener("click", doRevert);
  $("#profiles").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const p = S.profiles[Number(del.dataset.del)];
      if (p && confirm(`Delete profile “${p.name}”?`)) post("api/profiles/delete", { name: p.name }, "profile").catch(() => {});
      return;
    }
    const b = e.target.closest("[data-profile]");
    if (!b || isDis(b)) return;
    // A profile replaces what is staged (no merge with leftovers).
    const p = S.profiles[Number(b.dataset.profile)], cur = S.control?.current || {};
    S.staged = {};
    for (const [k, v] of Object.entries(p.values)) if (cur[k] !== v) S.staged[k] = v;
    S.stagedProfile = Object.keys(S.staged).length ? p.name : null;
    S.error = "";
    S.clamp = null;
    render(false);
  });
  const dlg = $("#profile-dialog"), name = $("#profile-name");
  $("#save-profile").addEventListener("click", () => {
    const n = Object.keys(S.staged).length;
    $("#profile-hint").textContent = n ? `Saves: ${changeList(S.staged)}` : "Stage values with the controls first.";
    $("#profile-form [value=save]").disabled = !n;
    dlg.showModal();
  });
  name.addEventListener("input", () => name.setCustomValidity(name.validity.patternMismatch ? "Use letters, digits, space, . _ - (max 40)" : ""));
  dlg.addEventListener("close", () => { name.value = ""; name.setCustomValidity(""); });
  $("#profile-form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    post("api/profiles", { name: name.value.trim(), values: { ...S.staged } }, "profile").catch(() => {});
  });
  $("#window").addEventListener("click", (e) => {
    const b = e.target.closest("[data-w]");
    if (!b) return;
    S.window = Number(b.dataset.w);
    for (const x of $("#window").children) x.setAttribute("aria-pressed", String(x === b));
    redrawCharts();
    labelTraces();
  });
  $("#theme").addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-set]");
    if (b) setTheme(b.dataset.themeSet);
  });
  darkMQ.addEventListener("change", themeChanged);
  matchMedia("(forced-colors: active)").addEventListener("change", themeChanged);
  $("#keys-switch").addEventListener("click", () => setKeys(!S.keys));
  document.addEventListener("keydown", onKey);
  $("#reset-stats").addEventListener("click", () => post("api/stats/reset", {}, "stats").catch(() => {}));
  $("#reapply-boot").addEventListener("click", () => {
    if (confirm("Restart nv-cpu-governor, gb10-clocklock and cpu-epp now? Clocks and EPP go back to their boot values.")) post("api/reapply-boot", {}, "boot").catch(() => {});
  });
  $("#proc-filter").addEventListener("input", () => S.snap && renderProcs(true));
  $("#proc-tree").addEventListener("change", () => S.snap && renderProcs(true));
  $$(".sort").forEach((b) => b.addEventListener("click", () => {
    S.sort = b.dataset.sort;
    $$("#d-procs th").forEach((th) => th.removeAttribute("aria-sort"));
    b.closest("th").setAttribute("aria-sort", "descending");
    renderProcs();
  }));
  $$("details").forEach((d) => d.addEventListener("toggle", () => S.snap && renderDetails()));
  const commit = $("#commit");
  new ResizeObserver(() => document.documentElement.style.setProperty("--commit-h", `${commit.offsetHeight}px`)).observe(commit);
}

async function start() {
  const theme = document.documentElement.dataset.theme || "auto";
  for (const b of $$("#theme [data-theme-set]")) b.setAttribute("aria-pressed", String(b.dataset.themeSet === theme));
  refreshColors();
  document.documentElement.dataset.chartTheme = resolvedTheme();
  renderLinks();
  buildPolicy();
  energy = initEnergy({
    fmt, signed, announce, reduced, glide, crossfade,
    onScale: (scale) => { S.scale = scale; store.set("sc-energy-scale", JSON.stringify(scale)); render(false); },
  });
  energy.init(S.scale);
  bind();
  setKeys(S.keys);
  for (const [id, knob, name] of [["#ch-gpu", "gpu", "GPU SM clock"], ["#ch-x925", "x925", "X925 cluster clock"], ["#ch-a725", "a725", "A725 cluster clock"]]) {
    const read = knob === "gpu" ? "gpu.sm_mhz" : `cpu.${knob}_mhz`;
    const set = knob === "gpu" ? "set.gpu_cap_mhz" : `set.${knob}_max_mhz`;
    const ch = makeChart($(`${id} [data-trace]`), [{ key: read }, { key: set, setpoint: true }],
      { unit: " MHz", labels: true, knob: knob === "gpu" ? "gpu_cap_mhz" : `${knob}_max_khz`, capWord: knob === "gpu" ? "cap" : "max" });
    ch.name = name;
  }
  buildRail();
  try {
    const [hist, st] = await Promise.all([fetch("api/history?window=3600").then((r) => r.json()), fetch("api/state").then((r) => r.json())]);
    seedHistory(hist);
    if (st.snapshot) ingest(st);
  } catch { /* the stream and the header carry the state */ }
  setLink();
  setInterval(setLink, 1000);
  // An EventSource opened before `load` keeps the page "loading" (spinner, headless screenshots).
  if (document.readyState === "complete") connect();
  else addEventListener("load", connect, { once: true });
}
start();
