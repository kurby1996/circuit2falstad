/* Web page handoff. API credentials are never included in bridge messages. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CHANNEL = "circuit2falstad-web-ai-v1";
  const pending = new Map();
  let available = false;
  let getImage, getPrompt;
  const settingsKey = "c2f_web_ai";

  function status(message, kind = "") {
    $("webAiStatus").textContent = message;
    $("webAiStatus").className = "status-bar " + kind;
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
        textSelector: $("webAiTextSelector").value.trim(),
        fileSelector: $("webAiFileSelector").value.trim(),
      }));
    } catch (_) { /* A disabled localStorage must not prevent handoff. */ }
  }
  function request(action, payload = {}, timeout = 2000) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(action === "ping" ? "尚未检测到自动填入助手，请安装扩展后刷新页面。" : "等待助手超时。请查看目标网页，不要重复点击；可登录后重试。"));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, direction: "request", id, action, ...payload }, location.origin);
    });
  }
  async function openAndFill() {
    try {
      const url = targetUrl();
      if (!getImage()) throw new Error("请先上传或粘贴电路图片。");
      if (!available) {
        $("webAiInstallHelp").open = true;
        throw new Error("自动填入需要浏览器助手。请按下方步骤安装；也可使用「仅打开网页」和手动复制。 ");
      }
      save();
      $("openWebAiBtn").disabled = true;
      status("正在打开目标网页并准备填入，请先确保已登录…");
      const result = await request("open", {
        url, imageDataUrl: getImage(), prompt: getPrompt(),
        textSelector: $("webAiTextSelector").value.trim(),
        fileSelector: $("webAiFileSelector").value.trim(),
      }, 65000);
      if (!result.ok) throw new Error(result.error);
      status(result.message, result.complete ? "success" : "warn");
    } catch (err) {
      status(err.message, "warn");
    } finally {
      $("openWebAiBtn").disabled = false;
    }
  }
  function init(options) {
    getImage = options.getImage;
    getPrompt = options.getPrompt;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(settingsKey) || "{}"); } catch (_) {}
    $("webAiUrl").value = saved.url || $("webAiPreset").value;
    $("webAiTextSelector").value = saved.textSelector || "";
    $("webAiFileSelector").value = saved.fileSelector || "";
    const syncPreset = () => {
      const value = $("webAiUrl").value.trim();
      $("webAiPreset").value = Array.from($("webAiPreset").options).some((o) => o.value === value) ? value : "custom";
    };
    syncPreset();
    $("webAiPreset").addEventListener("change", () => {
      if ($("webAiPreset").value !== "custom") $("webAiUrl").value = $("webAiPreset").value;
      else $("webAiUrl").focus();
      // Selectors are site-specific; do not carry them across presets.
      $("webAiTextSelector").value = "";
      $("webAiFileSelector").value = "";
      save();
    });
    $("webAiUrl").addEventListener("input", () => { syncPreset(); save(); });
    for (const id of ["webAiTextSelector", "webAiFileSelector"]) $(id).addEventListener("input", save);
    $("openWebAiBtn").addEventListener("click", openAndFill);
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
      clearTimeout(entry.timer);
      pending.delete(d.id);
      entry.resolve(d.result);
    });
    request("ping").then((result) => {
      available = result.ok === true;
      status(available ? "✓ 自动填入助手已连接。首次使用目标网站，请点击扩展图标授权。" : "助手连接失败。", available ? "success" : "warn");
    }).catch((err) => status(err.message, "warn"));
  }
  window.WebAiTransfer = { init };
})();
