/* Energy class drawer: the tab (a pill on a phone), the paper ticket, its burn frame, and the scale dialog.
   app.js computes the view (metrics.js); this module only draws it and handles open/close. */
import { LETTERS, MIN_N, bandText, SCALE_DEFAULT, validScale } from "./metrics.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const setHTML = (el, h) => { if (el._h !== h) { el.innerHTML = h; el._h = h; } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function initEnergy({ fmt, signed, announce, reduced, glide, crossfade, onScale }) {
  const tab = $("#ec-tab"), aside = $("#energy"), ticket = $("#ticket"), main = $("#main");
  const phone = matchMedia("(max-width: 720px)");
  const edge = document.createElement("span");
  edge.className = "ec-edge";
  edge.setAttribute("aria-hidden", "true");
  tab.append(edge);
  let scale = { ...SCALE_DEFAULT };
  let lastClosed = 0, enterT, animT, from = null;
  let settledKey = null, lastAnnounce = 0, lastRemaining = null, lastLetter = null, lastView = null;

  /* --- ladder ------------------------------------------------------------------------------------------- */
  function buildLadder() {
    $("#ladder").innerHTML = [...LETTERS].map((L, k) => `<li data-k="${k}"><span class="rung" data-k="${k}" style="--i:${k}"><b>${L}</b><span class="rung-tag" aria-hidden="true"></span></span><span class="sr-only">, ${bandText(k, scale)} J/token<span data-mark></span></span></li>`).join("");
  }

  /* --- one-shot motion helper (crossfade comes from app.js) ------------------------------------------- */
  const peek = () => {
    if (reduced.matches || isOpen() || phone.matches) return;
    tab.animate([{ translate: "0 0" }, { translate: "-8px 0", offset: 0.45 }, { translate: "0 0" }], { duration: 440, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  };

  /* --- render ---------------------------------------------------------------------------------------------- */
  /* word: changes on verdict events only, so the tab's accessible name does not change every tick */
  function decodeWords(tok) {
    if (!tok || tok.state !== "ok") return null;
    if (tok.verdict === "within noise") return { word: "within noise", noise: true, sr: "decode within noise", pill: "decode ≈ same" };
    const p = Math.round(Math.abs(tok.pct)), word = tok.pct < 0 ? "slower" : "faster";
    return { word, sr: `decode ${p} % ${word}`, pill: `decode ${signed(Math.round(tok.pct), 0)} %` };
  }
  const part = (d, unit, digits) => {
    if (!d || d.state !== "ok") return "";
    return d.verdict === "within noise" ? `${signed(d.d, digits)} ${unit} <span class="noise">within noise</span>` : `${signed(d.d, digits)} ${unit}`;
  };

  function render(v) {
    lastView = v;
    const st = v.state;
    const nowK = v.now?.k ?? null, beforeK = v.before?.k ?? null;
    const inTrial = !!v.trial;
    const tok = v.deltas?.tok;
    const dw = decodeWords(tok);

    // tab / pill
    const showK = st === "ok" || st === "trial" ? nowK : st === "settling" || st === "below" ? beforeK : null;
    const sw = $(".ec-sw", tab), letter = $("[data-letter]", tab);
    sw.dataset.k = showK ?? "";
    sw.dataset.dim = (st === "settling" || st === "below") && showK != null ? "1" : "0";
    const L = showK == null ? "–" : LETTERS[showK];
    if (letter.textContent !== L) {
      letter.textContent = L;
      if (lastLetter != null) crossfade(letter);
      lastLetter = L;
    }
    // A better class that hides a slower decode is a state on the swatch, not an unlabelled number.
    tab.toggleAttribute("data-warn", !!v.honesty);
    setText($("[data-tabname]", tab), `Energy class ${showK == null ? "not measured" : L}${dw ? `, decode ${dw.word}` : ""}`);
    setText($("[data-pill]", tab), inTrial && dw ? dw.pill : "Energy class");
    tab.dataset.trial = inTrial ? "1" : "0";

    // trial: tab edge and burn frame, re-synced to the server's countdown each second
    const run = $(".burn-run", ticket);
    if (inTrial) {
      const r = v.trial.remaining, tot = v.trial.total || 1;
      if (r !== lastRemaining) {
        lastRemaining = r;
        glide(edge, "transform", `scaleY(${Math.max(0, r) / tot})`, `scaleY(${Math.max(0, r - 1) / tot})`);
        const at = (x) => String(-100 * (1 - Math.max(0, x) / tot));
        glide(run, "strokeDashoffset", at(r), at(r - 1));
      }
      ticket.dataset.frame = st === "hold" ? "hold" : r <= 10 ? "urgent" : "trial";
    } else if (lastRemaining != null) {
      lastRemaining = null;
      edge._glide?.cancel();
      run._glide?.cancel();
      ticket.dataset.frame = "static";
    }

    // ticket
    ticket.dataset.state = st;
    for (const li of $$("#ladder li")) {
      const k = Number(li.dataset.k);
      const isNow = (st === "ok" || st === "trial") && k === nowK;
      const isBefore = inTrial && beforeK != null && k === beforeK && st !== "idle";
      if (isNow) li.setAttribute("aria-current", "true"); else li.removeAttribute("aria-current");
      setText($("[data-mark]", li), [isNow && ", now", isBefore && ", before the trial"].filter(Boolean).join(""));
      setText($(".rung-tag", li), isNow ? "Now" : isBefore ? "Before" : "");
    }
    const aNow = $("#arrow-now"), aBefore = $("#arrow-before"), aStaged = $("#arrow-staged");
    aNow.dataset.show = nowK != null && (st === "ok" || st === "trial") ? "1" : "0";
    if (nowK != null) {
      aNow.style.setProperty("--k", nowK);
      const span = $("span", aNow);
      if (span.textContent !== LETTERS[nowK]) { span.textContent = LETTERS[nowK]; if (isOpen()) crossfade(span); }
    }
    const showBefore = inTrial && beforeK != null && st !== "idle";
    aBefore.dataset.show = showBefore ? "1" : "0";
    if (beforeK != null) { aBefore.style.setProperty("--k", beforeK); setText($("span", aBefore), LETTERS[beforeK]); }
    const showStaged = v.staged && nowK != null && st === "ok";
    aStaged.dataset.show = showStaged ? "1" : "0";
    if (showStaged) aStaged.style.setProperty("--k", nowK);

    // class line, state line, trade table, honesty line
    let line, state = "";
    if (st === "hold") { line = "Class on hold"; state = "The class is on hold until the revert succeeds."; }
    else if (st === "warming") { line = `Measuring · ${fmt(v.tokNow, 1)} tok/s`; state = `Measuring the class… ${v.warmN ?? 0} of ${MIN_N} decode samples.`; }
    else if (st === "idle" && v.tokNow == null) { line = "No class · no LLM server answering"; state = "The class needs decode from an LLM server."; }
    else if (st === "idle") { line = `No class · ${fmt(v.tokNow, 1)} tok/s`; state = `No decode traffic: the class needs ${fmt(scale.min)} tok/s or more.`; }
    else if (st === "below") {
      line = [`Was ${LETTERS[beforeK]} → no class`, part(v.deltas?.w, "W", 1), dw ? dw.pill : `now ${fmt(v.tokNow, 1)} tok/s`].filter(Boolean).join(" · ");
      state = `Decode is below ${fmt(scale.min)} tok/s, so there is no class.`;
    }
    else if (st === "settling") {
      line = `${beforeK != null ? `Was ${LETTERS[beforeK]} · ${fmt(v.before.median, 2)} J/token` : "Measuring"} · now ${fmt(v.tokNow, 1)} tok/s`;
      state = "Measuring the new values…"; // the commit bar holds the one count
    } else if (st === "trial") {
      line = [`${LETTERS[beforeK]} → ${LETTERS[nowK]}`, part(v.deltas?.w, "W", 1), part(tok, "tok/s", 1) || `now ${fmt(v.tokNow, 1)} tok/s`].filter(Boolean).join(" · ");
    } else {
      line = `Class ${LETTERS[nowK]} · ${fmt(v.now.median, 2)} J/token · ${fmt(v.tokNow, 1)} tok/s`;
      state = v.staged ? "Staged values. Apply to measure their class."
        : inTrial ? "No baseline: there was no decode traffic before the trial."
          : `30 s median while decoding. Class ${LETTERS[nowK]} is ${bandText(nowK, scale)} J/token.`;
    }
    setHTML($("#class-line"), line);
    setText($("#t-state"), state);
    const trade = $("#trade");
    trade.hidden = !(inTrial && v.deltas && (st === "trial" || st === "settling" || st === "below"));
    if (!trade.hidden) {
      const rows = [["Energy", "J/tok", 2, v.deltas.j], ["Decode", "tok/s", 1, tok], ["GPU", "W", 1, v.deltas.w]];
      setHTML($("tbody", trade), rows.map(([name, unit, d, x]) => {
        if (!x || x.state !== "ok") {
          const word = x?.state === "no-decode" ? "no decode" : x?.state === "below-min" ? "below min" : "measuring";
          return `<tr><th scope="row">${name}<small>${unit}</small></th><td class="num">–</td><td class="num">–</td><td data-v="${word}">${word}</td></tr>`;
        }
        const dot = x.verdict === "better" || x.verdict === "worse" ? `<span class="vdot" data-v="${x.verdict}"></span>` : "";
        const pct = unit === "tok/s" && x.verdict !== "within noise" ? `<small>${signed(Math.round(x.pct), 0)} %</small>` : "";
        return `<tr><th scope="row">${name}<small>${unit}</small></th><td class="num">${fmt(x.before, d)} → ${fmt(x.after, d)}</td><td class="num">${signed(x.d, d)}${pct}</td><td data-v="${x.verdict}">${dot}${x.verdict}</td></tr>`;
      }).join(""));
    }
    const hon = $("#honesty");
    hon.hidden = !v.honesty;
    setText(hon, v.honesty || "");
    setText($("#t-foot"), `Console J/token scale, not an EU rating. 30 s median of GPU W ÷ tok/s, decode ≥ ${fmt(scale.min)} tok/s.`);

    // first settle in a trial: one message, one peek
    if (inTrial && st === "trial" && settledKey !== v.trial.key) {
      settledKey = v.trial.key;
      const now = Date.now();
      if (now - lastAnnounce > 5000) {
        lastAnnounce = now;
        announce(`Class ${LETTERS[nowK]} measured. Was ${LETTERS[beforeK]}.${dw ? ` ${dw.sr[0].toUpperCase()}${dw.sr.slice(1)}.` : ""}`);
      }
      peek();
    }
  }

  /* --- open / close ---------------------------------------------------------------------------------------------- */
  const isOpen = () => aside.hasAttribute("data-open");
  function markAnimating() {
    aside.setAttribute("data-animating", "");
    clearTimeout(animT);
    animT = setTimeout(() => aside.removeAttribute("data-animating"), 340);
  }
  /* On a phone the sheet covers the page: it is modal (page inert, scrim). The commit bar is outside <main>,
     so Keep and Revert stay live. On a desktop the page makes room for the drawer (CSS), so it is not modal. */
  const setModal = (on) => { main.inert = on; tab.inert = on; };
  phone.addEventListener("change", () => setModal(isOpen() && phone.matches));
  function open({ focus = true } = {}) {
    if (isOpen()) return;
    const a = document.activeElement;
    from = a && a !== document.body && !aside.contains(a) ? a : null;
    aside.style.transform = "";
    aside.inert = false;
    markAnimating();
    if (!reduced.matches && Date.now() - lastClosed > 10000) {
      aside.setAttribute("data-entering", "");
      clearTimeout(enterT);
      enterT = setTimeout(() => aside.removeAttribute("data-entering"), 320);
    }
    aside.setAttribute("data-open", "");
    tab.setAttribute("aria-expanded", "true");
    setModal(phone.matches);
    if (focus) $("#energy-h").focus({ preventScroll: true });
  }
  function close() {
    if (!isOpen()) return;
    const hadFocus = aside.contains(document.activeElement);
    aside.inert = true;
    markAnimating();
    aside.removeAttribute("data-entering");
    aside.removeAttribute("data-open");
    aside.style.transform = "";
    tab.setAttribute("aria-expanded", "false");
    lastClosed = Date.now();
    setModal(false);
    // Back to where the user was (the tab, or the control they pressed E on).
    if (hadFocus) (from?.isConnected && !from.closest("[inert], [hidden]") ? from : tab).focus({ preventScroll: true });
    from = null;
  }
  const toggle = () => (isOpen() ? close() : open());
  aside.addEventListener("transitionend", (e) => { if (e.target === aside && e.propertyName === "transform") aside.removeAttribute("data-animating"); });
  tab.addEventListener("click", toggle);
  $("#ec-close").addEventListener("click", close);
  $("#ec-scrim").addEventListener("click", close);

  /* --- phone: drag the sheet down to dismiss ------------------------------------------------------------------------------ */
  let drag = null;
  aside.addEventListener("pointerdown", (e) => {
    if (!phone.matches || !e.target.closest(".ec-grab, .t-head") || e.target.closest("button")) return;
    drag = { y: e.clientY, t: performance.now(), dy: 0, h: aside.offsetHeight, id: e.pointerId };
    aside.setPointerCapture(e.pointerId);
    aside.style.transition = "none";
  });
  aside.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    aside.style.transform = `translateY(${drag.dy}px)`;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, h, t } = drag;
    drag = null;
    const v = dy / Math.max(1, performance.now() - t);
    aside.style.transition = "";
    const tapGrab = e.type === "pointerup" && dy < 4 && e.target.closest?.(".ec-grab"); // a tap on the handle closes too
    if (tapGrab || dy > 0.25 * h || v > 0.11) close();
    else {
      aside.style.transition = "transform 200ms cubic-bezier(0.23, 1, 0.32, 1)";
      aside.style.transform = "";
      setTimeout(() => { aside.style.transition = ""; }, 220);
    }
  };
  aside.addEventListener("pointerup", endDrag);
  aside.addEventListener("pointercancel", endDrag);

  /* --- scale dialog ------------------------------------------------------------------------------------------------------- */
  const dlg = $("#scale-dialog"), fa = $("#sc-a"), fr = $("#sc-r"), fm = $("#sc-min");
  // Same rule as a stored scale (metrics.js), per field so the bad one can be marked.
  const bad = () => {
    const a = Number(fa.value), r = Number(fr.value), m = Number(fm.value);
    const out = [];
    if (fa.value === "" || !(a > 0 && Number.isFinite(a))) out.push(fa);
    if (fr.value === "" || !(r > 1 && Number.isFinite(r))) out.push(fr);
    if (fm.value === "" || !(m >= 0 && Number.isFinite(m))) out.push(fm);
    if (!out.length && !validScale(a, r, m)) out.push(fa, fr);
    return out;
  };
  const valid = () => !bad().length;
  const preview = () => {
    const b = bad();
    const s = b.length ? scale : { a: Number(fa.value), r: Number(fr.value), min: Number(fm.value) };
    setHTML($("#scale-preview"), [...LETTERS].map((L, k) => `<tr><th scope="row"><span class="band-tag" data-k="${k}" style="background:var(--band)">${L}</span></th><td class="num">${esc(bandText(k, s))}</td></tr>`).join(""));
    $("#scale-error").hidden = !b.length;
    for (const x of [fa, fr, fm]) x.setAttribute("aria-invalid", String(b.includes(x)));
    return b;
  };
  $("#edit-scale").addEventListener("click", () => {
    fa.value = scale.a; fr.value = scale.r; fm.value = scale.min;
    preview();
    dlg.showModal();
  });
  for (const x of [fa, fr, fm]) x.addEventListener("input", preview);
  $("#scale-form").addEventListener("submit", (e) => {
    const v = e.submitter?.value;
    if (v === "reset") scale = { ...SCALE_DEFAULT };
    else if (v === "save") {
      if (!valid()) { e.preventDefault(); preview()[0].focus(); return; }
      scale = { a: Number(fa.value), r: Number(fr.value), min: Number(fm.value) };
    } else return;
    buildLadder();
    onScale(scale);
  });

  return {
    render(v) {
      if (v.scale !== scale && JSON.stringify(v.scale) !== JSON.stringify(scale)) { scale = { ...v.scale }; buildLadder(); }
      render(v);
    },
    init(s) { scale = { ...s }; buildLadder(); }, // always starts closed: a hidden item until asked for
    open, close, toggle, isOpen,
    contains: (el) => !!el && aside.contains(el),
    get view() { return lastView; },
  };
}
