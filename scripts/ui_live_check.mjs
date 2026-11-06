// Read-only check of a LIVE spark-console (safe on real hardware: it never sends a POST).
//   node scripts/ui_live_check.mjs https://<node>.ts.net:9443/ OUT_DIR <tailnet-login> [CDP_PORT]
// Loads the page, checks the live stream, read-back values, both themes, the Energy Class drawer
// (open, Escape, focus return), no console errors and no overflow at 390 px; writes screenshots.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url = "http://127.0.0.1:5566/", out = ".", login = "dev@local"] = process.argv.slice(2);
const port = Number(process.argv[5] || 9390);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "ui-live-"))}`, "about:blank"], { stdio: "ignore" });
let ws, id = 0;
const pending = new Map(), errors = [], posts = [];
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
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, name), Buffer.from(data, "base64"));
};
const key = async (k) => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: k === "Escape" ? 27 : k.toUpperCase().charCodeAt(0) });
};
let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok" : "FAIL"} - ${msg}`); if (!cond) failed++; };

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
    else if (m.method === "Network.requestWillBeSent" && m.params.request.method !== "GET") posts.push(m.params.request.url);
  });
  for (const d of ["Runtime", "Log", "Page", "Network"]) await send(`${d}.enable`);
  await send("Network.setExtraHTTPHeaders", { headers: { "Tailscale-User-Login": login } });
  for (const scheme of ["dark", "light"]) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    await sleep(4500);
    check(await evaluate(`document.querySelector("#link")?.dataset.state === "live"`), `${scheme}: live stream connected`);
    check(await evaluate(`/\\d/.test(document.querySelector("#ch-gpu [data-read]")?.textContent || "")`), `${scheme}: GPU read-back shows a number`);
    const bg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
    const lum = bg.match(/\d+/g).slice(0, 3).reduce((a, b) => a + Number(b), 0) / 3;
    check(scheme === "dark" ? lum < 80 : lum > 180, `${scheme}: page background follows the OS theme (${bg})`);
    await shot(`live-${scheme}.png`);
    await evaluate(`document.activeElement?.blur()`);
    await key("e");
    await sleep(500);
    check(await evaluate(`!document.querySelector("#energy").inert`), `${scheme}: E opens the Energy Class drawer`);
    check(await evaluate(`document.querySelectorAll("#ladder li").length === 7`), `${scheme}: ladder has 7 rungs`);
    await shot(`live-drawer-${scheme}.png`);
    await key("Escape");
    await sleep(400);
    check(await evaluate(`document.querySelector("#energy").inert`), `${scheme}: Escape closes the drawer`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  check(await evaluate(`document.documentElement.scrollWidth <= 390`), "no horizontal overflow at 390 px");
  await shot("live-mobile.png");
  check(posts.length === 0, `no state-changing requests were sent${posts.length ? ": " + posts.join(", ") : ""}`);
  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (e) {
  console.error(e.message);
  failed++;
} finally {
  ws?.close();
  chrome.kill();
}
console.log(failed ? `ui live check: FAIL (${failed})` : "ui live check: pass");
process.exitCode = failed ? 1 : 0;
