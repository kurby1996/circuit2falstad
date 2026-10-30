"use strict";
document.getElementById("grant").addEventListener("click", () => {
  const status = document.getElementById("status");
  try {
    const url = new URL(document.getElementById("url").value.trim());
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("请填写 HTTPS AI 网页地址。");
    chrome.permissions.request({ origins: [url.origin + "/*"] }).then((allowed) => {
      status.textContent = allowed ? "已授权 " + url.origin + "，回到工作台即可使用。" : "未授权，自动填入尚不可用。";
    }).catch((err) => { status.textContent = "授权失败：" + err.message; });
  } catch (err) { status.textContent = err.message; }
});
