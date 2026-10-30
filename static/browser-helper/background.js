"use strict";
importScripts("workflow.js");
const WEB_JOBS = new Map();
// Only local-workbench tabs can initiate a transfer. No API config is read.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  let source;
  try { source = new URL(sender.url); } catch (_) { return false; }
  if (source.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(source.hostname) || !sender.tab) return false;
  if (message.action === "ping") { reply({ ok: true, version: "1.1.0", automation: true }); return false; }
  if (message.action === "start") {
    for (const [id, job] of WEB_JOBS) {
      if (Date.now() - job.created > 600000 && job.done) WEB_JOBS.delete(id);
      if (job.source === sender.tab.id && !job.done) {
        reply({ ok: false, error: "已有后台任务，请先停止或等待完成。" }); return false;
      }
    }
    const id = crypto.randomUUID();
    const job = { id, source: sender.tab.id, created: Date.now(), stage: "准备后台任务", done: false, cancelled: false };
    WEB_JOBS.set(id, job);
    automate(message, job).catch((err) => {
      if (!job.cancelled) { job.error = err.message; job.stage = "任务失败"; job.done = true; }
    });
    reply({ ok: true, jobId: id });
    return false;
  }
  if (["status", "cancel", "show"].includes(message.action)) {
    const job = WEB_JOBS.get(message.jobId);
    if (!job || job.source !== sender.tab.id) { reply({ ok: false, error: "任务不存在或扩展已重启，请重新开始。" }); return false; }
    if (message.action === "show") {
      if (!job.tabId) { reply({ ok: false, error: "目标网页尚未打开。" }); return false; }
      chrome.tabs.update(job.tabId, { active: true }).then(() => reply({ ok: true })).catch((err) => reply({ ok: false, error: err.message }));
      return true;
    }
    if (message.action === "cancel") {
      job.cancelled = true; job.done = true; job.stage = "已停止接收结果";
      if (job.tabId) chrome.scripting.executeScript({ target: { tabId: job.tabId }, func: (id) => { if (globalThis.__c2fRuns?.[id]) globalThis.__c2fRuns[id].cancelled = true; }, args: [job.id] }).catch(() => {});
      reply({ ok: true }); return false;
    }
    reply({ ok: true, done: job.done, stage: job.stage, error: job.error, cancelled: job.cancelled, rawText: job.rawText });
    return false;
  }
  if (message.action !== "open") return false;
  transfer(message).then(reply).catch((err) => reply({ ok: false, error: err.message }));
  return true;
});

async function automate(data, job) {
  const url = new URL(data.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("仅支持 HTTPS AI 网页。");
  if (typeof data.prompt !== "string" || !data.prompt || data.prompt.length > 100000) throw new Error("提示词为空或过长。");
  if (typeof data.imageDataUrl !== "string" || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(data.imageDataUrl) || data.imageDataUrl.length > 16000000) throw new Error("图片格式无效或过大。");
  if (!await chrome.permissions.contains({ origins: [url.origin + "/*"] })) throw new Error("请在扩展图标中授权 " + url.origin + " 后重试。");
  if (job.cancelled) return;
  const tab = await chrome.tabs.create({ url: url.href, active: false });
  job.tabId = tab.id;
  job.stage = "后台网页加载中";
  const deadline = Date.now() + 30000;
  let loaded = false;
  while (Date.now() < deadline) {
    if (job.cancelled) return;
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") {
      if (new URL(current.url).origin !== url.origin) throw new Error("网页跳转到了其他站点，请先登录目标网站后重试。");
      loaded = true; break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!loaded) throw new Error("网页加载超时，可点击「查看后台网页」检查登录状态。");
  if (job.cancelled) return;
  job.stage = "自动上传、发送并等待 AI 回复（最多 3 分钟）";
  const selectors = {};
  for (const key of ["textSelector", "fileSelector", "sendSelector", "responseSelector", "attachmentSelector", "busySelector"]) {
    if (data[key] && (typeof data[key] !== "string" || data[key].length > 2000)) throw new Error("适配选择器无效。");
    selectors[key] = data[key] || "";
  }
  const result = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: runWebConversation,
    args: [{ id: job.id, origin: url.origin, prompt: data.prompt, imageDataUrl: data.imageDataUrl, selectors }],
  }))[0]?.result;
  if (job.cancelled) return;
  if (!result?.ok) throw new Error(result?.error || "网页未返回有效结果。");
  job.rawText = result.rawText;
  job.done = true; job.stage = "已收到 AI 结果";
}

