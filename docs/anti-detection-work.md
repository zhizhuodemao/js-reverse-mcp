# js-reverse-mcp 反检测分层架构

[English](anti-detection-work.en.md) | 中文

js-reverse-mcp 的反检测**分层清晰**：包装层（这个 MCP 本身）**零 JS 注入、零 `Object.defineProperty` hack**（这些反而会成为检测信号）。所有真正的反检测能力都集中在两层互相正交的处理上：**协议层**（Patchright）+ 可选的**源码层**（CloakBrowser 二进制）。

## 架构总览

```
┌────────────────────────────────────────────────────────────┐
│ 站点 JS 能看到的表面                                       │
├────────────────────────────────────────────────────────────┤
│ 协议层：Patchright（默认 + --cloak 都启用）                │
│  • 不调用 Runtime.enable / Console.enable（CDP 经典泄露点） │
│  • Evaluate 默认走 isolated execution context              │
│  • Default launch args 净化（移除 --enable-automation 等）  │
│  • 提供 Closed Shadow Root 访问能力                         │
├────────────────────────────────────────────────────────────┤
│ 源码层：CloakBrowser 二进制（仅 --cloak 模式）              │
│  • 49 个 C++ patch：navigator.webdriver / canvas / WebGL / │
│    audio / fonts / GPU / 屏幕 / WebRTC / TLS               │
│  • 指纹由 fingerprint seed 派生，按 profile 持久化         │
└────────────────────────────────────────────────────────────┘
                            ↑
        包装层（这个 MCP）—— 零 stealth 责任，只做 plumbing：
          • 启动/连接 Chrome
          • CDP 静默导航
          • Google referer
          • 真实 OS 视口
          • 不注入任何 JS、不 hack 任何属性
```

## 模式对比

| 维度                           | 默认模式                                      | `--cloak` 模式                                           |
| ------------------------------ | --------------------------------------------- | -------------------------------------------------------- |
| 浏览器二进制                   | 系统 Google Chrome                            | CloakBrowser 定制 Chromium（基于 145）                   |
| 协议层 stealth                 | Patchright                                    | Patchright                                               |
| 源码层 fingerprint patch       | 无                                            | 49 个 C++ patch                                          |
| Profile 目录                   | `~/.cache/chrome-devtools-mcp/chrome-profile` | `~/.cache/chrome-devtools-mcp/cloak-profile`（物理隔离） |
| Chrome Web Store / Google sync | ✅                                            | ❌（Chromium 不含 Google 闭源服务）                      |
| 反爬通过率                     | 中等                                          | 高（30+ 站点测试通过）                                   |

详细对比和 `--cloak` 启用指南：[cloak.md](cloak.md)

## 包装层的导航级安全措施

虽然反检测主体在 Patchright + cloak 这两层，包装层在**导航**这件事上有几个不可缺的辅助措施：

### 1. CDP 静默导航

页面加载期间**不激活任何 CDP 域**。`Network.enable` / `Debugger.enable` / `Audits.enable` 全部延后到首个**非导航**工具调用时才激活。

**为什么这是关键**：anti-bot 脚本（知乎的 40362、Cloudflare 的挑战、reCAPTCHA 等）在页面加载阶段会**实时探测 CDP 流量**。看到 `Network.requestWillBeSent` 这类事件订阅就直接判定为机器人。延后初始化 = 让风控 JS 跑完、放过你，然后再开调试通道。

涉及代码：

- `src/McpContext.ts:ensureCollectorsInitialized()` —— 延迟初始化入口
- `src/main.ts` —— 对 `ToolCategory.NAVIGATION` 工具特判，跳过 collectors 初始化

### 2. Google Referer

`new_page` 工具默认带 `referer: https://www.google.com/`。模拟"从 Google 搜索点进来"的最常见入站路径，降低站点对"直接访问"的可疑度评分。

涉及代码：`src/tools/pages.ts:46` 的 `DEFAULT_REFERER`。

### 3. 真实 OS 视口

`viewport: null` 关闭 Playwright 默认的 1280×720 假视口，让浏览器报告**真实屏幕尺寸**。假视口本身是 bot 信号。

涉及代码：`src/browser.ts` 里 `contextOptions = { viewport: null, ... }`。

### 4. Headed-only

`headless: false` 写死。这个 MCP 是**给人类分析师用的视觉调试工具**，不是无头爬虫。headless 即使叠加了 cloak 也容易被检测，因此根本不暴露 `--headless` flag。

### 5. `--test-type` Banner 抑制

包装层硬塞了 `--test-type` —— **不是 stealth，是 UX flag**。它让 Chrome 闭嘴：否则每个 Patchright / cloak 注入的"dev-only"标记都会在窗口顶端弹出「未受支持命令行标记」黄条。

涉及代码：`src/browser.ts:113`。

### 6. 物理隔离 profile 目录

