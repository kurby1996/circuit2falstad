# Circuit2Falstad — 电路图图片一键转 Falstad CircuitJS1 仿真工具

将**黑板/白板手绘电路、教材插图、视频截图、EDA 原理图截图**自动识别并编译为 [Paul Falstad CircuitJS1](https://www.falstad.com/circuit/circuitjs.html) 原生仿真格式（`.circuitjs.txt` 文件与 `?ctz=` 直达仿真链接），无需手工重画即可直接在线动态仿真。

---

## 1. 快速启动

零第三方依赖（仅需系统已安装的 Python 3）：

- **方式一（双击运行）**：直接双击 [`启动工具.bat`](./启动工具.bat)，自动启动本地服务并在浏览器打开工作台。
- **方式二（命令行）**：
  ```powershell
  python server.py
  ```
  默认访问地址：`http://127.0.0.1:8765`

---

## 2. 两种识图模式

### 模式 A：API 自动识图（一键端到端）
在页面右上角点击 **「API 配置」**，支持一键切换预设服务商（API Key 仅保存在本地 `.local_config.json`，不上传任何第三方）：
- **硅基流动 SiliconFlow**（如 `Qwen/Qwen2.5-VL-72B-Instruct`）
- **阿里云百炼 DashScope**（如 `qwen-vl-max`）
- **火山引擎豆包 Ark**
- **Google Gemini 原生接口**（如 `gemini-2.5-pro` / `gemini-2.5-flash`）
- **OpenAI / 兼容中转接口**（如 `gpt-4o`）
- **智谱 GLM-4V**
- **本地 Ollama 视觉模型**（如 `qwen2.5vl:7b`，无需联网）

上传或直接 `Ctrl + V` 粘贴电路截图后，点击 **「AI 识别并生成仿真」** 即可自动完成识图、拓扑编译、自动避障布线并加载右侧实时交互仿真。

### 模式 B：免 API 提示词粘贴模式（零成本）
如果不配置 API Key：
1. 切换到 **「免 API 提示词模式」**，点击 **「复制专用识图提示词」**；
2. 将提示词和电路图片发给任意网页版 AI（豆包、通义千问、Kimi、ChatGPT、Claude、Gemini 等）；
3. 将 AI 回复的 JSON 粘贴回工作台文本框，点击 **「解析 JSON 并生成仿真」** 即可。

---

## 3. 如何导入 Falstad 仿真器（3 种方式任选）

1. **页内直接仿真（最快）**：转换完成后，工作台右侧已内嵌官方 Falstad 仿真器，直接点击电路开关、拖拽探针或悬停查看各节点电压/电流波形。
2. **一键直达网页链接**：点击顶部或预览栏的 **「在 Falstad 新窗口打开」**，通过 `LZString` 压缩生成的 `?ctz=...` 链接直接打开完整电路。
3. **导入本地 `.circuitjs.txt` 文件**：
   - 点击 **「下载 .circuitjs.txt」** 或 **「保存到 outputs/」**；
   - 打开 `https://www.falstad.com/circuit/circuitjs.html`；
   - 菜单栏选择 **`文件 (File)` -> `打开文件... (Import From Local File...)`**，选择导出的 `.circuitjs.txt` 文件即可。

---

## 4. 支持的核心元器件与编译特性

- **无源器件**：电阻 (`r`)、无极性电容 (`c`)、电解电容 (`209`)、电感 (`l`)、电位器 (`174`)、开关 (`s`)
- **半导体器件（严格对齐引脚极性）**：普通二极管 (`d`)、稳压二极管/齐纳管 (`z`，精确支持击穿电压设定)、LED (`162`)、NPN/PNP 三极管 (`t`)、NMOS/PMOS 场效应管 (`f`)、理想/轨到轨运放 (`a`)
- **电源与测试点**：单端直流电源轨 (`R`)、双端直流稳压源 (`v`)、交流源 (`v`)、恒流源 (`i`)、参考地 (`g`)、电压探针 (`O`)
- **确定性几何与布线编译器 (`static/compiler.js`)**：
  - 100% 还原 CircuitJS1 源码级 `16px` 栅格与三端器件 `interpPoint2` 引脚坐标公式；
  - 自动选择三极管/MOS 管/运放镜像翻转位（`flip`），减少引线交叉；
  - 带元器件本体避障的 `16px` 正交 A\* 自动布线与 T 型节点自动切分，杜绝悬空假连与异网短路；
  - 内置离线 SVG 原理图双视图预览，断网环境也可校对引脚与网络名。

---

## 5. 目录结构

```text
circuit2falstad/
├── server.py                  # 零依赖本地 Web 服务与多模态 API 代理
├── 启动工具.bat                # Windows 一键启动脚本
├── static/
│   ├── index.html             # 可视化工作台前端界面
│   ├── styles.css             # 工程暗色主题样式
│   ├── app.js                 # 交互逻辑、元器件可视化微调与实时重编译
│   ├── compiler.js            # SchematicIR -> CircuitJS1 栅格几何与 A* 布线编译器
│   ├── prompt-schema.js       # 视觉大模型电路拓扑提取 Prompt 与内置示例库
│   └── lzstring.js            # Falstad ?ctz= URL 编解码实现
├── examples/
│   └── blackboard-reverse-protection.png  # 示例黑板手绘电路原图
├── outputs/
│   └── 防反接电路_黑板原图.circuitjs.txt     # 已生成的黑板原图 Falstad 仿真文件
└── tests/
    └── verify_compiler.js     # 电气连通性、防短路与栅格对齐自动化测试套件
```


## 免 API 后台自动识图

「免 API 网页识图」支持常用网站预设和自定义 HTTPS 网页地址。使用 [1.2.0 版浏览器助手](static/browser-helper/README.md)，提前登录并授权目标 AI 网站后，点击“一键后台识图并自动生成仿真”，即可自动完成图片上传、提示词发送、回复读取和仿真生成，无需手动复制粘贴。等待期间保持本工具页面打开。安装包位于 `static/browser-helper.zip`。

更新已安装助手后，须在扩展管理页点击“重新加载”，再刷新本工具。遇到登录、验证码、上传失败或网页结构变化时，会显示失败原因，可点击“查看后台网页”检查。可配置输入框、上传控件、发送按钮、助手回复等 CSS 选择器；支持程度取决于目标网站。已有草稿会保留，超时不会自动重发，停止任务不会撤回已发送的对话。

验证：`node tests/verify_web_ai.js`、`node tests/verify_web_automation.js`、`node tests/verify_compiler.js`。自动流程测试包括本次任务结果校验、完整 JSON 等待、附件未就绪、已有草稿、停止及真实编译器输出电路文本与 SVG。
