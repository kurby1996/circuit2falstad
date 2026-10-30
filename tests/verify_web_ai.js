// Exercise extension boundaries and upload events without a real account/site.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../static/browser-helper/background.js"), "utf8");
let listener, permission = true, injected = 0, created = 0, editorValue = "";
const events = [];
class Input {
  get value() { return editorValue; }
  set value(v) { editorValue = v; }
  matches(s) { return s.includes("textarea"); }
  getClientRects() { return [1]; }
  getAttribute() { return null; }
  focus() {}
  dispatchEvent(e) { events.push("text:" + e.type); }
}
const editor = new Input();
const fileInput = { type: "file", accept: "image/*", dispatchEvent(e) { events.push("file:" + e.type); } };
const context = vm.createContext({
  URL, Date, setTimeout, Event, location: { origin: "https://example.com" },
  HTMLTextAreaElement: Input, HTMLInputElement: Input,
  File: class { constructor(parts, name, opts) { this.name = name; this.type = opts.type; } },
  DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
  fetch: async () => ({ blob: async () => ({ type: "image/png" }) }),
  document: { querySelectorAll: (selector) => selector.includes("file") ? [fileInput] : [editor] },
  chrome: {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    permissions: { contains: async () => permission },
    tabs: {
      create: async () => { created++; return { id: 9 }; },
      get: async () => ({ status: "complete", url: "https://example.com/chat" }),
    },
    scripting: { executeScript: async ({ func, args }) => { injected++; return [{ result: await func(...args) }]; } },
  },
});
vm.runInContext(source, context);
const local = { url: "http://127.0.0.1:8765/", tab: { id: 1 } };
const image = "data:image/png;base64,AAAA";
function send(data, sender = local) {
  return new Promise((resolve) => { if (!listener(data, sender, resolve)) resolve(undefined); });
}
(async () => {
  assert.equal(await send({ action: "open" }, { url: "https://evil.example/", tab: { id: 1 } }), undefined);
  assert.equal((await send({ action: "ping" })).ok, true);
  const base = { action: "open", url: "https://example.com/chat", prompt: "Identify circuit", imageDataUrl: image };
  let result = await send({ ...base, url: "javascript:alert(1)" });
  assert.equal(result.ok, false);
  assert.equal(created, 0);
  permission = false;
  result = await send(base);
  assert.equal(result.ok, false);
  assert.equal(created, 0);
  permission = true;
  result = await send(base);
  assert.equal(result.ok, true);
  assert.equal(editorValue, base.prompt);
  assert.equal(fileInput.files[0].type, "image/png");
  assert.deepEqual(events, ["text:input", "text:change", "file:input", "file:change"]);
  assert.equal(injected, 1);
  events.length = 0;
  result = await send(base);
  assert.equal(result.ok, false); // Preserve a nonempty draft.
  assert.deepEqual(events, []);
  assert.equal(editorValue, base.prompt);
  console.log("PASS: local-only bridge, HTTPS validation, per-site permission, prompt + image events, existing draft preservation.");
})().catch((err) => { console.error(err); process.exitCode = 1; });
