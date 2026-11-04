"use strict";
/* spark-console client. One SSE stream drives everything; controls stage values,
   Apply opens a trial on the server, Keep / Revert close it. */

const $ = (sel, root = document) => root.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const NF = {};
const fmt = (v, d = 0) => {
  if (v == null || Number.isNaN(v)) return "—";
  NF[d] ??= new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return NF[d].format(v);
};
const clock = (t) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(t * 1000));
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LABEL = { gpu_cap_mhz: "GPU cap", x925_max_khz: "X925 max", a725_max_khz: "A725 max", epp: "EPP", governor: "governor" };
function knobText(k, v) {
  if (k === "gpu_cap_mhz") return v == null ? "no cap" : `${fmt(v)} MHz`;
  if (k.endsWith("_khz")) return v == null ? "—" : `${fmt(v / 1000)} MHz`;
  return v == null ? "—" : String(v);
}
const changeList = (obj) => Object.entries(obj).map(([k, v]) => `${LABEL[k]} ${knobText(k, v)}`).join(", ");

const S = { snap: null, control: null, profiles: [], staged: {}, window: 120, sort: "cpu", busy: false, error: "" };

/* --- client-side history (mirrors the server's 1 h ring) ---------------------------------- */
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

/* --- charts -------------------------------------------------------------------------- */
const charts = [];
function makeChart(el, series, { unit = "", digits = 0, pad = 0.15 } = {}) {
  const tip = document.createElement("span");
  tip.className = "tip";
  el.append(tip);
  const ink = css("--ink"), ink3 = css("--ink-3"), amber = css("--amber");
  const opts = {
    width: el.clientWidth || 300, height: el.clientHeight || 60,
    legend: { show: false },
    cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
    axes: [{ show: false }, { show: false }],
    scales: {
      x: { time: true },
      y: { range: (u, lo, hi) => {
        if (lo == null || hi == null) return [0, 1];
        const span = Math.max(hi - lo, Math.abs(hi) * 0.05, 1);
        return [lo - span * pad, hi + span * pad];
      } },
    },
    series: [{}, ...series.map((s) => ({
      stroke: s.setpoint ? () => (S.control?.trial ? amber : ink3) : (s.color || ink),
      width: s.setpoint ? 1 : 1.5,
      dash: s.setpoint ? [4, 4] : undefined,
      paths: s.setpoint ? uPlot.paths.stepped({ align: 1 }) : undefined,
      spanGaps: false,
      points: { show: false },
    }))],
    hooks: { setCursor: [(u) => {
      const i = u.cursor.idx;
      if (i == null) { tip.textContent = ""; return; }
      const ago = Math.round(u.data[0][u.data[0].length - 1] - u.data[0][i]);
      tip.textContent = `${ago ? `−${ago} s · ` : "now · "}${fmt(u.data[1][i], digits)}${unit}`;
    }] },
  };
  const u = new uPlot(opts, [[], ...series.map(() => [])], el);
  const keys = series.map((s) => s.key);
  const chart = { u, keys, el };
  new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight })).observe(el);
  charts.push(chart);
  return chart;
}
function redrawCharts() {
  for (const c of charts) c.u.setData(windowData(c.keys));
}

/* --- network -------------------------------------------------------------------------- */
async function post(path, body = {}) {
  S.busy = true;
  S.error = "";
  renderCommit();
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Spark-Console": "1" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (data.control) S.control = data.control;
    if (data.profiles) S.profiles = data.profiles;
    return data;
  } catch (e) {
    S.error = e.message;
    throw e;
  } finally {
    S.busy = false;
    render();
  }
}

function connect() {
  const link = $("#link"), text = $("#link-text");
  const es = new EventSource("api/stream");
  es.onopen = () => { link.dataset.ok = "1"; text.textContent = "Live · 1 s"; };
  es.onerror = () => { link.dataset.ok = "0"; text.textContent = "Reconnecting…"; };
  es.onmessage = (ev) => {
    const st = JSON.parse(ev.data);
    if (st.snapshot?.series) pushHistory(st.snapshot.t, st.snapshot.series);
    apply(st);
  };
  setInterval(() => {
    if (S.snap && Date.now() / 1000 - S.snap.t > 5 && link.dataset.ok === "1") text.textContent = "Stale data";
  }, 2000);
}

