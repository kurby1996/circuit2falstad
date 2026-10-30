/**
 * Circuit2Falstad Frontend Application Controller
 * Connects Image Upload / Paste, Vision LLM API & Zero-API Prompt Mode,
 * Deterministic CircuitJS1 Compiler and Live Falstad Simulator.
 */
(function () {
  "use strict";

  const state = {
    mode: "api", // "api" | "prompt"
    viewMode: "live", // "live" | "svg"
    imageDataUrl: "",
    currentIr: null,
    currentFalstadTxt: "",
    currentFalstadUrl: "https://www.falstad.com/circuit/circuitjs.html",
    hasSavedServerKey: false,
    maskedKey: "",
    activeAnalysis: null,
    config: {
      provider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "Qwen/Qwen2.5-VL-72B-Instruct",
      apiKey: "",
    },
  };

  // DOM helpers
  const $ = (id) => document.getElementById(id);

  function setStatus(msg, type = "info") {
    const el = $("statusBanner");
    el.textContent = msg;
    el.className = "status-bar" + (type === "error" ? " error" : type === "success" ? " success" : "");
  }

  function extractJsonObject(rawText) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) throw new Error("输入内容为空");

    // Check if user pasted raw Falstad circuit text directly
    if (trimmed.startsWith("$ ")) {
      return { __rawFalstad: trimmed };
    }

    // Strip markdown code fences if present
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }
    // Remove trailing commas before } or ]
    candidate = candidate.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(candidate);
  }

  async function urlToDataUrl(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await blobToOptimizedDataUrl(blob);
  }

  function blobToOptimizedDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("解码图片失败"));
        img.onload = () => {
          const maxDim = 1600;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.9));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  function showImagePreview(dataUrl) {
    state.imageDataUrl = dataUrl || "";
    const wrap = $("imgPreviewWrap");
    const img = $("imgPreview");
    const clearBtn = $("clearImgBtn");
    const hint = $("dropHint");
    if (dataUrl) {
      img.src = dataUrl;
      wrap.classList.remove("hidden");
      clearBtn.classList.remove("hidden");
      hint.innerHTML = "已载入电路图（可点击更换，或直接 <strong>Ctrl+V</strong> 粘贴新截图）";
    } else {
      img.removeAttribute("src");
      wrap.classList.add("hidden");
      clearBtn.classList.add("hidden");
      hint.innerHTML =
        "<strong>点击选择图片</strong>、拖拽原理图到此，或直接按 <strong>Ctrl + V</strong> 粘贴截图<br /><span>支持黑板粉笔手绘图、教材插图、视频截图、Altium/KiCad/立创EDA截图</span>";
    }
  }

  function syncFromCurrentIr(recompile = true) {
    if (recompile) {
      compileAndRenderCurrentIr();
    }
  }

  function compileAndRenderCurrentIr() {
    if (!state.currentIr) return;
    try {
      const result = window.CircuitCompiler.compile(state.currentIr);
      applyCompiledResult(result);
    } catch (err) {
      console.error(err);
      setStatus("编译仿真文件出错: " + err.message, "error");
    }
  }

  function applyCompiledResult(result) {
    state.currentFalstadTxt = result.circuitText;
    const compressed = window.LZString.compressToEncodedURIComponent(result.circuitText.trim());
    const url = `https://www.falstad.com/circuit/circuitjs.html?ctz=${compressed}`;
    state.currentFalstadUrl = url;

    $("openFalstadLink").href = url;
    $("svgStage").innerHTML = result.svgHtml || "";

    // Update live simulator iframe
    const iframe = $("falstadIframe");
    if (iframe.dataset.loadedUrl !== url) {
      iframe.src = url;
      iframe.dataset.loadedUrl = url;
    }

    const stats = result.stats || {};
    $("compileStats").textContent = `元件: ${stats.componentCount || 0} | 网络: ${stats.netCount || 0} | 导线: ${
      stats.wireCount || 0
    }`;

    if (result.warnings && result.warnings.length > 0) {
      setStatus("已生成仿真（提示：" + result.warnings.join("；") + "）", "info");
    }
  }

  function applyRawFalstadText(rawTxt) {
    const clean = String(rawTxt || "").trim();
    if (!clean.startsWith("$")) {
      setStatus("Falstad 仿真源码首行必须以 '$ 1 ...' 开头", "error");
      return;
    }
    state.currentFalstadTxt = clean + "\n";
    const compressed = window.LZString.compressToEncodedURIComponent(clean);
    const url = `https://www.falstad.com/circuit/circuitjs.html?ctz=${compressed}`;
    state.currentFalstadUrl = url;
    $("openFalstadLink").href = url;
    $("falstadIframe").src = url;
    $("falstadIframe").dataset.loadedUrl = url;
    setStatus("已将自定义 Falstad 仿真文本同步到右侧实时仿真窗口！", "success");
  }

  // Load built-in demo
  async function loadDemo(demoKey) {
    const demo = window.PromptSchema.BUILTIN_DEMOS.find((d) => d.key === demoKey);
    if (!demo) return;
    state.currentIr = JSON.parse(JSON.stringify(demo.ir));
    if (demo.imageUrl) {
      try {
        const dataUrl = await urlToDataUrl(demo.imageUrl);
        showImagePreview(dataUrl);
      } catch (_) {
        showImagePreview("");
      }
    } else {
      showImagePreview("");
    }
    syncFromCurrentIr(true);
    setStatus(`已载入「${demo.name}」，可直接在右侧交互仿真或下载 .circuitjs.txt 文件！`, "success");
  }

  const DEFAULT_ANALYZE_BTN_TEXT = "🚀 AI 识别图片并生成 Falstad 仿真电路";

  function stopVisionAnalysis(customMessage) {
    const task = state.activeAnalysis;
    if (!task) return false;
    state.activeAnalysis = null;
    clearInterval(task.timerId);

    try {
      task.controller.abort();
    } catch (_) {}

    // Notify backend to release active request immediately
    fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: task.requestId }),
    }).catch(() => {});

    const btn = $("analyzeBtn");
    const stopBtn = $("stopAnalyzeBtn");
    btn.disabled = false;
    btn.textContent = DEFAULT_ANALYZE_BTN_TEXT;
    stopBtn.classList.add("hidden");

    setStatus(customMessage || "⏹ 已手动停止当前识别任务，可随时重新点击识别或切换模型。", "info");
    return true;
  }

  // Run Vision AI Analysis
  async function runVisionAnalysis() {
    if (!state.imageDataUrl) {
      setStatus("请先选择、拖拽或按 Ctrl+V 粘贴一张电路图！", "error");
      return;
    }

    // Ensure any previous task is cleanly aborted first
    if (state.activeAnalysis) {
      stopVisionAnalysis();
    }

    const controller = new AbortController();
    const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    const btn = $("analyzeBtn");
    const stopBtn = $("stopAnalyzeBtn");

    const updateProgressText = () => {
      const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      btn.textContent = `⏳ 正在解析元件极性与网络拓扑... (${sec}s)`;
    };

    const timerId = setInterval(updateProgressText, 1000);
    const task = { controller, requestId, timerId, startedAt };
    state.activeAnalysis = task;

    btn.disabled = true;
    updateProgressText();
    stopBtn.classList.remove("hidden");
    setStatus("正在识别电路图中的元器件、参数与连接网络（右侧「⏹ 停止任务」可随时中断）...", "info");

    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          requestId,
          provider: state.config.provider,
          baseUrl: state.config.baseUrl,
          model: state.config.model,
          apiKey: state.config.apiKey || (state.hasSavedServerKey ? "__KEEP_EXISTING__" : ""),
          imageDataUrl: state.imageDataUrl,
          systemPrompt: window.PromptSchema.SYSTEM_PROMPT,
          userPrompt: window.PromptSchema.USER_PROMPT,
        }),
      });
      const data = await resp.json();
      if (state.activeAnalysis !== task) return;

      if (!resp.ok || !data.ok) {
        if (data.cancelled) return;
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const parsed = extractJsonObject(data.rawText);
      if (parsed.__rawFalstad) {
        applyRawFalstadText(parsed.__rawFalstad);
      } else {
        state.currentIr = window.CircuitCompiler.normalizeIr(parsed);
        syncFromCurrentIr(true);
        setStatus(
          `✅ 识别完成！「${state.currentIr.title || "电路"}」共解析出 ${
            state.currentIr.components.length
          } 个元器件，已自动生成 Falstad 仿真！`,
          "success"
        );
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        return;
      }
      if (state.activeAnalysis !== task) return;
      console.error(err);
      setStatus("识别失败：" + err.message, "error");
      if (String(err.message).includes("未配置 API Key")) {
        openSettingsModal();
      }
    } finally {
      clearInterval(task.timerId);
      if (state.activeAnalysis === task) {
        state.activeAnalysis = null;
        btn.disabled = false;
        btn.textContent = DEFAULT_ANALYZE_BTN_TEXT;
        stopBtn.classList.add("hidden");
      }
    }
  }

  // Config Management
  async function loadServerConfig() {
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) return;
      const cfg = await resp.json();
      if (cfg.provider) state.config.provider = cfg.provider;
      if (cfg.baseUrl) state.config.baseUrl = cfg.baseUrl;
      if (cfg.model) state.config.model = cfg.model;
      state.hasSavedServerKey = Boolean(cfg.hasApiKey);
      state.maskedKey = cfg.maskedKey || "";
      updateApiBadge();
    } catch (_) {
      // Standalone mode fallback
      const raw = localStorage.getItem("c2f_config");
      if (raw) {
        try {
          Object.assign(state.config, JSON.parse(raw));
          updateApiBadge();
        } catch (_) {}
      }
    }
  }

  function updateApiBadge() {
    const dot = $("apiDot");
    const label = $("apiStatusLabel");
    const ready = state.config.provider === "ollama" || Boolean(state.config.apiKey) || state.hasSavedServerKey;
    if (ready) {
      dot.classList.add("ready");
      label.textContent = `已配置: ${state.config.model || state.config.provider}`;
    } else {
      dot.classList.remove("ready");
      label.textContent = "配置视觉模型 API";
    }
  }

  function refreshModelSuggestions(providerKey) {
    const dl = $("modelSuggestions");
    if (!dl) return;
    dl.innerHTML = "";
    const models = window.PromptSchema.PROVIDER_PRESETS[providerKey]?.models || [];
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      dl.appendChild(opt);
    });
  }

  const DEFAULT_TEST_BTN_TEXT = "🔌 测试连接与识图";
  let activeApiTest = null;

  function setApiTestBanner(msg, level = "info") {
    const el = $("apiTestResult");
    if (!el) return;
    if (!msg) {
      el.textContent = "";
      el.className = "status-bar hidden";
      return;
    }
    el.textContent = msg;
    el.className =
      "status-bar" +
      (level === "error"
        ? " error"
        : level === "success"
        ? " success"
        : level === "warn"
        ? " warn"
        : "");
  }

  function stopApiTest(customMessage) {
    const task = activeApiTest;
    if (!task) return;
    activeApiTest = null;
    clearInterval(task.timerId);
    try {
      task.controller.abort();
    } catch (_) {}

    fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: task.requestId }),
    }).catch(() => {});

    const btn = $("testApiBtn");
    const stopBtn = $("stopTestApiBtn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = DEFAULT_TEST_BTN_TEXT;
    }
    if (stopBtn) stopBtn.classList.add("hidden");
    if (customMessage !== undefined) {
      setApiTestBanner(customMessage, "info");
    }
  }

  async function runApiTest() {
    if (activeApiTest) {
      stopApiTest("");
    }
    const provider = $("providerSelect").value;
    const baseUrl = $("baseUrlInput").value.trim();
    const model = $("modelInput").value.trim();
    const typedKey = $("apiKeyInput").value.trim();

    if (!model) {
      setApiTestBanner("❌ 请先填写「视觉模型名称 (Model ID)」再点击测试！", "error");
      return;
    }
    if (provider !== "gemini_native" && !baseUrl) {
      setApiTestBanner("❌ 请先填写「API Base URL」接口地址！", "error");
      return;
    }
    const canReuseSavedKey =
      state.hasSavedServerKey &&
      (provider === state.config.provider || (baseUrl && baseUrl === state.config.baseUrl));
    const effectiveKey = typedKey || state.config.apiKey || (canReuseSavedKey ? "__KEEP_EXISTING__" : "");
    if (provider !== "ollama" && !effectiveKey) {
      setApiTestBanner("❌ 请先在上方填入当前服务商的 API Key 再点击测试！", "error");
      return;
    }

    const controller = new AbortController();
    const requestId = "test_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    const btn = $("testApiBtn");
    const stopBtn = $("stopTestApiBtn");

    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      btn.textContent = `⏳ 测试中... (${sec}s)`;
    };
    const timerId = setInterval(tick, 1000);
    const task = { controller, requestId, timerId };
    activeApiTest = task;

    btn.disabled = true;
    tick();
    stopBtn.classList.remove("hidden");
    setApiTestBanner("⏳ 正在向模型发送微型测试图，验证 API 密钥与视觉识图能力...", "info");

    try {
      const resp = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          requestId,
          provider,
          baseUrl,
          model,
          apiKey: effectiveKey,
        }),
      });
      const data = await resp.json();
      if (activeApiTest !== task) return;

      if (data.cancelled) {
        setApiTestBanner("⏹ 已手动停止连接测试。", "info");
      } else if (!resp.ok || !data.ok) {
        setApiTestBanner(data.error || `❌ 测试失败 (HTTP ${resp.status})`, "error");
      } else if (data.visionOk) {
        setApiTestBanner(data.message, "success");
      } else {
        setApiTestBanner(data.message, "warn");
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (activeApiTest !== task) return;
      setApiTestBanner("❌ 请求本地测试接口失败：" + err.message, "error");
    } finally {
      clearInterval(task.timerId);
      if (activeApiTest === task) {
        activeApiTest = null;
        btn.disabled = false;
        btn.textContent = DEFAULT_TEST_BTN_TEXT;
        stopBtn.classList.add("hidden");
      }
    }
  }

  function openSettingsModal() {
    const prov = state.config.provider || "siliconflow";
    $("providerSelect").value = prov;
    refreshModelSuggestions(prov);
    $("baseUrlInput").value = state.config.baseUrl || "";
    $("modelInput").value = state.config.model || "";
    $("apiKeyInput").value = state.config.apiKey || "";
    $("apiKeyInput").type = "password";
    if ($("toggleApiKeyBtn")) $("toggleApiKeyBtn").textContent = "👁 显示";
    $("apiKeyInput").placeholder = state.hasSavedServerKey
      ? `已保存密钥 (${state.maskedKey})，留空则保持不变`
      : window.PromptSchema.PROVIDER_PRESETS[prov]?.placeholderKey || "sk-...";
    setApiTestBanner("");
    $("settingsModal").classList.remove("hidden");
  }

  function closeSettingsModal() {
    if (activeApiTest) stopApiTest("");
    $("settingsModal").classList.add("hidden");
  }

  async function saveSettings() {
    state.config.provider = $("providerSelect").value;
    state.config.baseUrl = $("baseUrlInput").value.trim();
    state.config.model = $("modelInput").value.trim();
    const typedKey = $("apiKeyInput").value.trim();
    if (typedKey) {
      state.config.apiKey = typedKey;
      state.hasSavedServerKey = true;
    }

    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: state.config.provider,
          baseUrl: state.config.baseUrl,
          model: state.config.model,
          apiKey: typedKey ? typedKey : "__KEEP_EXISTING__",
        }),
      });
    } catch (_) {
      localStorage.setItem("c2f_config", JSON.stringify(state.config));
    }

    updateApiBadge();
    closeSettingsModal();
    setStatus("模型配置已保存在本地！现在可以上传电路图并点击「AI 识别图片并生成 Falstad 仿真电路」。", "success");
  }

  // Export & Download Helpers
  function downloadCircuitTxt() {
    if (!state.currentFalstadTxt) return;
    const rawName = (state.currentIr?.title || "circuit").replace(/[<>:"/\\|?*]+/g, "_");
    const filename = `${rawName}.circuitjs.txt`;
    const blob = new Blob([state.currentFalstadTxt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 200);
    setStatus(`已下载仿真文件「${filename}」！可直接拖进 Falstad 网页画布，或通过 File -> Open File 打开。`, "success");
  }

  async function saveCircuitToServerOutputs() {
    if (!state.currentFalstadTxt) return;
    try {
      const resp = await fetch("/api/save-circuit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: state.currentIr?.title || "circuit",
          content: state.currentFalstadTxt,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "保存失败");
      setStatus(`已保存至本地目录：${data.savedPath}`, "success");
    } catch (err) {
      setStatus("保存到本地 outputs 目录失败：" + err.message, "error");
    }
  }

  function initEvents() {
    // Populate demos
    const demoSel = $("demoSelect");
    window.PromptSchema.BUILTIN_DEMOS.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.key;
      opt.textContent = d.name;
      demoSel.appendChild(opt);
    });
    demoSel.addEventListener("change", () => loadDemo(demoSel.value));

    // Populate provider presets
    const provSel = $("providerSelect");
    Object.entries(window.PromptSchema.PROVIDER_PRESETS).forEach(([key, info]) => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = info.name;
      provSel.appendChild(opt);
    });
    provSel.addEventListener("change", () => {
      refreshModelSuggestions(provSel.value);
      setApiTestBanner("");
      const preset = window.PromptSchema.PROVIDER_PRESETS[provSel.value];
      if (preset) {
        if (preset.baseUrl) $("baseUrlInput").value = preset.baseUrl;
        if (preset.defaultModel) $("modelInput").value = preset.defaultModel;
        $("apiKeyInput").placeholder =
          state.hasSavedServerKey && provSel.value === state.config.provider
            ? `已保存密钥 (${state.maskedKey})，留空则保持不变`
            : preset.placeholderKey;
      }
    });

    // Mode toggle (API vs Prompt)
    $("modeApiBtn").addEventListener("click", () => {
      state.mode = "api";
      $("modeApiBtn").classList.add("active");
      $("modePromptBtn").classList.remove("active");
      $("apiModePanel").classList.remove("hidden");
      $("promptModePanel").classList.add("hidden");
    });
    $("modePromptBtn").addEventListener("click", () => {
      state.mode = "prompt";
      $("modePromptBtn").classList.add("active");
      $("modeApiBtn").classList.remove("active");
      $("promptModePanel").classList.remove("hidden");
      $("apiModePanel").classList.add("hidden");
    });

    // View toggle (Live Falstad iframe vs Local SVG)
    $("viewLiveBtn").addEventListener("click", () => {
      $("viewLiveBtn").classList.add("active");
      $("viewSvgBtn").classList.remove("active");
      $("falstadIframe").classList.remove("hidden");
      $("svgStage").classList.add("hidden");
    });
    $("viewSvgBtn").addEventListener("click", () => {
      $("viewSvgBtn").classList.add("active");
      $("viewLiveBtn").classList.remove("active");
      $("svgStage").classList.remove("hidden");
      $("falstadIframe").classList.add("hidden");
    });

    // Dropzone & File Upload & Clipboard Paste
    const dropzone = $("dropzone");
    const fileInput = $("fileInput");
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) {
        const hadRunning = Boolean(state.activeAnalysis);
        if (hadRunning) stopVisionAnalysis();
        const dataUrl = await blobToOptimizedDataUrl(file);
        showImagePreview(dataUrl);
        setStatus(
          hadRunning
            ? `已载入新图片「${file.name}」（已自动停止上一张图片的识别任务），点击按钮即可识别！`
            : `已载入图片「${file.name}」，点击下方按钮开始识别转换！`,
          "info"
        );
      }
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (file) {
        const hadRunning = Boolean(state.activeAnalysis);
        if (hadRunning) stopVisionAnalysis();
        const dataUrl = await blobToOptimizedDataUrl(file);
        showImagePreview(dataUrl);
        setStatus(
          hadRunning
            ? `已载入新图片「${file.name}」（已自动停止上一张图片的识别任务），点击按钮即可识别！`
            : `已载入图片「${file.name}」，点击下方按钮开始识别转换！`,
          "info"
        );
      }
    });
    $("clearImgBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.activeAnalysis) {
        stopVisionAnalysis("⏹ 已清空图片并停止当前识别任务。");
      }
      fileInput.value = "";
      showImagePreview("");
    });

    window.addEventListener("paste", async (e) => {
      const items = e.clipboardData?.items || [];
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            const hadRunning = Boolean(state.activeAnalysis);
            if (hadRunning) stopVisionAnalysis();
            const dataUrl = await blobToOptimizedDataUrl(blob);
            showImagePreview(dataUrl);
            setStatus(
              hadRunning
                ? "已粘贴新电路截图（已自动停止上一张图片的识别任务）！点击按钮即可识别新图。"
                : "已从剪贴板粘贴电路截图！点击按钮即可识别并生成仿真。",
              "success"
            );
          }
          return;
        }
      }
    });

    // Action Buttons
    $("analyzeBtn").addEventListener("click", runVisionAnalysis);
    $("stopAnalyzeBtn").addEventListener("click", () => stopVisionAnalysis());

    $("copyPromptBtn").addEventListener("click", async () => {
      const fullPrompt =
        window.PromptSchema.SYSTEM_PROMPT + "\n\n---\n\n" + window.PromptSchema.USER_PROMPT;
      await navigator.clipboard.writeText(fullPrompt);
      setStatus("已复制专用识别提示词！请将提示词与电路截图一起发给任意网页版 AI，再把返回的 JSON 粘贴到下方。", "success");
    });

    $("compilePastedBtn").addEventListener("click", () => {
      try {
        const parsed = extractJsonObject($("pasteJsonInput").value);
        if (parsed.__rawFalstad) {
          applyRawFalstadText(parsed.__rawFalstad);
          return;
        }
        state.currentIr = window.CircuitCompiler.normalizeIr(parsed);
        syncFromCurrentIr(true);
        setStatus(`✅ 编译成功！已生成「${state.currentIr.title || "电路"}」的实时仿真。`, "success");
      } catch (err) {
        setStatus("JSON 解析失败，请检查粘贴内容是否完整：" + err.message, "error");
      }
    });

    $("downloadTxtBtn").addEventListener("click", downloadCircuitTxt);
    $("saveServerBtn").addEventListener("click", saveCircuitToServerOutputs);
    $("copyTxtBtn").addEventListener("click", async () => {
      if (!state.currentFalstadTxt) return;
      await navigator.clipboard.writeText(state.currentFalstadTxt);
      setStatus("已复制 Falstad 仿真文本！可在 Falstad 网页菜单选择 File -> Import From Text... 粘贴导入。", "success");
    });

    // Settings Modal (only close via explicit ✕ / 取消 / 保存配置 buttons — never on backdrop click/drag!)
    $("openSettingsBtn").addEventListener("click", openSettingsModal);
    $("closeSettingsBtn").addEventListener("click", closeSettingsModal);
    $("cancelSettingsBtn").addEventListener("click", closeSettingsModal);
    $("saveSettingsBtn").addEventListener("click", saveSettings);
    if ($("testApiBtn")) {
      $("testApiBtn").addEventListener("click", runApiTest);
    }
    if ($("stopTestApiBtn")) {
      $("stopTestApiBtn").addEventListener("click", () => stopApiTest("⏹ 已手动停止连接测试。"));
    }
    if ($("settingsModalDialog")) {
      $("settingsModalDialog").addEventListener("click", (e) => e.stopPropagation());
    }
    if ($("toggleApiKeyBtn")) {
      $("toggleApiKeyBtn").addEventListener("click", () => {
        const inp = $("apiKeyInput");
        const isPwd = inp.type === "password";
        inp.type = isPwd ? "text" : "password";
        $("toggleApiKeyBtn").textContent = isPwd ? "🙈 隐藏" : "👁 显示";
      });
    }
  }

  // Boot
  window.addEventListener("DOMContentLoaded", async () => {
    initEvents();
    window.WebAiTransfer.init({ getImage: () => state.imageDataUrl, getPrompt: () => window.PromptSchema.SYSTEM_PROMPT + "\n\n---\n\n" + window.PromptSchema.USER_PROMPT });
    await loadServerConfig();
    await loadDemo("blackboard_reverse_prot");
  });
})();
