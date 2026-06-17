# JS Reverse MCP

[English](README_en.md) | 中文

JavaScript 逆向工程 MCP 服务器，让你的 AI 编码助手（如 Claude、Cursor、Copilot）能够调试和分析网页中的 JavaScript 代码。

基于 [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) 协议层反检测，对强反爬站点可选启用 [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) 源码层指纹模式。**有头模式 + 持久化登录态 + 零 JS 注入** —— 看起来、行为都像一个真实的 Chrome。

## 功能特点

- **默认有头调试**：看得到浏览器，下断点、单步、看调用栈 —— 真正的逆向流程
- **持久化登录态**：cookies / localStorage 跨会话保留
- **双层反检测**：Patchright 在 CDP 协议层规避 `Runtime.enable`、`Console.enable` 等泄露点；可选 `--cloak` 启用 CloakBrowser 二进制，再加 49 个 C++ 源码层指纹 patch（canvas / WebGL / audio / GPU / 字体）
- **脚本分析**：列出所有加载的 JS，搜索代码，获取/保存源码
- **断点调试**：设置/移除断点，支持条件断点，压缩代码中精确定位
- **执行控制**：暂停/恢复，单步 over/into/out，响应带源码上下文
- **运行时检查**：在断点处求值，检查作用域变量
- **网络分析**：请求调用栈、XHR 断点、WebSocket 消息分析

## 系统要求