function apply(st) {
  S.snap = st.snapshot;
  S.control = st.control;
  S.profiles = st.profiles;
  // Drop staged values that the machine now has anyway.
  for (const [k, v] of Object.entries(S.staged)) if (S.control?.current?.[k] === v) delete S.staged[k];
  render();
}

/* --- staging --------------------------------------------------------------------------- */
function stage(knob, value) {
  if (S.control?.current?.[knob] === value) delete S.staged[knob];
  else S.staged[knob] = value;
  render();
}
const effective = (knob) => (knob in S.staged ? S.staged[knob] : S.control?.current?.[knob]);

/* --- render: header, banner, commit bar ------------------------------------------------------ */
function renderLinks() {
  const h = location.hostname;
  const local = h === "127.0.0.1" || h === "localhost";
  $("#to-sparkdash").href = local ? "http://127.0.0.1:5555/" : `https://${h}:8443/`;
  $("#to-dgx").href = local ? "http://127.0.0.1:11000/" : `https://${h}/`;
  $("#host").textContent = local ? "this host" : h.split(".")[0];
}

function renderBanner() {
  const b = $("#banner"), c = S.control;
  if (!c) return;
  if (c.simulate) {
    b.hidden = false;
    b.innerHTML = "Simulation: controls change an in-memory copy, not the hardware.";
  } else if (!c.helper_installed) {
    b.hidden = false;
    b.innerHTML = "Read-only: the root helper is not installed. Run <code>sudo deploy/install.sh</code> in the repo on dgx0 to enable the controls.";
  } else b.hidden = true;
}

function renderCommit() {
  const bar = $("#commit"), c = S.control || {}, t = c.trial;
  const staged = Object.keys(S.staged).length;
  const text = $("#commit-text");
  $("#commit-trial").hidden = !t;
  $("#commit-staged").hidden = !!t;
  for (const id of ["#apply", "#discard", "#keep", "#keep-boot", "#revert"]) $(id).disabled = S.busy;
  $("#reapply-boot").disabled = S.busy || !!t || !c.helper_installed;
  if (t) {
    bar.dataset.mode = "trial";
    text.innerHTML = t.revert_error
      ? `<b>Revert failed, retrying in ${mmss(t.remaining_s)}</b> · ${esc(t.revert_error)}`
      : `<b>Trial</b> · ${esc(changeList(t.applied))} · reverting in <b>${mmss(t.remaining_s)}</b>`;
    $("#keep").disabled = $("#keep-boot").disabled = S.busy || !!t.revert_error;
    $("#drain").style.transform = `scaleX(${t.total_s ? t.remaining_s / t.total_s : 0})`;
  } else if (staged) {
    bar.dataset.mode = "staged";
    text.innerHTML = `<b>${staged} staged</b> · ${esc(Object.entries(S.staged).map(([k, v]) => `${LABEL[k]} ${knobText(k, c.current?.[k])} → ${knobText(k, v)}`).join(", "))}`;
    $("#drain").style.transform = "scaleX(0)";
    $("#apply").disabled = S.busy || !c.helper_installed;
  } else {
    bar.dataset.mode = "idle";
    const last = (c.events || []).at(-1);
    text.textContent = last ? `${eventText(last)} · ${clock(last.t)}` : "No changes staged. Use the channels, the CPU policy or a profile.";
    $("#drain").style.transform = "scaleX(0)";
  }
  const err = $("#commit-error");
  err.hidden = !S.error;
  err.textContent = S.error ? `Failed: ${S.error}` : "";
}

function eventText(e) {
  switch (e.kind) {
    case "applied": return `Trial started: ${changeList(e.applied)}`;
    case "reverted": return `Reverted (${e.why === "timeout" ? "not kept in time" : e.why}): ${changeList(e.values)}`;
    case "kept": return `Kept${e.persist ? " after reboot" : " until reboot"}: ${changeList(e.values)}`;
    case "persisted": return `Saved for boot: ${[e.gpu && "GPU", e.cpu && "CPU"].filter(Boolean).join(" + ")}`;
    case "failed": return `Failed: ${e.error}`;
    case "boot_reapplied": return "Boot values re-applied (gb10-clocklock and cpu-epp restarted)";
    case "persist_failed": return `Kept, but saving for boot failed: ${e.error}`;
    case "revert_failed": return `Revert failed: ${e.error}`;
    case "rollback_failed": return `Rollback of ${LABEL[e.knob] || e.knob} failed: ${e.error}`;
    default: return e.kind;
  }
}