async function transfer(data) {
  const url = new URL(data.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("仅支持 HTTPS AI 网页。");
  if (typeof data.prompt !== "string" || !data.prompt || data.prompt.length > 100000) throw new Error("提示词为空或过长。");
  if (typeof data.imageDataUrl !== "string" || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(data.imageDataUrl) || data.imageDataUrl.length > 16000000) throw new Error("图片格式无效或超过 12 MB，请重新上传较小的图片。");
  const origin = url.origin + "/*";
  if (!await chrome.permissions.contains({ origins: [origin] })) {
    throw new Error("请点击浏览器工具栏的「Circuit2Falstad 网页填入助手」，填写 " + url.origin + " 并授权，然后重试。");
  }
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  // Bound wait; never replay a transfer into an unrelated redirected site.
  const deadline = Date.now() + 25000;
  let loaded = false;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") {
      if (new URL(current.url).origin !== url.origin) throw new Error("网页跳转到了其他站点。请先登录，并将目标地址改为最终 AI 对话页后重试。");
      loaded = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!loaded) throw new Error("目标网页加载超时。请查看新标签页，登录后重试。");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: fillComposer,
    args: [data.prompt, data.imageDataUrl, data.textSelector || "", data.fileSelector || "", url.origin],
  });
  return results[0]?.result || { ok: false, error: "目标网页未返回填入结果。" };
}

// Executed in the target tab's isolated world. Never click a send/submit button.
async function fillComposer(prompt, imageDataUrl, textSelector, fileSelector, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, error: "网页地址已变化，已取消填入。请检查目标地址后重试。" };
  const visible = (el) => el.getClientRects().length > 0 && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const findEditor = () => Array.from(document.querySelectorAll(textSelector || 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'))
    .filter(visible).filter((el) => el.matches('textarea, input, [contenteditable="true"]')).at(-1);
  const findFile = () => Array.from(document.querySelectorAll(fileSelector || 'input[type="file"]'))
    .filter((el) => el.type === "file" && !el.disabled)
    .find((el) => !el.accept || /image|\.png|\.jpe?g|\.webp/i.test(el.accept));
  const until = Date.now() + 20000;
  let editor, fileInput;
  try {
    while (Date.now() < until) {
      editor = findEditor();
      fileInput = findFile();
      if (editor && fileInput) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  } catch (_) { return { ok: false, error: "自定义 CSS 选择器无效，请在工作台修改。" }; }
  if (!editor) return { ok: false, error: "未找到对话输入框，请先登录目标网页，或配置输入框 CSS 选择器后重试。" };
  if (!fileInput) return { ok: false, error: "未找到图片上传控件。请先展开目标网页的上传菜单，或配置图片控件选择器。提示词和图片均未填入。" };
  const existing = editor.matches("textarea, input") ? editor.value : editor.textContent;
  if (existing.trim()) return { ok: false, error: "目标输入框已有内容，已保留原内容。请使用空白新对话重试。" };
  try {
    editor.focus();
    if (editor.matches("textarea, input")) {
      const proto = editor.matches("textarea") ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(editor, prompt);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      // Preserve editor-managed structure (ProseMirror / Lexical).
      if (!document.execCommand("insertText", false, prompt)) throw new Error("网页输入框拒绝自动输入");
    }
    const actual = editor.matches("textarea, input") ? editor.value : editor.textContent;
    if (!actual.trim()) throw new Error("网页未保留提示词");
    const blob = await (await fetch(imageDataUrl)).blob();
    const ext = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1];
    const files = new DataTransfer();
    files.items.add(new File([blob], "电路图." + ext, { type: blob.type }));
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, complete: false, message: "提示词已填入，图片已交给网页上传控件。请在目标页确认图片缩略图出现、上传完成后点击发送；AI 回复仍需复制回本工具。" };
  } catch (err) {
    return { ok: false, error: "自动填入未完成：" + err.message + "。请检查目标页，可能已填入部分内容，可手动补充图片或提示词。" };
  }
}
