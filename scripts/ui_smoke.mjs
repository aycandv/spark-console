// UI smoke check through the Chrome DevTools Protocol (Node >= 22, google-chrome).
// Run against a server started with --simulate --bind 127.0.0.1 --port 5567 --owner dev@local:
//   node scripts/ui_smoke.mjs http://127.0.0.1:5567/ OUT_DIR dev@local [CDP_PORT]
// It checks both themes, stable nodes, the staged and trial states, the Energy Class drawer,
// the keyboard shortcuts, reduced motion and the phone layout, and writes screenshots to OUT_DIR.
// Exit code 1 on any failure. The last line is "ui smoke: pass".
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:5566/";
const out = process.argv[3] || ".";
const login = process.argv[4] || "dev@local"; // sent as Tailscale-User-Login, like tailscale serve does
const port = Number(process.argv[5] || process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "ui-smoke-"))}`, "about:blank"], { stdio: "ignore" });
let ws, id = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
const shot = async (name, full = true) => {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
  writeFileSync(join(out, name), Buffer.from(data, "base64"));
};
const check = (cond, msg) => { if (!cond) throw new Error(`check failed: ${msg}`); console.log(`ok - ${msg}`); };
const KEYS = { e: [69, "KeyE"], k: [75, "KeyK"], Escape: [27, "Escape"] };
const press = async (key) => {
  const [vk, code] = KEYS[key];
  const text = key.length === 1 ? key : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
};
const media = (features) => send("Emulation.setEmulatedMedia", { features });
let scheme = "dark", motion = "no-preference";
const setScheme = (s) => { scheme = s; return media([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: motion }]); };
const setMotion = (m) => { motion = m; return media([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: motion }]); };
const bodyBg = () => evaluate(`getComputedStyle(document.body).backgroundColor`);
const mode = () => evaluate(`document.querySelector("#commit").dataset.mode`);
const waitFor = async (expr, ms = 5000, step = 20) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(step); }
  return false;
};
const clickTheme = (t) => evaluate(`document.querySelector('[data-theme-set="${t}"]').click()`);
// Stage GPU cap one step down (lifting "no cap" first) and an EPP stop that differs from the current one.
// Returns the EPP value staged.
const stageTrial = async (want = 192) => {
  await evaluate(`(() => { const n = document.querySelector("#ch-gpu [data-nocap]"); if (n.checked) n.click(); })()`);
  await evaluate(`document.querySelector('#ch-gpu [data-step="-1"]').click()`);
  const cur = await evaluate(`Number(document.querySelector('#epp-stops [aria-pressed="true"]')?.dataset.epp ?? -1)`);
  const epp = cur === want ? 64 : want;
  await evaluate(`document.querySelector('[data-epp="${epp}"]').click()`);
  return epp;
};
const startTrial = async () => {
  await evaluate(`document.querySelector("#apply").click()`);
  return waitFor(`document.querySelector("#commit").dataset.mode === "trial"`, 5000, 5);
};
const revertIfOpen = () => evaluate(`fetch("api/state").then((r) => r.json()).then((s) => s.control.trial && fetch("api/revert", { method: "POST", headers: { "Content-Type": "application/json", "X-Spark-Console": "1" }, body: "{}" }))`);

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || "exception");
    else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value).join(" "));
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setExtraHTTPHeaders", { headers: { "Tailscale-User-Login": login } });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await setScheme("dark");
  await send("Page.navigate", { url });
  await sleep(4000);
  await revertIfOpen();
  await sleep(1200);

  // --- base checks and the dark theme ---
  check(await evaluate(`document.querySelector("#link").dataset.ok === "1"`), "live stream connected");
  check(await evaluate(`/\\d/.test(document.querySelector("#ch-gpu [data-read]").textContent)`), "GPU read-back shows a number");
  check(await evaluate(`document.querySelectorAll(".readout").length === 6`), "effect rail has 6 readouts");
  check(await evaluate(`document.documentElement.dataset.theme === "auto"`), "theme starts at Auto");
  check(await bodyBg() === "rgb(20, 22, 25)", "Auto + OS dark: dark chassis");
  check(await evaluate(`document.documentElement.dataset.chartTheme === "dark"`), "charts drawn for dark");
  await shot("desktop-top-dark.png", false);
  await evaluate(`document.querySelectorAll("details").forEach((d) => d.open = true)`);
  await sleep(1500);
  check(await evaluate(`document.querySelectorAll("#sensors tr").length > 3`), "sensor table filled");
  check(await evaluate(`document.querySelectorAll("#procs tr").length > 10`), "process table filled");
  await shot("desktop-dark.png");

  // --- stable nodes: focus and node identity survive ticks ---
  await evaluate(`document.querySelector('[data-epp="0"]').focus()`);
  await evaluate(`window.__pf = document.querySelector("#profiles .pf-btn"); window.__row = document.querySelector("#sensors tr")`);
  await sleep(3000);
  check(await evaluate(`document.activeElement === document.querySelector('[data-epp="0"]')`), "focused EPP stop survives 3 ticks");
  check(await evaluate(`window.__pf.isConnected`), "profile button node survives 3 ticks");
  check(await evaluate(`window.__row.isConnected`), "sensor row node survives 3 ticks");
  await evaluate(`document.activeElement.blur()`);

  // --- light theme: OS light, then the toggle forces dark, and a reload keeps it ---
  await setScheme("light");
  await sleep(400);
  check(await bodyBg() === "rgb(233, 235, 238)", "Auto + OS light: light chassis");
  check(await evaluate(`document.documentElement.dataset.chartTheme === "light"`), "charts redrawn for light");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("desktop-top-light.png", false);
  await shot("desktop-light.png");
  await clickTheme("dark");
  await sleep(200);
  check(await bodyBg() === "rgb(20, 22, 25)", "Dark toggle wins over OS light");
  check(await evaluate(`document.querySelector('[data-theme-set="dark"]').getAttribute("aria-pressed") === "true"`), "Dark button is pressed");
  await send("Page.reload");
  await sleep(4000);
  check(await bodyBg() === "rgb(20, 22, 25)" && await evaluate(`document.documentElement.dataset.theme === "dark"`), "Dark survives a reload");
  check(await evaluate(`document.documentElement.dataset.chartTheme === "dark"`), "charts drawn for the forced theme");

  // --- staged state ---
  const epp = await stageTrial();
  check(await mode() === "staged", "changes staged");
  check(await evaluate(`document.querySelector("#ch-gpu").dataset.pending === "1"`), "GPU strip marked staged");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("staged-dark.png", false);

  // --- trial band ---
  check(await startTrial(), "trial running after Apply");
  check(await evaluate(`document.querySelector("#keep").getAttribute("aria-disabled") === "true"`), "Keep is not armed at once");
  await sleep(50);
  const drain = await evaluate(`new DOMMatrix(getComputedStyle(document.querySelector("#drain")).transform).a`);
  check(drain >= 0.9, `drain starts full, not from 0 (${drain.toFixed(3)})`);
  check(await evaluate(`document.activeElement === document.querySelector("#keep")`), "focus moves to Keep after Apply");
  check(await evaluate(`document.querySelector(".commit .chip-trial").innerText.trim() === "TRIAL"`), "filled TRIAL chip");
  check(await evaluate(`(() => { const c = document.querySelector(".countdown"); return c.getAttribute("role") === "timer" && parseFloat(getComputedStyle(c).fontSize) >= 28; })()`), "28 px countdown with role=timer");
  check(await evaluate(`document.querySelector("#ch-gpu").dataset.trial === "1"`), "GPU strip marked as in trial");
  check(await evaluate(`document.querySelector('[data-epp="${epp}"]').classList.contains("is-amber")`), `EPP ${epp} carries the amber bar`);
  await sleep(700);
  check(await evaluate(`document.querySelector("#keep").getAttribute("aria-disabled") === "false"`), "Keep armed after 600 ms");
  check(await evaluate(`document.querySelectorAll(".readout [data-d]:not([hidden])").length === 6`), "every rail readout shows a delta line");

  // --- energy drawer ---
  const tabHits = await evaluate(`(() => { const t = document.querySelector("#ec-tab").getBoundingClientRect();
    return [...document.querySelectorAll(".channel, .readout, .policy")].filter((e) => { const r = e.getBoundingClientRect();
      return !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom); }).length; })()`);
  check(tabHits === 0, "energy tab covers no channel, readout or policy box");
  await sleep(13000); // let the class settle (10 s after Apply + 3 decode samples) so the ticket shows the trial
  await press("e");
  check(await evaluate(`!document.querySelector("#energy").inert && document.querySelector("#ec-tab").getAttribute("aria-expanded") === "true"`), "E opens the drawer");
  check(await evaluate(`document.activeElement === document.querySelector("#energy-h")`), "focus moves to the drawer heading");
  await sleep(500);
  const left = await evaluate(`document.querySelector("#energy").getBoundingClientRect().left`);
  check(Math.abs(left - (1440 - 340)) < 1, `drawer slides in to 1440 − 340 px (${left})`);
  check(await evaluate(`document.querySelectorAll("#ladder li").length === 7`), "ladder has 7 rungs");
  check(await evaluate(`document.querySelectorAll("#trade:not([hidden]) tbody tr").length === 3 || /No decode traffic/.test(document.querySelector("#t-state").textContent)`), "trade table has 3 rows (or the no-decode state)");
  check(await evaluate(`/tok\\/s/.test(document.querySelector("#class-line").textContent) || /No decode/.test(document.querySelector("#t-state").textContent)`), "class line shows tok/s next to the class");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("drawer-dark.png", false);
  await press("Escape");
  await sleep(50);
  check(await evaluate(`document.querySelector("#energy").inert && document.querySelector("#ec-tab").getAttribute("aria-expanded") === "false"`), "Escape closes the drawer");
  check(await evaluate(`document.activeElement === document.querySelector("#ec-tab")`), "focus returns to the tab");
  await sleep(300);
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("trial-dark.png");

  // --- light theme screenshots of the trial and the drawer ---
  await clickTheme("light");
  await sleep(300);
  check(await bodyBg() === "rgb(233, 235, 238)", "Light toggle gives the light chassis");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("trial-light.png");
  await evaluate(`document.querySelector("#ec-tab").click()`);
  check(await evaluate(`document.querySelector("#ec-tab").getAttribute("aria-expanded") === "true"`), "a click on the tab opens the drawer");
  await sleep(500);
  await shot("drawer-light.png", false);
  await evaluate(`document.querySelector("#ec-tab").click()`);
  await sleep(300);
  await clickTheme("dark");

  // --- keys: K keeps, the bar shows the outcome, then goes idle ---
  await evaluate(`document.activeElement.blur()`);
  await press("k");
  check(await waitFor(`document.querySelector("#commit").dataset.mode === "outcome"`, 3000), "K keeps: outcome mode");
  check(await evaluate(`/Kept/.test(document.querySelector("#commit-text").textContent)`), "bar reports Kept");
  check(await evaluate(`document.activeElement === document.querySelector("#commit-text")`), "focus moves to the bar text after Keep");
  await sleep(4500);
  check(await mode() === "idle", "bar returns to idle after the outcome");

  // --- reduced motion: the drawer fades, it does not slide ---
  await setMotion("reduce");
  await press("e");
  await sleep(250);
  const tp = await evaluate(`getComputedStyle(document.querySelector("#energy")).transitionProperty`);
  check(!/transform/.test(tp), `reduced motion: no transform transition (${tp})`);
  await press("Escape");
  await setMotion("no-preference");
  await sleep(300);

  // --- phone ---
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  const wide = await evaluate(`[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 391 && !e.closest(".scroll, .profile-row, .ec")).slice(0, 6).map((e) => e.tagName + "." + e.className + "#" + e.id + " " + Math.round(e.getBoundingClientRect().right)).join(", ")`);
  check(await evaluate(`document.documentElement.scrollWidth <= 390`), `no horizontal overflow at 390 px${wide ? " (wide: " + wide + ")" : ""}`);
  check(await evaluate(`(() => { const r = document.querySelector("#ec-tab").getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.top >= 0 && r.bottom <= 844 && r.height >= 44; })()`), "energy pill visible inside the viewport");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("mobile-top-dark.png", false);
  await shot("mobile-dark.png");
  await clickTheme("light");
  await sleep(300);
  await shot("mobile-top-light.png", false);
  await clickTheme("dark");
  await sleep(300);
  await stageTrial(128);
  check(await startTrial(), "phone: trial running");
  await sleep(800);
  check(await evaluate(`document.documentElement.scrollWidth <= 390 && innerWidth === 390`), "phone: no horizontal overflow in a trial");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("mobile-trial-dark.png", false);
  await evaluate(`document.querySelector("#ec-tab").click()`);
  await sleep(500);
  const sheet = await evaluate(`(() => { const s = document.querySelector("#energy").getBoundingClientRect(), c = document.querySelector("#commit").getBoundingClientRect();
    const hit = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(sel) != null; };
    return { below: s.top >= c.bottom - 0.5, keep: hit("#keep"), revert: hit("#revert") }; })()`);
  check(sheet.below, "phone: the sheet stays below the commit bar");
  check(sheet.keep && sheet.revert, "phone: Keep and Revert stay tappable with the sheet open");
  await shot("mobile-sheet-dark.png", false);
  await shot("mobile-drawer-dark.png", false);
  await evaluate(`document.querySelector("#ec-close").click()`);
  await sleep(1000);
  await evaluate(`document.querySelector("#revert").click()`);
  check(await waitFor(`document.querySelector("#commit").dataset.mode !== "trial"`, 3000), "phone: Revert now ends the trial");

  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  console.log("ui smoke: pass");
  process.exitCode = 0;
} catch (e) {
  console.error(e.message);
  if (errors.length) console.error("console errors:", errors);
  try { await revertIfOpen(); } catch {}
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome.kill();
}