/* --- render: channels ---------------------------------------------------------------------------- */
const LAMPS_GPU = [
  ["sw_power_cap", "Pwr cap", "serious"], ["sw_thermal_slowdown", "SW therm", "serious"],
  ["hw_thermal_slowdown", "HW therm", "crit"], ["hw_slowdown", "HW slow", "crit"],
  ["hw_power_brake_slowdown", "Pwr brake", "crit"], ["gpu_idle", "Idle", "info"],
];
function lampsHTML(list) {
  return list.map(([on, label, level]) => `<li class="lamp" data-on="${on ? level : ""}">${esc(label)}<span class="sr-only">${on ? " active" : " off"}</span></li>`).join("");
}

function renderChannel(id, knob, read, sub, range, lamps) {
  const el = $(id), c = S.control || {};
  const cur = c.current?.[knob], eff = effective(knob), pending = knob in S.staged;
  const inTrial = c.trial && knob in c.trial.applied;
  const isGpu = knob === "gpu_cap_mhz";
  el.dataset.pending = pending ? "1" : "0";
  const set = $("[data-set]", el);
  set.innerHTML = pending
    ? `${esc(knobText(knob, eff))}<span class="was">${esc(knobText(knob, cur))}</span>`
    : esc(knobText(knob, cur));
  set.style.color = pending || inTrial ? "" : css("--ink-2");
  const boot = c.persisted?.[knob];
  // Without a spark-console drop-in the CPU max is the hardware max at boot.
  $("[data-boot]", el).textContent = knob in (c.persisted || {}) ? `BOOT ${knobText(knob, boot)}` : isGpu ? "BOOT no cap" : "BOOT full range";
  $("[data-read]", el).textContent = fmt(read);
  $("[data-sub]", el).textContent = sub;
  const input = $("[data-input]", el);
  const mhz = eff == null ? null : isGpu ? eff : Math.round(eff / 1000);
  if (document.activeElement !== input) input.value = mhz ?? "";
  input.min = range[0];
  input.max = range[1];
  input.disabled = isGpu && eff == null;
  for (const b of el.querySelectorAll("[data-step]")) {
    const d = Number(b.dataset.step);
    b.disabled = mhz == null || (d < 0 ? mhz <= range[0] : mhz >= range[1]);
  }
  const nocap = $("[data-nocap]", el);
  if (nocap) nocap.checked = eff == null;
  $("[data-lamps]", el).innerHTML = lampsHTML(lamps);
}

function bindChannel(id, knob, rangeOf) {
  const el = $(id), isGpu = knob === "gpu_cap_mhz";
  const toValue = (mhz) => (isGpu ? mhz : mhz * 1000);
  const clampStage = (mhz) => {
    const [lo, hi] = rangeOf();
    if (!Number.isFinite(mhz)) return;
    stage(knob, toValue(Math.min(hi, Math.max(lo, Math.round(mhz)))));
  };
  for (const b of el.querySelectorAll("[data-step]")) {
    b.addEventListener("click", () => {
      const eff = effective(knob);
      const mhz = isGpu ? eff : eff / 1000;
      // Snap to the 100 MHz grid first, then step.
      const d = Number(b.dataset.step);
      const next = d > 0 ? Math.floor(mhz / 100) * 100 + 100 : Math.ceil(mhz / 100) * 100 - 100;
      clampStage(next);
    });
  }
  $("[data-input]", el).addEventListener("change", (e) => clampStage(Number(e.target.value)));
  const nocap = $("[data-nocap]", el);
  if (nocap) nocap.addEventListener("change", (e) => {
    const persisted = S.control?.persisted?.gpu_cap_mhz;
    stage(knob, e.target.checked ? null : (S.control?.current?.gpu_cap_mhz ?? persisted ?? 2100));
  });
}

