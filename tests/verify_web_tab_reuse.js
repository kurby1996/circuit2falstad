const assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../static/browser-helper/background.js"), "utf8");
const tabs = new Map(), session = {};
let creates = 0, updates = [];
function worker() {
  const ctx = vm.createContext({ URL, Date, Promise, importScripts() {}, chrome: {
    runtime: { onMessage: { addListener() {} } },
    storage: { session: { get: async () => session, set: async (data) => Object.assign(session, data) } },
    tabs: {
      create: async (opts) => { creates++; assert.equal(opts.active, false); const tab = { id: creates, url: opts.url }; tabs.set(tab.id, tab); return tab; },
      get: async (id) => { if (!tabs.has(id)) throw new Error("Tab closed"); return tabs.get(id); },
      update: async (id, opts) => { assert.equal(opts.active, false); updates.push({ id, ...opts }); const tab = { id, url: opts.url }; tabs.set(id, tab); return tab; },
    },
  } });
  vm.runInContext(source, ctx);
  return ctx;
}
(async () => {
  let ctx = worker();
  const target = new URL("https://chat.deepseek.com/");
  const first = await ctx.reuseBackgroundTab(target);
  // The previous task navigated to a conversation on the same site.
  tabs.get(first.id).url = "https://chat.deepseek.com/a/chat/s/conversation";
  const second = await ctx.reuseBackgroundTab(target);
  assert.equal(first.id, second.id);
  assert.equal(creates, 1);
  assert.equal(updates[0].url, target.href);
  ctx = worker(); // Simulate a service worker restart.
  assert.equal((await ctx.reuseBackgroundTab(target)).id, first.id);
  assert.equal(creates, 1);
  const concurrent = await Promise.all([ctx.reuseBackgroundTab(target), ctx.reuseBackgroundTab(target)]);
  assert.equal(concurrent[0].id, concurrent[1].id);
  assert.equal(creates, 1);
  tabs.delete(first.id);
  const replacement = await ctx.reuseBackgroundTab(target);
  assert.equal(creates, 2);
  tabs.get(replacement.id).url = "https://unrelated.example/";
  const fresh = await ctx.reuseBackgroundTab(target);
  assert.equal(creates, 3);
  assert.notEqual(fresh.id, replacement.id);
  assert.equal(tabs.get(replacement.id).url, "https://unrelated.example/");
  console.log("PASS: sequential and concurrent reuse, worker restart recovery, closed-tab replacement, unrelated-tab preservation, no foreground activation.");
})().catch((err) => { console.error(err); process.exitCode = 1; });
