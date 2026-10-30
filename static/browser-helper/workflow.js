"use strict";
// This function is serialized into the authorized target tab's isolated world.
// It reads only newly generated assistant replies carrying this task's nonce.
async function runWebConversation(options) {
  const { id, origin, selectors: s } = options;
  globalThis.__c2fRuns ||= {};
  const run = { cancelled: false };
  globalThis.__c2fRuns[id] = run;
  const deadline = Date.now() + 180000;
  const visible = (el) => el && el.getClientRects().length > 0;
  const enabled = (el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && !el.classList.contains("ds-button--disabled");
  const query = (selector) => Array.from(document.querySelectorAll(selector));
  const check = () => {
    if (run.cancelled) throw new Error("任务已停止；已发送的网页对话不会撤回。");
    if (location.origin !== origin) throw new Error("网页已跳转，停止自动执行。");
    if (Date.now() >= deadline) throw new Error("等待超过 3 分钟，请查看后台网页；不会自动重复发送。");
  };
  const delay = async (ms = 500) => { await new Promise((resolve) => setTimeout(resolve, ms)); check(); };
  const text = (el) => el.matches("textarea, input") ? el.value : (el.innerText || el.textContent || "");
  const replySelector = s.responseSelector || (location.hostname === "chat.deepseek.com"
    ? ".ds-assistant-message-main-content"
    : '[data-message-author-role="assistant"], [data-role="assistant"], .assistant-message, [data-testid="assistant-message"]');
  const editorSelector = s.textSelector || 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]';
  const findEditor = () => query(editorSelector).filter(visible).filter((e) => e.matches('textarea,input,[contenteditable="true"]')).at(-1);
  const findFile = () => query(s.fileSelector || 'input[type="file"]').find((e) => e.type === "file" && !e.disabled && (!e.accept || /image|\.png|\.jpe?g/i.test(e.accept)));
  const sendSelector = s.sendSelector || (location.hostname === "chat.deepseek.com"
    ? '.ds-button--primary.ds-button--circle'
    : 'button[data-testid="send-button"], button[type="submit"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="发送"], [role="button"][aria-label="发送"]');
  const findSend = () => query(sendSelector).filter(visible).at(-1);
  const busy = () => query(s.busySelector || '[aria-label="Stop generating"], [aria-label="Stop streaming"], [aria-label="停止生成"], [data-testid="stop-button"], [aria-busy="true"], [role="progressbar"]').some(visible);
  try {
    check();
    // Reject invalid selectors before touching the page.
    for (const selector of Object.values(s).filter(Boolean)) query(selector);
    let editor, fileInput;
    const inputDeadline = Date.now() + 20000;
    while (Date.now() < inputDeadline) {
      check(); editor = findEditor(); fileInput = findFile();
      if (editor && fileInput) break;
      await delay();
    }
    if (!editor || !fileInput) throw new Error("未找到输入框或图片上传控件，请先登录，或在适配设置中填写选择器。");
    if (text(editor).trim()) throw new Error("目标输入框已有草稿，已保留原内容。请配置空白新对话地址。");
    const priorReplies = new Map(query(replySelector).map((e) => [e, text(e)]));
    const priorImages = new Set(query("img").map((e) => e.src));
    const suffix = /^data:image\/jpeg/.test(options.imageDataUrl) ? "jpg" : /^data:image\/webp/.test(options.imageDataUrl) ? "webp" : "png";
    const filename = "circuit-" + id + "." + suffix;
    const blob = await (await fetch(options.imageDataUrl)).blob();
    check();
    const files = new DataTransfer();
    files.items.add(new File([blob], filename, { type: blob.type }));
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    // A file input change alone does not establish that a site accepted a file.
    const attached = () => s.attachmentSelector
      ? query(s.attachmentSelector).some(visible)
      : query("img").some((e) => visible(e) && e.complete && e.naturalWidth > 0 &&
        (e.alt === filename || (!priorImages.has(e.src) && /^(blob:|data:image\/)/.test(e.src))));
    const attachmentDeadline = Date.now() + 40000;
    while (!attached() || busy()) {
      if (Date.now() > attachmentDeadline) throw new Error("未确认图片上传就绪，已停止，尚未发送。请检查附件或配置「附件就绪」选择器。");
      await delay();
    }
    editor = findEditor();
    if (!editor || text(editor).trim()) throw new Error("网页输入区已变化，已停止，尚未发送。");
    const prompt = options.prompt + '\n\n本次任务校验：请在最终 JSON 根对象添加 "_c2f_request_id": "' + id + '"。只输出本次图片的完整电路 JSON，不要输出思考过程。';
    editor.focus();
    if (editor.matches("textarea,input")) {
      const proto = editor.matches("textarea") ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(editor, prompt);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand("insertText", false, prompt)) throw new Error("网页拒绝自动输入提示词。");
    }
    await delay(600);
    if (!text(findEditor() || editor).includes(id)) throw new Error("网页未保留本次提示词，已停止，尚未发送。");
    const sendDeadline = Date.now() + 20000;
    let readyAt = 0;
    while (Date.now() < sendDeadline) {
      check();
      if (enabled(findSend()) && attached() && !busy()) {
        readyAt ||= Date.now();
        if (Date.now() - readyAt >= 1500) break;
      } else readyAt = 0;
      await delay();
    }
    const send = findSend();
    if (!readyAt || Date.now() - readyAt < 1500 || !enabled(send) || !attached() || busy()) throw new Error("发送按钮未就绪，尚未发送。请检查上传状态或配置发送按钮选择器。");
    check();
    send.click(); // Exactly once. A timeout never causes a second submission.
    let candidate = "", stableAt = 0;
    while (true) {
      await delay(750);
      let found = "";
      for (const node of query(replySelector)) {
        const reply = text(node);
        if (priorReplies.get(node) === reply || !reply.includes(id) || reply.length > 500000) continue;
        const blocks = Array.from(reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), (m) => m[1]);
        blocks.push(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
        for (const block of blocks) {
          try {
            const parsed = JSON.parse(block);
            if (parsed._c2f_request_id === id && Array.isArray(parsed.components) && parsed.components.length > 0 &&
              parsed.components.every((c) => c && typeof c.type === "string" && c.pins && typeof c.pins === "object")) {
              delete parsed._c2f_request_id;
              found = JSON.stringify(parsed);
            }
          } catch (_) { /* Streaming reply is incomplete, keep waiting. */ }
        }
      }
      if (found !== candidate) { candidate = found; stableAt = Date.now(); }
      // Only accept complete, stable, task-correlated JSON after generation stops.
      if (candidate && !busy() && Date.now() - stableAt >= 3000) return { ok: true, rawText: candidate };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    delete globalThis.__c2fRuns[id];
  }
}