/* --- render: policy, profiles --------------------------------------------------------------------- */
const EPP_STOPS = [[0, "Perf"], [64, ""], [128, "Balanced"], [192, ""], [255, "Power"]];
function renderPolicy() {
  const c = S.control, snap = S.snap;
  if (!c || !snap) return;
  const cur = c.current, effEpp = effective("epp"), effGov = effective("governor");
  $(".policy").dataset.pending = "epp" in S.staged || "governor" in S.staged ? "1" : "0";
  $("#epp-stops").innerHTML = EPP_STOPS.map(([v, l]) =>
    `<button type="button" data-epp="${v}" aria-pressed="${cur.epp === v}" data-staged="${effEpp === v && "epp" in S.staged ? 1 : 0}">${v}${l ? `<small>${l}</small>` : ""}</button>`).join("");
  const epp = $("#epp");
  if (document.activeElement !== epp) epp.value = effEpp;
  epp.dataset.pending = "epp" in S.staged ? "1" : "0";
  $("#epp-now").textContent = `now ${cur.epp}${c.persisted?.epp != null ? ` · boot ${c.persisted.epp}` : ""}`;
  const gov = $("#governor");
  const opts = snap.cpu.governors.join(",");
  if (gov.dataset.opts !== opts) {
    gov.innerHTML = snap.cpu.governors.map((g) => `<option>${esc(g)}</option>`).join("");
    gov.dataset.opts = opts;
  }
  if (document.activeElement !== gov) gov.value = effGov;
  gov.dataset.pending = "governor" in S.staged ? "1" : "0";
  $("#gov-now").textContent = `now ${cur.governor}${c.persisted?.governor ? ` · boot ${c.persisted.governor}` : " · boot by nv-cpu-governor"}`;
}

function renderProfiles() {
  const cur = S.control?.current || {};
  $("#profiles").innerHTML = S.profiles.map((p, i) => {
    const match = Object.entries(p.values).every(([k, v]) => cur[k] === v);
    return `<span class="profile" data-match="${match ? 1 : 0}">
      <button type="button" data-profile="${i}" title="${esc(p.note || "")}"><span class="p-name">${esc(p.name)}</span><span class="p-vals">${esc(Object.entries(p.values).map(([k, v]) => `${k === "gpu_cap_mhz" ? "GPU" : LABEL[k]} ${knobText(k, v).replace(" MHz", "")}`).join(" · "))}</span></button>
      ${p.builtin ? "" : `<button type="button" class="p-del" data-del="${i}" aria-label="Delete profile ${esc(p.name)}">×</button>`}
    </span>`;
  }).join("");
}