- [Node.js](https://nodejs.org/) v20.19 或更新版本
- [Chrome](https://www.google.com/chrome/) 稳定版

## 快速开始（npx）

无需安装，直接在 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add js-reverse npx js-reverse-mcp
```

### Codex

```bash
codex mcp add js-reverse -- npx js-reverse-mcp
```

### Cursor

进入 `Cursor Settings` -> `MCP` -> `New MCP Server`，使用上面的配置。

### VS Code Copilot

```bash
code --add-mcp '{"name":"js-reverse","command":"npx","args":["js-reverse-mcp"]}'
```

## 本地安装（可选）

```bash
git clone https://github.com/zhizhuodemao/js-reverse-mcp.git
cd js-reverse-mcp
npm install
npm run build
```

然后在 MCP 配置中使用本地路径：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "node",
      "args": ["/你的路径/js-reverse-mcp/build/src/index.js"]
    }
  }
}
```

## 反检测机制

本项目的反检测**分层清晰**。包装层（这个 MCP 自己）**零 JS 注入**、不做 `Object.defineProperty` hack（那本身就是检测信号）。所有反检测都在两个互不重叠的层：

| 层                             | 默认模式                                                                                                        | `--cloak` 模式                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **协议层**（CDP）              | Patchright：不调 `Runtime.enable` / `Console.enable`，在 isolated world 里执行 evaluate，移除自动化 launch flag | 同                                                                                                                |
| **源码层**（C++ 二进制 patch） | 无 —— 直接用系统 Google Chrome                                                                                  | CloakBrowser 二进制（49 个 C++ patch：`navigator.webdriver`、canvas、WebGL、audio、GPU、字体、屏幕、WebRTC、TLS） |
| **Profile 目录**               | `~/.cache/chrome-devtools-mcp/chrome-profile`（持久化登录态）                                                   | `~/.cache/chrome-devtools-mcp/cloak-profile`（与默认物理隔离）                                                    |
| **实际浏览器**                 | 你装的 Google Chrome（带 Web Store、扩展、sync）                                                                | 定制 Chromium 编译版（无 Google 服务、无 Web Store）                                                              |

另外几个导航级措施（两种模式都生效）：

- **CDP 静默导航** —— 页面加载时不激活 `Network.enable` / `Debugger.enable`，请求/控制台收集只走 Playwright 监听器，直到某个工具显式需要 CDP 才激活
- **Google Referer** —— `new_page` 默认带 `referer: https://www.google.com/`
- **真实视口** —— 关掉 Playwright 默认的 1280×720 假视口，浏览器展示真实屏幕尺寸

**何时开 `--cloak`**：只在以上还不够、被站点指纹拦截时才用。详见 [docs/cloak.md](docs/cloak.md)。

## 工具列表（21 个）

### 页面与导航

| 工具              | 描述                                       |
| ----------------- | ------------------------------------------ |
| `select_page`     | 列出打开的页面，或按索引选择调试上下文     |
| `new_page`        | 创建新页面并导航到 URL                     |
| `navigate_page`   | 导航、后退、前进或刷新页面                 |
| `select_frame`    | 列出所有 frame（iframe），或选择执行上下文 |
| `take_screenshot` | 截取页面截图                               |

### 脚本分析

| 工具                 | 描述                                                   |
| -------------------- | ------------------------------------------------------ |
| `list_scripts`       | 列出页面中所有加载的 JavaScript 脚本                   |
| `get_script_source`  | 获取脚本源码片段，支持行范围或字符偏移                 |
| `save_script_source` | 保存完整脚本源码到本地文件（适用于大型/压缩/WASM文件） |
| `search_in_sources`  | 在所有脚本中搜索字符串或正则表达式                     |

### 断点与执行控制

| 工具                     | 描述                                            |
| ------------------------ | ----------------------------------------------- |
| `set_breakpoint_on_text` | 通过搜索代码文本自动设置断点（适用于压缩代码）  |
| `break_on_xhr`           | 按 URL 模式设置 XHR/Fetch 断点                  |
| `remove_breakpoint`      | 按 ID、URL 或全部移除断点，自动恢复执行         |
| `list_breakpoints`       | 列出所有活动断点                                |
| `get_paused_info`        | 获取暂停状态、调用栈和作用域变量                |
| `pause_or_resume`        | 切换暂停/恢复执行                               |
| `step`                   | 单步调试（over/into/out），返回位置和源码上下文 |

### 网络与 WebSocket

| 工具                     | 描述                                            |
| ------------------------ | ----------------------------------------------- |
| `list_network_requests`  | 列出网络请求，或按 reqid 获取单条详情           |
| `get_request_initiator`  | 获取网络请求的 JavaScript 调用栈                |
| `get_websocket_messages` | 列出 WebSocket 连接、分析消息模式或获取消息详情 |

### 检查工具

| 工具                    | 描述                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `evaluate_script`       | 在页面中执行 JavaScript（支持断点上下文、主世界执行和保存结果/二进制数据到文件） |
| `list_console_messages` | 列出控制台消息，或按 msgid 获取单条详情                                          |

## 使用示例

### JS 逆向基本流程

1. **打开目标页面**

```
打开 https://example.com 并列出所有加载的 JS 脚本
```

2. **查找目标函数**

```
在所有脚本中搜索包含 "encrypt" 的代码
```

3. **设置断点**

```
在加密函数入口处设置断点
```

4. **触发并分析**

```
在页面上触发操作，断点命中后检查参数、调用栈和作用域变量
```

### WebSocket 协议分析

```
列出 WebSocket 连接，分析消息模式，查看特定类型的消息内容
```

## 配置选项

CLI 刻意精简到 4 个 flag，全部可选。**99% 场景默认即可**。

| 选项               | 描述                                                                                                                                                                                                                      | 默认值  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--cloak`          | 切换到 CloakBrowser 隐身二进制（取代系统 Chrome）。叠加 49 个 C++ 源码层指纹 patch。首次启动自动下载 ~200MB 二进制；指纹身份按 profile 持久化。详见 [docs/cloak.md](docs/cloak.md)。                                      | `false` |
| `--isolated`       | 使用临时 user-data-dir（cookies/localStorage 不保留，关闭时自动清理）                                                                                                                                                     | `false` |
| `--browserUrl, -u` | 连接到已运行的 Chrome 实例（CDP HTTP 端点，如 `http://127.0.0.1:9222`）。MCP 会自动探测出 WebSocket debugger URL。本地 Chrome、AdsPower、BitBrowser 等怎么拿到这个端点详见 [docs/cdp-endpoint.md](docs/cdp-endpoint.md)。 | –       |
| `--logFile`        | 调试日志输出文件路径（配合 `DEBUG=*` 环境变量得到详细日志）                                                                                                                                                               | –       |

### 示例配置

**默认 —— 系统 Chrome + 持久化登录态**（绝大多数调试场景推荐）：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    }
  }
}
```

**`--cloak` —— 强反爬站点**（Cloudflare Turnstile / DataDome / FingerprintJS 防护）：

> **强烈推荐：先把二进制预下载好**（一次性，~30–60 秒）。**不做这一步**的话，首次启动带 `--cloak` 的 MCP 会**静默下载 ~200MB**，看起来像 MCP 卡住了：
>
> ```bash
> npx cloakbrowser install
> ```
>
> （`cloakbrowser` 包已经通过 `optionalDependencies` 一起装好，这条命令只是触发它自带的二进制下载逻辑，有进度条）

```json
{
  "mcpServers": {
    "js-reverse-cloak": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

**两套并行** —— 两个 MCP 实例 profile 物理隔离，根据目标站点切换：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    },
    "js-reverse-cloak": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

**`--isolated` —— 每次全新 profile**（不保留 cookies/localStorage）：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--isolated"]
    }
  }
}
```

### 连接到已运行的 Chrome / 第三方指纹浏览器

`--browserUrl` 只接受 **CDP endpoint**（能响应 `/json/version` 的 HTTP 端点），不接受厂商私有 Local API。本地 Chrome、AdsPower、BitBrowser 等场景下怎么拿到 CDP 端口，详见专门的文档：

📖 **[docs/cdp-endpoint.md —— 如何拿到 CDP 调试端口](docs/cdp-endpoint.md)**

最短路径（本地 Chrome）：

```bash
# 先关掉所有 Chrome 窗口，然后
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browserUrl", "http://127.0.0.1:9222"]
    }
  }
}
```

指纹浏览器（AdsPower、BitBrowser 等）的 CDP 端口是**每次启动随机变化**的，必须通过厂商 Local API 启动浏览器后再提取，操作步骤和示例脚本都在上面那篇文档里。

## 故障排除

### 被反爬系统拦截

如果访问某些站点被拦截（如知乎返回 40362、Cloudflare 挑战死循环）：

1. **先试 `--isolated`** —— 用全新 profile 排除残留状态污染：
   ```json
   "args": ["js-reverse-mcp", "--isolated"]
   ```
2. **还不行就开 `--cloak`** —— 加 49 个源码层指纹 patch：
   ```json
   "args": ["js-reverse-mcp", "--cloak"]
   ```
3. **最后再考虑手动清持久化 profile**（会丢登录态）：
   ```bash
   rm -rf ~/.cache/chrome-devtools-mcp/chrome-profile
   ```

什么时候该开 `--cloak`、什么时候不该开，详见 [docs/cloak.md](docs/cloak.md)。

## 安全提示

此工具会将浏览器内容暴露给 MCP 客户端，允许检查、调试和修改浏览器中的任何数据。请勿在包含敏感信息的页面上使用。

## 许可证

Apache-2.0
