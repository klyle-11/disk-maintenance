// Drive the Tauri app end to end over WebDriver: scan, findings, types, save a
// snapshot, compare, dhm, di, and the confirmation for a destructive di command.
//
//   cargo install tauri-driver            # once; Linux also needs WebKitWebDriver
//   tauri-driver &                        # listens on :4444
//   DISK_INTELLIGENCE_DB=/tmp/e2e.db node scripts/e2e-tauri.mjs <app binary> [screenshot dir]
//
// Linux only (tauri-driver has no macOS driver). Under Xvfb set DISPLAY. The
// destructive-command check needs xdotool to answer the native dialog, and the
// screenshots need ImageMagick's `import`; each is skipped when missing.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.argv[2];
if (!APP) {
  console.error("usage: node scripts/e2e-tauri.mjs <app binary> [screenshot dir]");
  process.exit(2);
}
const SHOTS = process.argv[3] ?? mkdtempSync(join(tmpdir(), "di-e2e-shots-"));
const WD = "http://127.0.0.1:4444";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (tool) => {
  try {
    execSync(`command -v ${tool}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const shoot = (name) => has("import") && execSync(`import -window root ${join(SHOTS, name)}`);

// Two small folders that differ, for the comparison.
const FIX = mkdtempSync(join(tmpdir(), "di-e2e-"));
const put = (path, text) => {
  mkdirSync(dirname(join(FIX, path)), { recursive: true });
  writeFileSync(join(FIX, path), text);
};
put("cmpA/README.md", "a\n");
put("cmpA/docs/api.md", "api\n");
put("cmpA/src/lib/x.ts", "same\n");
put("cmpB/README.md", "bb\n");
put("cmpB/assets/logo.png", "1234");
put("cmpB/src/lib/x.ts", "same\n");

async function wd(method, path, body) {
  const res = await fetch(WD + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return json.value;
}

const session = await wd("POST", "/session", {
  capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP } } },
});
const S = `/session/${session.sessionId}`;
const js = (script, ...args) => wd("POST", `${S}/execute/sync`, { script, args });
const find = async (css) => (await wd("POST", `${S}/element`, { using: "css selector", value: css }))[ELEMENT];
const click = async (css) => wd("POST", `${S}/element/${await find(css)}/click`, {});
const type = async (css, text) => {
  const el = await find(css);
  await wd("POST", `${S}/element/${el}/clear`, {});
  await wd("POST", `${S}/element/${el}/value`, { text });
};
async function waitFor(what, script, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await js(script);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const text = (css) => js(`const e = document.querySelector(${JSON.stringify(css)}); return e ? e.innerText : null;`);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

try {
  await waitFor("windows", "return document.querySelectorAll('.wm-window').length > 0");
  const tauri = await js("return '__TAURI_INTERNALS__' in window");
  check("runs inside Tauri", tauri);
  const state = await waitFor("backend ready", "const e = document.querySelector('.status-state'); return e && e.textContent === 'READY' ? e.textContent : null");
  check("backend READY (health over IPC)", state === "READY");

  // Tips come from the Rust core.
  await waitFor("tips", "return document.querySelector('.kind-tip, .kind-tips') !== null || document.body.innerText.includes('FREE')", 10000).catch(() => {});
  const status = await text(".kind-status");
  check("free space shown", /FREE/.test(status ?? ""), (status ?? "").split("\n").find((l) => /FREE/.test(l)) ?? "");

  // Scan a folder.
  await click(".controls button.is-primary"); // SCAN
  await waitFor("scan window", "return document.querySelector('input[aria-label=\"Folder to scan\"]')");
  await type('input[aria-label="Folder to scan"]', join(REPO, "frontend", "src"));
  await click(".kind-scan button.is-primary");
  await waitFor("scan results", "return document.querySelector('.kind-scan .readout-big')", 60000);
  const readout = await text(".kind-scan .readout");
  check("scan completes", /files/.test(readout), readout.replace(/\n/g, " | "));

  // Findings and types open beside the scan by themselves.
  await waitFor("types window", "return document.querySelector('.kind-types')");
  await waitFor("findings window", "return document.querySelector('.kind-findings')");
  await sleep(1200);
  const types = await text(".kind-types");
  check("file types listed", /\.tsx|\.ts|\.css/.test(types ?? ""), (types ?? "").split("\n").slice(0, 6).join(" | "));
  check("findings window opens", !!(await text(".kind-findings")));
  shoot("scan.png");

  // Save as a snapshot; it shows up in the library.
  const before = await js("return document.querySelectorAll('.library-row').length");
  await js("[...document.querySelectorAll('.kind-scan button')].find(b => b.innerText.trim() === 'SAVE').click()");
  await waitFor("saved", "return document.querySelector('.kind-scan') && /saved /.test(document.querySelector('.kind-scan').innerText)", 30000);
  const libOpen = await js("return !!document.querySelector('.kind-library')");
  if (!libOpen) await js("[...document.querySelectorAll('.controls button')].find(b => b.innerText.includes('LIBRARY'))?.click()");
  await waitFor("library row", `return document.querySelectorAll('.library-row').length > ${before}`, 15000);
  check("snapshot saved to the shared database", true, `${before} -> ${await js("return document.querySelectorAll('.library-row').length")} rows`);

  // Compare two folders.
  await js("[...document.querySelectorAll('.controls button')].find(b => b.innerText.trim() === 'COMPARE').click()");
  await waitFor("compare window", "return document.querySelector('input[aria-label=\"source folder\"]')");
  await type('input[aria-label="source folder"]', join(FIX, "cmpA"));
  await type('input[aria-label="target folder"]', join(FIX, "cmpB"));
  await click(".kind-compare button.is-primary");
  await waitFor("compare result", "return /\\d+ diff/.test(document.querySelector('.kind-compare')?.innerText ?? '')", 30000);
  const cmp = await text(".kind-compare");
  const pair = await js("return document.querySelectorAll('.kind-cmp-pair').length");
  check("compare completes with its source/target pair", pair === 2, (cmp ?? "").split("\n").slice(0, 2).join(" | ") + ` · ${pair} pair windows`);

  // dhm streams folder sizes.
  if (!(await js("return !!document.querySelector('.kind-dhm')"))) {
    await js("[...document.querySelectorAll('.controls button')].find(b => b.innerText.includes('DHM')).click()");
  }
  await waitFor("dhm window", "return document.querySelector('.kind-dhm input[aria-label=\"Folder\"]')");
  await type('.kind-dhm input[aria-label="Folder"]', REPO);
  await click(".kind-dhm button.is-primary");
  await waitFor("dhm total", "return /Total: .* files/.test(document.querySelector('.kind-dhm-out')?.innerText ?? '')", 60000);
  const dhm = await text(".kind-dhm-out");
  check("dhm lists folders", /frontend/.test(dhm) && /backend/.test(dhm), (dhm ?? "").split("\n").filter((l) => /Total:/.test(l)).join(""));

  // di runs the real CLI and streams its output.
  if (!(await js("return !!document.querySelector('.di-prompt input')"))) {
    await js("[...document.querySelectorAll('.controls button')].find(b => b.innerText.trim() === 'DI').click()");
  }
  await waitFor("di prompt", "return document.querySelector('.di-prompt input')");
  await type(".di-prompt input", "tips\uE007");
  await waitFor("di output", "return /exit 0|EXIT 0|\\b0\\b.*s/.test(document.querySelector('.kind-di')?.innerText ?? '') && (document.querySelector('.kind-di')?.innerText ?? '').length > 400", 60000).catch(() => null);
  const di = await text(".kind-di");
  check("di tips runs", (di ?? "").length > 400, (di ?? "").split("\n").filter(Boolean).slice(-3).join(" | "));

  // A destructive command asks first, in a native dialog; back out of it.
  if (has("xdotool")) {
    await type(".di-prompt input", "clean --yes\uE007");
    let dialog = "";
    for (let i = 0; i < 40 && !dialog; i++) {
      await sleep(250);
      try {
        dialog = execSync("xdotool search --onlyvisible --name '^Disk Intelligence$'").toString().trim().split("\n").pop();
      } catch {}
    }
    if (dialog) {
      shoot("confirm.png");
      execSync(`xdotool windowfocus --sync ${dialog} key --clearmodifiers Escape`);
    }
    const notRun = await waitFor("not run note", "return /not run/.test(document.querySelector('.kind-di')?.innerText ?? '')", 10000).catch(() => false);
    check("destructive di command asks first (native dialog), cancel = not run", !!dialog && !!notRun, dialog ? `dialog window ${dialog}` : "no dialog seen");
  } else console.log("SKIP  destructive di command (no xdotool)");

  // Click-through regions were reported.
  const windows = await js("return document.querySelectorAll('.wm-window').length");
  check("windows on screen", windows > 4, `${windows} windows`);

  await sleep(800);
  shoot("final.png");
  writeFileSync(join(SHOTS, "final-webview.png"), Buffer.from(await wd("GET", `${S}/screenshot`), "base64"));
} catch (err) {
  console.error("ERROR", err.message);
  results.push({ name: "error", ok: false });
  try {
    shoot("error.png");
  } catch {}
} finally {
  await wd("DELETE", S).catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