/* --- render: effect rail ------------------------------------------------------------------------- */
const RAIL = [
  { key: "gpu.power_w", label: "GPU power", unit: "W", d: 1, val: (s) => s.gpu?.power_w, meta: (s) => statMeta("gpu.power_w", 1, "W") },
  { key: "llm.tok_s", label: "Decode", unit: "tok/s", d: 1, val: (s) => s.llm?.tok_s, meta: (s) => (s.llm?.endpoints || []).filter((e) => e.ok).map((e) => e.model || e.engine).join(", ") || "no LLM server answering" },
  { key: "llm.j_per_tok", label: "Energy", unit: "J/tok", d: 2, val: (s) => s.llm?.j_per_tok, meta: () => "GPU W ÷ tok/s (GPU only)" },
  { key: "gpu.tlimit_c", label: "GPU headroom", unit: "°C", d: 0, val: (s) => s.gpu?.tlimit_c, meta: (s) => `GPU ${fmt(s.gpu?.temp_c)} °C · min ${fmt(S.snap?.stats?.["gpu.tlimit_c"]?.min)} °C` },
  { key: "gpu.util", label: "GPU busy", unit: "%", d: 0, val: (s) => s.gpu?.util, meta: (s) => `${s.gpu?.pstate ?? ""} · SM ${fmt(s.gpu?.sm_mhz)} MHz` },
  { key: "mem.avail_gib", label: "Memory free", unit: "GiB", d: 1, val: (s) => s.mem?.avail_kib / 1048576, meta: (s) => `PSI ${fmt(s.mem?.psi?.some?.avg10, 1)} % · swap ${fmt(s.mem?.swap_used_kib / 1048576, 1)} GiB` },
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
      <div class="spark" data-spark role="img" aria-label="${esc(r.label)} over the selected window"></div>
    </div>`).join("");
  RAIL.forEach((r, i) => makeChart($(`.readout[data-i="${i}"] [data-spark]`, rail), [{ key: r.key, color: css("--ink-2") }], { unit: ` ${r.unit}`, digits: r.d }));
}
function renderRail() {
  const s = S.snap;
  RAIL.forEach((r, i) => {
    const el = $(`.readout[data-i="${i}"]`);
    $("[data-v]", el).textContent = fmt(r.val(s), r.d);
    $("[data-m]", el).textContent = r.meta(s);
  });
}

/* --- render: details --------------------------------------------------------------------------------- */
function renderDetails() {
  const s = S.snap;
  const cl = s.cpu.clusters;
  $("#d-cores [data-sum]").textContent = ["x925", "a725"].filter((k) => cl[k]).map((k) => `${k.toUpperCase()} ${fmt(cl[k].mhz / 1000, 2)} GHz ${fmt(cl[k].util)} %`).join(" · ");
  if ($("#d-cores").open) {
    $("#cores").innerHTML = ["x925", "a725"].map((k) => `<div class="cluster-row"><span class="silk">${k} · ${cl[k]?.cores ?? 0}</span><div class="cells">${
      s.cpu.cores.filter((c) => c.cluster === k).map((c) => `<div class="cell" data-limited="${c.perf_limited ? 1 : 0}" title="CPU ${c.cpu}">
        <div class="fill" style="transform:scaleY(${(c.util ?? 0) / 100})"></div><span>cpu${c.cpu}</span><b>${fmt(c.mhz)}</b></div>`).join("")}</div></div>`).join("");
  }
  const m = s.mem, gib = (k) => fmt(k / 1048576, 1);
  $("#d-mem [data-sum]").textContent = `${gib(m.avail_kib)} of ${gib(m.total_kib)} GiB free`;
  if ($("#d-mem").open) {
    const p = m.psi || {};
    $("#mem").innerHTML = `<div class="kv">
      <div><span class="silk">Available</span><b>${gib(m.avail_kib)} GiB</b></div>
      <div><span class="silk">Total visible</span><b>${gib(m.total_kib)} GiB</b></div>
      <div><span class="silk">Page cache</span><b>${gib(m.cached_kib)} GiB</b></div>
      <div><span class="silk">Swap used</span><b>${gib(m.swap_used_kib)} of ${gib(m.swap_total_kib)} GiB</b></div></div>
      <table class="grid"><thead><tr><th scope="col">Pressure</th><th scope="col"></th><th scope="col">10 s</th><th scope="col">60 s</th><th scope="col">300 s</th></tr></thead><tbody>
      ${["some", "full"].map((k) => `<tr><td>${k === "some" ? "Some tasks stalled" : "All tasks stalled"}</td><td></td><td>${fmt(p[k]?.avg10, 2)} %</td><td>${fmt(p[k]?.avg60, 2)} %</td><td>${fmt(p[k]?.avg300, 2)} %</td></tr>`).join("")}
      </tbody></table>`;
  }
  const hot = [...s.sensors].sort((a, b) => b.temp_c - a.temp_c)[0];
  $("#d-sensors [data-sum]").textContent = hot ? `hottest ${hot.name} ${fmt(hot.temp_c)} °C · ${s.sensors.length} sensors` : "";
  if ($("#d-sensors").open) {
    $("#stats-since").textContent = `min / max since ${clock(s.stats_since)}`;
    const rows = [{ id: "gpu", name: "GPU", temp_c: s.gpu?.temp_c, key: "gpu.temp_c" }, ...s.sensors.map((x) => ({ ...x, key: `temp.${x.id}` }))];
    $("#sensors").innerHTML = rows.map((x) => {
      const st = s.stats?.[x.key] || {};
      return `<tr><td>${esc(x.name)}</td><td>${fmt(x.temp_c, 1)} °C</td><td>${fmt(st.min, 1)}</td><td>${fmt(st.max, 1)}</td><td>${fmt(st.avg, 1)}</td></tr>`;
    }).join("");
  }
  const top = s.procs[0];
  $("#d-procs [data-sum]").textContent = top ? `top ${top.comm} ${fmt(top.cpu)} % · ${s.procs.length} shown` : "";
  if ($("#d-procs").open) renderProcs();
  const up = s.llm.endpoints.filter((e) => e.ok);
  $("#d-llm [data-sum]").textContent = `${up.length} of ${s.llm.endpoints.length} answering`;
  if ($("#d-llm").open) {
    $("#llm").innerHTML = s.llm.endpoints.map((e) => `<tr><td translate="no">${esc(e.url)}</td><td>${esc(e.engine || "—")}</td><td>${esc(e.ok ? e.model || "—" : "not answering")}</td><td>${fmt(e.tok_s, 1)}</td><td>${fmt(e.running)}</td></tr>`).join("");
  }
  const sv = Object.entries(s.services || {});
  const bad = sv.filter(([, v]) => v.active !== "active" && v.active !== "running" && !(v.active === "inactive" && v.sub === "dead" && v.enabled === "enabled"));
  $("#d-services [data-sum]").textContent = sv.length ? (bad.length ? `${bad.map(([k]) => k).join(", ")}: check` : "all as expected") : "";
  if ($("#d-services").open) {
    $("#services").innerHTML = sv.map(([k, v]) => `<tr><td translate="no">${esc(k)}</td><td>${esc([v.active, v.sub].filter(Boolean).join(" / "))}</td><td>${esc(v.enabled || "—")}</td></tr>`).join("");
  }
  const ev = S.control?.events || [];
  $("#d-activity [data-sum]").textContent = ev.length ? eventText(ev.at(-1)) : "nothing yet";
  if ($("#d-activity").open) {
    $("#activity").innerHTML = ev.slice().reverse().map((e) => `<li><time>${clock(e.t)}</time><span>${esc(eventText(e))}</span></li>`).join("") || "<li class=\"muted\">No control changes since the server started.</li>";
  }
}

function renderProcs() {
  const q = $("#proc-filter").value.trim().toLowerCase();
  let rows = S.snap.procs.filter((p) => !q || p.comm.toLowerCase().includes(q) || String(p.pid).startsWith(q));
  const key = S.sort;
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  let depth = new Map();
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
  $("#procs").innerHTML = rows.slice(0, 200).map((p) => `<tr><td>${p.pid}</td><td class="name" style="padding-left:${8 + 14 * (depth.get(p.pid) || 0)}px" title="${esc(p.comm)}">${depth.get(p.pid) ? "└ " : ""}${esc(p.comm)}</td><td>${fmt(p.cpu, 1)}</td><td>${fmt(p.rss_mib)}</td><td>${p.gpu_mib == null ? "" : fmt(p.gpu_mib)}</td><td>${esc(p.state)}</td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No process matches “${esc(q)}”.</td></tr>`;
}

/* --- main render ---------------------------------------------------------------------------------------- */
function render() {
  if (!S.snap || !S.control) return;
  const s = S.snap, c = S.control, lim = c.limits || {};
  renderBanner();
  renderCommit();
  const g = s.gpu || {};
  const reasons = new Set(g.reasons || []);
  renderChannel("#ch-gpu", "gpu_cap_mhz", g.sm_mhz,
    s.gpu ? `${fmt(g.util)} % · ${fmt(g.power_w, 1)} W · headroom ${fmt(g.tlimit_c)} °C` : s.gpu_error || "no GPU data",
    [300, 3100], LAMPS_GPU.map(([k, l, lvl]) => [reasons.has(k), l, lvl]));
  for (const k of ["x925", "a725"]) {
    const cl = s.cpu.clusters[k] || {};
    const r = lim[k] || [0, 0];
    renderChannel(`#ch-${k}`, `${k}_max_khz`, cl.mhz, `${fmt(cl.util)} % · ${cl.cores ?? 0} cores`,
      [Math.ceil(r[0] / 1000), Math.floor(r[1] / 1000)],
      [[cl.perf_limited > 0, cl.perf_limited > 0 ? `Perf limited · ${cl.perf_limited}` : "Perf limited", "serious"]]);
  }
  renderPolicy();
  renderProfiles();
  renderRail();
  renderDetails();
  redrawCharts();
}

