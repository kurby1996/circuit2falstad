# Edge 插件安装与更新

项目已经附带插件，无需另行寻找：

- **直接安装目录：** [`edge-extension/`](edge-extension/)，其中包含 `manifest.json`。
- **独立压缩包：** [`edge-extension.zip`](edge-extension.zip)，适合单独下载和分发。
- **当前版本：** 1.2.0，支持后台自动识图、结果自动返回、固定标签页复用。

## 首次安装

1. 下载本项目并解压，或者单独下载并解压 `edge-extension.zip`。
2. 在 Microsoft Edge 地址栏输入 `edge://extensions/`。
3. 打开“开发人员模式”，点击“加载解压缩的扩展”。
4. 选择 **包含 `manifest.json` 的 `edge-extension` 文件夹**，不要选择 ZIP 文件或整个项目根目录。
5. 点击 Edge 工具栏的扩展图标，打开“Circuit2Falstad 网页填入助手”。
6. 填写准备使用的 AI 网页地址，例如 `https://chat.deepseek.com/`，点击“授权这个网站”并允许。
7. 提前登录该 AI 网站，启动本地工具并刷新页面。选择“免 API 网页识图 → 自动生成”，上传图片后即可运行。

## 更新现有插件

如果之前从其他文件夹加载过本插件，建议把本项目 `edge-extension` 中的文件复制覆盖到原安装文件夹，以保留原扩展身份和授权，然后在扩展管理页点击“重新加载”。不要在两个路径重复安装同一插件。

更新后刷新工作台。如果有尚未处理的图片，可点击工作台的“保留图片并重新连接”。

## 开发与重新打包

扩展源码在 [`static/browser-helper/`](static/browser-helper/)。修改源码后执行：

```powershell
python scripts/package_edge_extension.py
```

命令会同步根目录的安装文件夹及两个 ZIP 安装包。详细工作方式和网站适配说明见 [插件 README](edge-extension/README.md)。
