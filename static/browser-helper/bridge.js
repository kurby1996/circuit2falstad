"use strict";
window.addEventListener("message", (event) => {
  const d = event.data;
  if (event.source !== window || event.origin !== location.origin || d?.channel !== "circuit2falstad-web-ai-v1" || d.direction !== "request") return;
  if (!["ping", "open"].includes(d.action) || typeof d.id !== "string") return;
  chrome.runtime.sendMessage({
    action: d.action, url: d.url, imageDataUrl: d.imageDataUrl,
    prompt: d.prompt, textSelector: d.textSelector, fileSelector: d.fileSelector,
  }, (result) => {
    const error = chrome.runtime.lastError;
    window.postMessage({
      channel: d.channel, direction: "response", id: d.id,
      result: error ? { ok: false, error: "扩展已更新或断开，请刷新本工具页面。" } : result,
    }, location.origin);
  });
});