/* --- wiring ---------------------------------------------------------------------------------------------- */
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
    if (b) stage("epp", Number(b.dataset.epp));
  });
  $("#epp").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (Number.isFinite(v)) stage("epp", Math.min(255, Math.max(0, v)));
  });
  $("#governor").addEventListener("change", (e) => stage("governor", e.target.value));
  $("#apply").addEventListener("click", async () => {
    const changes = { ...S.staged };
    try {
      await post("api/apply", { changes, trial_s: Number($("#trial-s").value) });
      S.staged = {};
      $("#commit-announce").textContent = `Trial started. It reverts in ${$("#trial-s").selectedOptions[0].text} unless you keep it.`;
      render();
    } catch { /* shown in the bar */ }
  });
  $("#discard").addEventListener("click", () => { S.staged = {}; S.error = ""; render(); });
  $("#keep").addEventListener("click", () => post("api/keep", { persist: false }).then(() => { $("#commit-announce").textContent = "Kept until reboot."; }).catch(() => {}));
  $("#keep-boot").addEventListener("click", () => post("api/keep", { persist: true }).then(() => { $("#commit-announce").textContent = "Kept and saved for boot."; }).catch(() => {}));
  $("#revert").addEventListener("click", () => post("api/revert").then(() => { $("#commit-announce").textContent = "Reverted."; }).catch(() => {}));
  $("#profiles").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const p = S.profiles[Number(del.dataset.del)];
      if (p && confirm(`Delete profile “${p.name}”?`)) post("api/profiles/delete", { name: p.name }).catch(() => {});
      return;
    }
    const b = e.target.closest("[data-profile]");
    if (!b) return;
    for (const [k, v] of Object.entries(S.profiles[Number(b.dataset.profile)].values)) stage(k, v);
  });
  const dlg = $("#profile-dialog");
  $("#save-profile").addEventListener("click", () => {
    const n = Object.keys(S.staged).length;
    $("#profile-hint").textContent = n ? `Saves: ${changeList(S.staged)}` : "Stage values with the controls first.";
    $("#profile-form [value=save]").disabled = !n;
    dlg.showModal();
  });
  $("#profile-form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    post("api/profiles", { name: $("#profile-name").value.trim(), values: { ...S.staged } }).catch(() => {});
  });
  $("#window").addEventListener("click", (e) => {
    const b = e.target.closest("[data-w]");
    if (!b) return;
    S.window = Number(b.dataset.w);
    for (const x of $("#window").children) x.setAttribute("aria-pressed", String(x === b));
    redrawCharts();
  });
  $("#reset-stats").addEventListener("click", () => post("api/stats/reset").catch(() => {}));
  $("#reapply-boot").addEventListener("click", () => {
    if (confirm("Restart gb10-clocklock and cpu-epp now? Clocks and EPP go back to their boot values.")) post("api/reapply-boot").catch(() => {});
  });
  $("#proc-filter").addEventListener("input", () => S.snap && renderProcs());
  $("#proc-tree").addEventListener("change", () => S.snap && renderProcs());
  document.querySelectorAll(".sort").forEach((b) => b.addEventListener("click", () => {
    S.sort = b.dataset.sort;
    document.querySelectorAll("#d-procs th").forEach((th) => th.removeAttribute("aria-sort"));
    b.closest("th").setAttribute("aria-sort", "descending");
    renderProcs();
  }));
  document.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => S.snap && renderDetails()));
}

async function start() {
  renderLinks();
  bind();
  for (const [id, knob] of [["#ch-gpu", "gpu"], ["#ch-x925", "x925"], ["#ch-a725", "a725"]]) {
    const read = knob === "gpu" ? "gpu.sm_mhz" : `cpu.${knob}_mhz`;
    const set = knob === "gpu" ? "set.gpu_cap_mhz" : `set.${knob}_max_mhz`;
    makeChart($(`${id} [data-trace]`), [{ key: read }, { key: set, setpoint: true }], { unit: " MHz" });
  }
  buildRail();
  try {
    const [hist, st] = await Promise.all([fetch("api/history?window=3600").then((r) => r.json()), fetch("api/state").then((r) => r.json())]);
    seedHistory(hist);
    if (st.snapshot) apply(st);
  } catch (e) {
    $("#link-text").textContent = `Cannot reach server: ${e.message}`;
  }
  // An EventSource opened before `load` keeps the page "loading" (spinner, headless screenshots).
  if (document.readyState === "complete") connect();
  else addEventListener("load", connect, { once: true });
}
start();
