const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../static/browser-helper/bridge.js"), "utf8");
for (const mode of ["invalid_id", "sync_error", "healthy"]) {
  let handler, responses = [];
  const window = { addEventListener(_, fn) { handler = fn; }, postMessage(data) { responses.push(data); } };
  const ctx = vm.createContext({ window, location: { origin: "http://127.0.0.1:8766" }, chrome: { runtime: {
    id: mode === "invalid_id" ? undefined : "helper-id",
    sendMessage(_, callback) { if (mode === "sync_error") throw new Error("Extension context invalidated."); callback({ ok: true }); },
  } } });
  vm.runInContext(source, ctx);
  assert.doesNotThrow(() => handler({ source: window, origin: ctx.location.origin, data: { channel: "circuit2falstad-web-ai-v1", direction: "request", action: "ping", id: "request-1" } }));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, "request-1");
  assert.equal(responses[0].result.ok, mode === "healthy");
  if (mode !== "healthy") assert.equal(responses[0].result.disconnected, true);
  console.log("PASS reconnect bridge:", mode);
}
