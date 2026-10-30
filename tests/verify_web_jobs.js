const assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
let listener, resolveScript, tabOptions;
const ctx = vm.createContext({
  URL, Date, crypto: { randomUUID: () => "job-123" }, setTimeout, importScripts() {},
  runWebConversation() {},
  chrome: {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    permissions: { contains: async () => true },
    tabs: { create: async (opts) => { tabOptions = opts; return { id: 99 }; }, get: async () => ({ status: "complete", url: "https://example.com/" }) },
    scripting: { executeScript: async ({ args }) => {
      if (args.length === 1 && typeof args[0] === "string") return []; // Cancellation injection.
      return new Promise((resolve) => { resolveScript = resolve; });
    } },
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../static/browser-helper/background.js"), "utf8"), ctx);
const local = { url: "http://127.0.0.1:8766/", tab: { id: 1 } };
function send(message, sender = local) { return new Promise((resolve) => { if (!listener(message, sender, resolve)) resolve(undefined); }); }
(async () => {
  assert.equal((await send({ action: "ping" })).automation, true);
  const started = await send({ action: "start", url: "https://example.com/", prompt: "Read circuit", imageDataUrl: "data:image/png;base64,AAAA" });
  assert.equal(started.jobId, "job-123");
  for (let i = 0; i < 20 && !resolveScript; i++) await Promise.resolve();
  assert.equal(tabOptions.active, false);
  assert.equal((await send({ action: "status", jobId: started.jobId }, { ...local, tab: { id: 2 } })).ok, false);
  assert.equal((await send({ action: "start" })).ok, false); // No concurrent submissions from the same workbench.
  await send({ action: "cancel", jobId: started.jobId });
  resolveScript([{ result: { ok: true, rawText: "late-result" } }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const status = await send({ action: "status", jobId: started.jobId });
  assert.equal(status.cancelled, true);
  assert.equal(status.rawText, undefined); // Late result cannot overwrite cancellation.
  console.log("PASS jobs: background tab, task ownership, duplicate start rejection, cancellation and late-result discard.");
})().catch((err) => { console.error(err); process.exitCode = 1; });
