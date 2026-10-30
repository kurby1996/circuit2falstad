const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const workflow = fs.readFileSync(path.join(__dirname, "../static/browser-helper/workflow.js"), "utf8");
const compiler = fs.readFileSync(path.join(__dirname, "../static/compiler.js"), "utf8");

async function scenario(mode) {
  let now = 0, value = "", sends = 0, upload = false, context;
  const id = "test-task-1234";
  class Editor {
    get value() { return value; }
    set value(v) { value = v; }
    matches() { return true; }
    getClientRects() { return [1]; }
    focus() {}
    dispatchEvent() {}
  }
  const ready = { getClientRects: () => [1], getAttribute: () => null, classList: { contains: () => false } };
  const editor = new Editor();
  const send = { ...ready, click() { sends++; value = ""; } };
  const img = { ...ready, complete: true, naturalWidth: 100, src: "blob:task-img", alt: "" };
  const file = { type: "file", accept: "image/png", dispatchEvent(e) { if (e.type === "change") upload = true; } };
  const circuit = { _c2f_request_id: mode === "wrong_nonce" ? "old-task" : id, title: "自动识图测试", components: [
    { id: "V1", type: "dc_rail", voltage: 5, gx: 1, gy: 1, pins: { out: "VCC" } },
    { id: "R1", type: "resistor", value: "1k", gx: 4, gy: 1, pins: { p1: "VCC", p2: "GND" } },
    { id: "G1", type: "ground", gx: 7, gy: 1, pins: { gnd: "GND" } },
  ] };
  const reply = { matches: () => false, get innerText() { return now > 6000 ? "```json\n" + JSON.stringify(circuit) + "\n```" : '{"components":['; } };
  const oldReply = { matches: () => false, innerText: JSON.stringify({ ...circuit, _c2f_request_id: "previous" }) };
  context = vm.createContext({
    console, location: { origin: "https://chat.deepseek.com", hostname: "chat.deepseek.com" },
    Date: { now: () => now }, Event, HTMLTextAreaElement: Editor, HTMLInputElement: Editor,
    setTimeout(fn, ms) { now += ms; if (mode === "cancel" && now > 4000) context.__c2fRuns[id].cancelled = true; fn(); },
    fetch: async () => ({ blob: async () => ({ type: "image/png" }) }),
    File: class {}, DataTransfer: class { constructor() { this.files = []; this.items = { add: (f) => this.files.push(f) }; } },
    document: { querySelectorAll(selector) {
      if (selector.startsWith("textarea")) return [editor];
      if (selector === 'input[type="file"]') return [file];
      if (selector === "img") return upload && mode !== "no_attachment" ? [img] : [];
      if (selector === ".ds-button--primary.ds-button--circle") return mode === "no_send" ? [] : [send];
      if (selector === ".ds-assistant-message-main-content") return sends ? [oldReply, reply] : [oldReply];
      return [];
    } },
  });
  if (mode === "draft") value = "existing draft";
  vm.runInContext(workflow, context);
  const result = await context.runWebConversation({ id, origin: "https://chat.deepseek.com", selectors: {}, imageDataUrl: "data:image/png;base64,AAAA", prompt: "Read circuit" });
  assert.equal(Object.keys(context.__c2fRuns).length, 0);
  if (mode === "success") {
    assert.equal(result.ok, true);
    assert.equal(sends, 1);
    const ir = JSON.parse(result.rawText);
    assert.equal(ir._c2f_request_id, undefined);
    // Verify the real downstream compiler produces a circuit and a diagram.
    const c = vm.createContext({ console });
    vm.runInContext(compiler, c);
    const compiled = c.CircuitCompiler.compile(c.CircuitCompiler.normalizeIr(ir));
    assert.match(compiled.circuitText, /^\$/);
    assert.match(compiled.svgHtml, /<svg/);
    assert.equal(compiled.stats.componentCount, 3);
  } else {
    assert.equal(result.ok, false, mode);
    assert.ok(sends <= 1, "never duplicate a submission");
    if (["no_attachment", "no_send", "draft"].includes(mode)) assert.equal(sends, 0);
    if (mode === "draft") assert.equal(value, "existing draft");
  }
  return mode;
}
(async () => {
  for (const mode of ["success", "wrong_nonce", "no_attachment", "no_send", "draft", "cancel"]) console.log("PASS automation:", await scenario(mode));
})().catch((err) => { console.error(err); process.exitCode = 1; });
