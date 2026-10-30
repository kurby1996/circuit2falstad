/* Web page handoff. API credentials are never included in bridge messages. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CHANNEL = "circuit2falstad-web-ai-v1";
  const pending = new Map();
  let available = false;
  let manualMode = false;
  let getImage, getPrompt, onResult, currentTask = null, lastJobId = "";
  const selectorIds = { textSelector: "webAiTextSelector", fileSelector: "webAiFileSelector", sendSelector: "webAiSendSelector", responseSelector: "webAiResponseSelector", attachmentSelector: "webAiAttachmentSelector", busySelector: "webAiBusySelector" };
  const settingsKey = "c2f_web_ai";
  function disconnected(message) {
    available = false;
    $("reconnectWebAiBtn").classList.remove("hidden");
    status(message || "浏览器助手未响应。扩展重新加载后，需要重新连接当前页面。", "warn", true);
  }

  function status(message, kind = "", automaticOnly = false) {
    const el = $(manualMode && !automaticOnly ? "webAiManualStatus" : "webAiStatus");
    el.textContent = message;
    el.className = "status-bar " + kind;
  }
  function targetUrl() {
    const url = new URL($("webAiUrl").value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("请填写不含账号密码的 HTTPS 网页地址。");
    }
    return url.href;
  }
  function save() {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        url: $("webAiUrl").value.trim(),
        ...Object.fromEntries(Object.entries(selectorIds).map(([key, id]) => [key, $(id).value.trim()])),
      }));
    } catch (_) { /* A disabled localStorage must not prevent handoff. */ }
  }
  function request(action, payload = {}, timeout = 2000) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        disconnected("助手通信超时。可点击「保留图片并重新连接」恢复；不会自动重复发送任务。");
        reject(new Error(action === "ping" ? "助手未响应。已安装时请保留图片并重新连接；未安装时请按下方步骤安装。" : "助手通信超时，请保留图片并重新连接。不要重复点击发送，可先查看后台网页。"));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, direction: "request", id, action, ...payload }, location.origin);
    });
  }
  async function openAndFill() {
    if (currentTask) return;
    const task = { cancelled: false, image: getImage(), started: Date.now(), jobId: "" };
    currentTask = task;
    try {
      const url = targetUrl();
      if (!getImage()) throw new Error("请先上传或粘贴电路图片。");
      const connection = await request("ping", {}, 3000);
      if (connection.disconnected) throw new Error(connection.error);
      available = connection.ok === true && connection.automation === true && connection.reuseTab === true;
      if (!available) {
        $("webAiInstallHelp").open = true;
        throw new Error("自动填入需要浏览器助手。请按下方步骤安装；也可使用「仅打开网页」和手动复制。 ");
      }
      save();
      $("openWebAiBtn").disabled = true;
      $("stopWebAiBtn").classList.remove("hidden");
      status("正在后台打开 AI 网页，接下来会自动上传图片并发送提示词…");
      const started = await request("start", {
        url, imageDataUrl: task.image, prompt: getPrompt(),
        ...Object.fromEntries(Object.entries(selectorIds).map(([key, id]) => [key, $(id).value.trim()])),
      }, 10000);
      if (!started.ok) throw new Error(started.error);
      task.jobId = started.jobId; lastJobId = started.jobId;
      $("showWebAiBtn").classList.remove("hidden");
      if (task.cancelled) { await request("cancel", { jobId: task.jobId }); return; }
      while (!task.cancelled) {
        if (Date.now() - task.started > 240000) {
          request("cancel", { jobId: task.jobId }).catch(() => {});
          throw new Error("后台任务超时，已停止接收结果，不会自动重复发送。请查看后台网页。");
        }
        const result = await request("status", { jobId: task.jobId }, 10000);
        if (task.cancelled || currentTask !== task) return;
        if (!result.ok || result.error) throw new Error(result.error || "后台任务失败。");
        if (result.cancelled) return;
        if (result.done) {
          if (getImage() !== task.image) throw new Error("当前图片已更换，已忽略旧任务结果。");
          if (!result.rawText) throw new Error("AI 没有返回电路 JSON。");
          $("pasteJsonInput").value = result.rawText;
          onResult(result.rawText);
          status(`✓ AI 回复已自动返回并生成仿真，用时 ${Math.round((Date.now() - task.started) / 1000)} 秒。`, "success");
          break;
        }
        status(`${result.stage} · ${Math.floor((Date.now() - task.started) / 1000)} 秒`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    } catch (err) {
      if (!task.cancelled) status(err.message, "warn");
    } finally {
      if (currentTask === task) {
        currentTask = null;
        $("openWebAiBtn").disabled = false;
        $("stopWebAiBtn").classList.add("hidden");
      }
    }
  }
  function cancel() {
    const task = currentTask;
    if (!task) return;
    task.cancelled = true;
    if (task.jobId) request("cancel", { jobId: task.jobId }).catch(() => {});
    status("已停止接收结果。网页上已经发送的对话不会撤回，可点击查看后台网页。", "warn");
  }
  function init(options) {
    getImage = options.getImage;
    getPrompt = options.getPrompt;
    onResult = options.onResult;
    $("reconnectWebAiBtn").addEventListener("click", () => {
      cancel();
      try {
        sessionStorage.setItem("c2f_reconnect_image", getImage() || "");
        save();
        location.reload();
      } catch (_) { status("图片较大，无法暂存。请先在手动模式下载当前图片，再刷新页面。", "warn"); }
    });
    try {
      const restore = sessionStorage.getItem("c2f_reconnect_image");
      sessionStorage.removeItem("c2f_reconnect_image");
      if (restore?.startsWith("data:image/")) options.restoreImage(restore);
    } catch (_) {}
    const setWorkflowMode = (manual) => {
      if (manual) cancel();
      manualMode = manual;
      $("webAiAutoPanel").classList.toggle("hidden", manual);
      $("webAiManualPanel").classList.toggle("hidden", !manual);
      $("webAiAutoBtn").classList.toggle("active", !manual);
      $("webAiManualBtn").classList.toggle("active", manual);
      $("webAiAutoBtn").setAttribute("aria-pressed", String(!manual));
      $("webAiManualBtn").setAttribute("aria-pressed", String(manual));
    };
    $("webAiAutoBtn").addEventListener("click", () => setWorkflowMode(false));
    $("webAiManualBtn").addEventListener("click", () => setWorkflowMode(true));
    setWorkflowMode(false);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(settingsKey) || "{}"); } catch (_) {}
    $("webAiUrl").value = saved.url || $("webAiPreset").value;
    for (const [key, id] of Object.entries(selectorIds)) $(id).value = saved[key] || "";
    const syncPreset = () => {
      const value = $("webAiUrl").value.trim();
      $("webAiPreset").value = Array.from($("webAiPreset").options).some((o) => o.value === value) ? value : "custom";
    };
    syncPreset();
    $("webAiPreset").addEventListener("change", () => {
      if ($("webAiPreset").value !== "custom") $("webAiUrl").value = $("webAiPreset").value;
      else $("webAiUrl").focus();
      // Selectors are site-specific; do not carry them across presets.
      for (const id of Object.values(selectorIds)) $(id).value = "";
      save();
    });
    $("webAiUrl").addEventListener("input", () => { syncPreset(); for (const id of Object.values(selectorIds)) $(id).value = ""; save(); });
    for (const id of Object.values(selectorIds)) $(id).addEventListener("input", save);
    $("openWebAiBtn").addEventListener("click", openAndFill);
    $("stopWebAiBtn").addEventListener("click", cancel);
    $("showWebAiBtn").addEventListener("click", async () => {
      try { const result = await request("show", { jobId: lastJobId }); if (!result.ok) throw new Error(result.error); }
      catch (err) { status(err.message, "warn"); }
    });
    $("openWebOnlyBtn").addEventListener("click", () => {
      try { window.open(targetUrl(), "_blank", "noopener,noreferrer"); save(); }
      catch (err) { status(err.message, "error"); }
    });
    $("downloadInputImgBtn").addEventListener("click", () => {
      if (!getImage()) return status("请先上传图片。", "warn");
      const link = document.createElement("a");
      link.href = getImage();
      link.download = /^data:image\/jpe?g/i.test(getImage()) ? "电路图.jpg" : "电路图.png";
      link.click();
    });
    window.addEventListener("message", (event) => {
      const d = event.data;
      if (event.source !== window || event.origin !== location.origin || d?.channel !== CHANNEL || d.direction !== "response") return;
      const entry = pending.get(d.id);
      if (!entry) return;
      if (d.result?.disconnected) disconnected(d.result.error);
      clearTimeout(entry.timer);
      pending.delete(d.id);
      entry.resolve(d.result);
    });
    request("ping").then((result) => {
      if (result.disconnected) { disconnected(result.error); return; }
      available = result.ok === true && result.automation === true && result.reuseTab === true;
      if (available) $("reconnectWebAiBtn").classList.add("hidden");
      status(available ? "✓ 后台识图助手已连接。任务复用同一个后台标签页，不会反复新增网页。" : "请更新到 1.2.0 版助手：重新下载扩展，解压覆盖后在扩展管理页点击重新加载，再刷新本页面。", available ? "success" : "warn", true);
    }).catch((err) => disconnected(err.message));
  }
  window.WebAiTransfer = { init, cancel };
})();
