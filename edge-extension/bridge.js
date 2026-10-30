"use strict";
window.addEventListener("message", (event) => {
  const d = event.data;
  if (event.source !== window || event.origin !== location.origin || d?.channel !== "circuit2falstad-web-ai-v1" || d.direction !== "request") return;
  if (!["ping", "open", "start", "status", "cancel", "show"].includes(d.action) || typeof d.id !== "string") return;
  const respond = (result) => window.postMessage({ channel: d.channel, direction: "response", id: d.id, result }, location.origin);
  try {
    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
    chrome.runtime.sendMessage({
    action: d.action, url: d.url, imageDataUrl: d.imageDataUrl,
    prompt: d.prompt, jobId: d.jobId, textSelector: d.textSelector, fileSelector: d.fileSelector,
    sendSelector: d.sendSelector, responseSelector: d.responseSelector,
    attachmentSelector: d.attachmentSelector, busySelector: d.busySelector,
  }, (result) => {
    const error = chrome.runtime.lastError;
    respond(error ? { ok: false, disconnected: true, error: "浏览器助手连接已失效，请保留图片并重新连接。" } : result);
  });
  } catch (_) {
    // A reloaded extension leaves old content scripts in existing pages.
    respond({ ok: false, disconnected: true, error: "扩展已重新加载，当前页面仍使用旧连接。请保留图片并重新连接。" });
  }
});