`--cloak` 和默认模式**绝不共用 profile 目录**。不同 Chromium 版本的 cache / extension / shader state 混在一起会触发 `Network.setCacheDisabled` 内部错误，启动直接挂掉。

涉及代码：`src/browser.ts:36-37` 的 `DEFAULT_USER_DATA_DIR` / `DEFAULT_CLOAK_DATA_DIR`。

## 关键设计原则（不要违反）

这些原则是踩过坑总结出来的，**改代码前请仔细看一遍**。

### 原则 1：绝不做 JS-level 反检测

包装层**绝不**通过 `addInitScript` 或 `Object.defineProperty` 去修改 `navigator.*` / `screen.*` / `chrome.*` 等属性。这种 hack：

- 在 `Object.getOwnPropertyDescriptor` 里能看到 getter/setter 痕迹（真实 Chrome 这些属性都是 data property）
- 让 `Error.stack` 出现 `UtilityScript` / `eval at ...` 字样
- 被 hack 的函数 `.toString()` 不再是 `[native code]`

Google reCAPTCHA、FingerprintJS 等高强度反爬会**精确检查这些痕迹**。**JS patch 弄巧成拙，反而触发 "unusual traffic" 拦截**。

**反检测的真实工作只发生在两层**：C++ binary 层（cloak）+ CDP 协议层（Patchright）。

历史上项目曾有 `src/stealth-init.ts` 试图修复 `chrome.runtime` / `screen.availHeight` 等"残留泄露"，结果被 Google 直接检测出来。**已删除，不要重新引入。**

### 原则 2：绝不做 config-level fingerprint hack

类似 `--lang=en-US`、`--window-size=1920,1080`、`--fingerprinting-canvas-image-data-noise` 这类启动参数也是 stealth 反模式：

- 试图通过 flag 假装真实浏览器
- Chrome 升级一两个版本就失效
- flag 组合本身可能成为指纹

正确做法：用**真实 OS 默认值**（`viewport: null`），或者用 cloak binary 的**源码层 patch**（`--fingerprint=<seed>` 让二进制内部派生一致的指纹）。

历史上项目曾有 137 行 `STEALTH_ARGS` 走这条路，**已删除，不要重新引入。**

### 原则 3：CDP 一定要延迟初始化

如「包装层的导航级安全措施 §1」所述。任何在导航期间触发 `Network.enable` / `Debugger.enable` / `Audits.enable` 的代码都会破坏反检测。

### 原则 4：分清「stealth 删除」和「UX 删除」

清理 stealth 代码时**要按运行时行为分类、而不是按文件名分类**。例如 `--test-type` 历史上和 stealth 写在一起，但它的真实角色是 **UX flag**（banner 抑制器），不能跟其它 stealth 一起删。

判断方法：删除前问一句「这个 flag 在 runtime 里实际做什么？删了用户会立刻看到什么变化？」

### 原则 5：UA `Headed-only`

`headless: false` 硬编码，**不暴露 `--headless` flag**。理由：

- 用户场景就是看着浏览器调试
- headless 在多数 anti-bot 系统里仍然有别的检测手段（即使 navigator.webdriver 修了）
- 暴露 flag 等于给用户挖坑

## 已知残留泄露点

这些泄露在 Patchright、Scrapling 等同类工具中**也同样存在**，不影响通过主流反爬检测：

| 检测项                                 | 当前值                   | 期望值       | 说明                                                |
| -------------------------------------- | ------------------------ | ------------ | --------------------------------------------------- |
| `chrome.runtime`                       | `undefined`              | 应有完整对象 | Chrome 在被 CDP 控制时自动隐藏；cloak binary 也未补 |
| `chrome.app`                           | `undefined`              | 应有完整对象 | 同上                                                |
| `Error.stack` 在 `evaluate()` 调用栈里 | 含 isolated context 标记 | 应是普通栈   | Patchright 隔离世界标记，仅在 evaluate 时可见       |

**不要尝试在 JS 层面修复这些** —— 见原则 1。

## CDP-aware 调试工作流

因为导航工具刻意静默 CDP，**页面加载期间的请求、console、WebSocket、JS 脚本列表不会被收集**。这是设计如此 —— 先过风控、再开调试通道。

推荐工作流（**先导航再刷新**）：

```
# 1. 导航到目标页（静默，过风控）
new_page(url="https://example.com")

# 2. 任意非导航工具调用，触发 CDP collectors 激活
list_network_requests()   # 此时返回空，但 collectors 已启动

# 3. 刷新页面，完整捕获
navigate_page(type="reload")

# 4. 现在可以看到完整的请求列表
list_network_requests()
```

## 进一步阅读

- `--cloak` 完整指南、Profile 与指纹身份、双 MCP 实例配置：[cloak.md](cloak.md)
- CloakBrowser 项目（49 个 C++ patch 详解）：https://github.com/CloakHQ/CloakBrowser
- Patchright 协议层 stealth 工作原理：https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs
