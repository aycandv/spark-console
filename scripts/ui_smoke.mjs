// UI smoke check through the Chrome DevTools Protocol (Node >= 22, google-chrome).
// Run against a server started with --simulate --bind 127.0.0.1 --port 5567 --owner dev@local:
//   node scripts/ui_smoke.mjs http://127.0.0.1:5567/ OUT_DIR dev@local
// It loads the page, stages a change, applies it, keeps it, checks for console errors,
// and writes desktop.png, trial.png and mobile.png to OUT_DIR. Exit code 1 on any failure.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:5566/";
const out = process.argv[3] || ".";
const login = process.argv[4] || "dev@local"; // sent as Tailscale-User-Login, like tailscale serve does
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await send("Page.navigate", { url });
  await sleep(4000);
  await shot("desktop-top.png", false);

  check(await evaluate(`document.querySelector("#link").dataset.ok === "1"`), "live stream connected");
  check(await evaluate(`/\\d/.test(document.querySelector("#ch-gpu [data-read]").textContent)`), "GPU read-back shows a number");
  check(await evaluate(`document.querySelectorAll(".readout").length === 6`), "effect rail has 6 readouts");
  await evaluate(`document.querySelectorAll("details").forEach((d) => d.open = true)`);
  await sleep(1500);
  check(await evaluate(`document.querySelectorAll("#sensors tr").length > 3`), "sensor table filled");
  check(await evaluate(`document.querySelectorAll("#procs tr").length > 10`), "process table filled");
  await shot("desktop.png");

  // Stage: GPU cap one step down, EPP 192. Then apply, check the trial, keep.
  await evaluate(`document.querySelector('#ch-gpu [data-step="-1"]').click()`);
  await evaluate(`document.querySelector('[data-epp="192"]').click()`);
  check(await evaluate(`document.querySelector("#commit").dataset.mode === "staged"`), "changes staged");
  await evaluate(`document.querySelector("#apply").click()`);
  await sleep(2500);
  check(await evaluate(`document.querySelector("#commit").dataset.mode === "trial"`), "trial running after Apply");
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("trial.png");
  await evaluate(`document.querySelector("#keep").click()`);
  await sleep(2000);
  check(await evaluate(`document.querySelector("#commit").dataset.mode === "idle"`), "trial closed after Keep");
  check(await evaluate(`/Kept/.test(document.querySelector("#commit-text").textContent)`), "bar reports Kept");

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  const wide = await evaluate(`[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 391 && !e.closest(".scroll")).slice(0, 6).map((e) => e.tagName + "." + e.className + "#" + e.id + " " + Math.round(e.getBoundingClientRect().right)).join(", ")`);
  check(await evaluate(`document.documentElement.scrollWidth <= 390`), `no horizontal overflow at 390 px${wide ? " (wide: " + wide + ")" : ""}`);
  await evaluate(`window.scrollTo(0, 0)`);
  await shot("mobile-top.png", false);
  await shot("mobile.png");

  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  console.log("ui smoke: pass");
  process.exitCode = 0;
} catch (e) {
  console.error(e.message);
  if (errors.length) console.error("console errors:", errors);
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome.kill();
}
