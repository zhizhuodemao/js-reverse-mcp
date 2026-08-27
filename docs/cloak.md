# CloakBrowser 模式（`--cloak`）

`--cloak` 是 js-reverse-mcp 的一个**可选**启动开关，用于调试强反爬站点。它启用 [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) 团队定制的 Chromium 二进制（含 49 个 C++ 源码层指纹 patch），与默认的 Patchright 协议层 stealth 叠加，形成**双层反检测**。

## 何时该用 `--cloak`

| 场景                                                            | 推荐                                             |
| --------------------------------------------------------------- | ------------------------------------------------ |
| 调试自己的应用 / 公司内部系统                                   | **默认模式**（不加 `--cloak`）                   |
| 调试一般 SaaS / 电商 / 社交站点                                 | **默认模式**                                     |
| 调试 Cloudflare Turnstile / FingerprintJS / DataDome 防护的站点 | **`--cloak`**                                    |
| 需要登录 Google 服务（Gmail、Google Docs 等）                   | **默认模式**（cloak 二进制不带 Google 闭源服务） |
| 需要使用你电脑上已装的 Chrome 扩展                              | **默认模式**（cloak 没有 Chrome Web Store）      |

**简单原则**：99% 的调试用默认模式（系统 Chrome + Patchright）；只有具体被反爬拦截时再开 `--cloak`。

## 启用方式

在 MCP 配置里加 `--cloak`：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

如果你本地已经有 CloakBrowser，可同时传 `--cloakBinaryPath`，MCP 会直接使用该二进制，不触发首次自动下载：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": [
        "js-reverse-mcp",
        "--cloak",
        "--cloakBinaryPath",
        "D:\\develop_software\\CloakBrowser\\chrome.exe"
      ]
    }
  }
}
```

### **强烈推荐：先预下载二进制**

未传 `--cloakBinaryPath` 时，第一次启用 `--cloak` 会**静默下载 ~200MB** 的 CloakBrowser 二进制（缓存到 `~/.cloakbrowser/`，之后启动零延迟）。但在 MCP 协议下这个下载过程**没有进度反馈**，看起来像 MCP 卡住了 30–60 秒。

**最佳实践：把这一步从 MCP 上下文里拿出来，单独跑一次**：

```bash
npx cloakbrowser install
```

`cloakbrowser` 包已经作为 `js-reverse-mcp` 的 `optionalDependencies` 自动装在 npm 缓存里，这条命令只是触发它自带的二进制下载逻辑（有 stdout 进度条 + SHA-256 校验）。跑完之后再开 MCP 用 `--cloak`，启动直接秒过。

## 双层反检测架构

```
┌────────────────────────────────────────────────────────┐
│ 站点 JS 能看到的表面                                   │
├────────────────────────────────────────────────────────┤
│ 协议层：Patchright                                     │
│  • 不调用 Runtime.enable（避免最经典的 CDP 检测）       │
│  • 不调用 Console.enable                                │
│  • 默认在 isolated execution context 里执行 evaluate    │
│  • 移除 --enable-automation 等可探测的 launch flag      │
├────────────────────────────────────────────────────────┤
│ 源码层：CloakBrowser 二进制（49 个 C++ patch）          │
│  • navigator.webdriver = false（属性存在，匹配真实 Chrome）│
│  • canvas / WebGL / audio / fonts 源码级 spoofing       │
│  • GPU 字符串、屏幕尺寸从 fingerprint seed 派生         │
│  • TLS / JA3 / JA4 指纹与真实 Chrome 一致               │
└────────────────────────────────────────────────────────┘
```

两层都不需要 JS 注入。任何 `Object.defineProperty` 风格的反检测 hack 反而会成为指纹信号 —— 我们彻底避免。

## 平台伪装：在 macOS 上也报 Windows（但 ≠ 完整 Linux/Win 防护）

**`--cloak` 模式无视真实 OS，统一通过 `--fingerprint-platform=windows` 报 Windows 桌面身份**。但这**不等于**在 macOS 上拿到 Linux/Win build 的完整防护：

| 平台 build        | C++ patch 数 |
| ----------------- | ------------ |
| Linux x64 / arm64 | **57**       |
| Windows x64       | **57**       |
| macOS arm64 / x64 | **26**       |

CloakBrowser 的 macOS build **只编进了 26 个 patch**。在 mac 上跑 `--cloak`，**无论 `--fingerprint-platform` 设成什么**，底层仍然是这个 macOS build 的 26 个 patch。`--fingerprint-platform=windows` 只让**派生出来的指纹字符串**呈现 Windows 风格（UA、`navigator.platform`、GPU 名字），**但 31 个 macOS build 缺失的 patch 不会因此凭空出现**。

**在 macOS 上跑 cloak 强行报 Windows 的限制**：

- ✅ `navigator.userAgent`、`navigator.platform`、`screen.width/height` 全部呈现 Windows 桌面值
- ✅ WebGL vendor/renderer 派生为 Windows GPU 字符串（如 `Google Inc. (NVIDIA)` + `RTX 3090`）
- ❌ **WebGL 字符串的细节一致性**（device ID 格式、版本后缀等）可能跟真实 Windows + RTX 3090 输出不严格匹配 —— 主动检测器（如 BrowserScan）能识别出
- ❌ canvas / audio / 字体的派生值跟 GPU 上下文的内部一致性 —— 也是 26 patches 没完整覆盖的部分

### BrowserScan 实测对比

| 设置                                                      | WebGL vendor / renderer 是否被 BrowserScan 标红 |
| --------------------------------------------------------- | ----------------------------------------------- |
| 真实 macOS Chrome（用户自己日常用的）                     | ❌ 不红                                         |
| basic 模式（系统 Chrome + Patchright）                    | ❌ 不红                                         |
| **cloak macOS build 配 `--fingerprint-platform=windows`** | 🔴 **红**（被识别为「反指纹技术」）             |

说明 cloak 在 macOS 上即使切到 Windows fingerprint 也无法蒙过主动 WebGL 检测。

### 怎么才能拿到 57 patches 全套

只能跑 **Linux 或 Windows build 的 cloak**：

```bash
# Docker 跑 Linux build，CDP 暴露到 host
docker run -d --name cloak \
  -p 127.0.0.1:9222:9222 \
  cloakhq/cloakbrowser \
  cloakserve --headless=false
```

然后 MCP 用 `--browserUrl http://127.0.0.1:9222` 连过去（这是我们保留 `--browserUrl` 的用场之一）。

**Docker 在 macOS 上的代价**：

- Docker for Mac 默认无 X server → Linux 浏览器跑起来但看不见
- noVNC 方案：浏览器里看浏览器，调试体验差
- 真心要看到窗口、且要强反爬 → Linux/Windows 物理机更顺手

### 重要：BrowserScan ≠ 真实生产反爬

BrowserScan 是**主动指纹检测器**演示站，比绝大多数实际反爬严格。Cloudflare Turnstile / FingerprintJS / DataDome 用的是**综合行为评分**，关注点跟 BrowserScan 不一致。

**真实判断标准是「你实际想调试的目标站点能不能进」**：

- 能进 → cloak macOS（26 patches）够用，BrowserScan 多少红条都无所谓
- 进不去 → 才考虑升级到 Docker Linux cloak

**别以「BrowserScan 全绿」为产品目标**。它是 stress test，不是 reality。

### 如果你想切回 macOS profile 模式

极少数场景需要（如调试明确针对 macOS Safari 的内容），改 `src/cloak.ts:99` 里的 `const platform = 'windows'` 一行即可。

## 跟默认模式的差异

| 维度                   | 默认（系统 Chrome）                           | `--cloak`（CloakBrowser 二进制）             |
| ---------------------- | --------------------------------------------- | -------------------------------------------- |
| 浏览器二进制           | 系统装的 Google Chrome                        | 从 Chromium 开源代码编译的隐身版             |
| Chrome Web Store       | ✅ 有                                         | ❌ 无（Chromium 不含 Google 闭源服务）       |
| Google sync / 账号集成 | ✅                                            | ❌                                           |
| 你电脑上已装的扩展     | ✅ 全部可见                                   | ❌ 不可见                                    |
| Widevine DRM           | ✅                                            | ❌（视频站点的加密内容可能播不了）           |
| 指纹防护               | 协议层（Patchright）                          | 协议层 + 源码层（49 个 C++ patch）           |
| 启动速度               | 快                                            | 首次下载 ~30-60s，之后正常                   |
| 反爬通过率             | 中等                                          | 高（30+ 检测站测试通过）                     |
| 持久化 profile 路径    | `~/.cache/chrome-devtools-mcp/chrome-profile` | `~/.cache/chrome-devtools-mcp/cloak-profile` |

**关键：两个模式的 profile 目录物理隔离**，互不污染。不同 Chromium 版本的 cache/extension state 混在一起会破坏启动。

## Profile 与指纹身份的关系

`--cloak` 模式下，每个 profile 目录绑定一个**持久化的虚拟身份**：

- 首次启动：随机生成 fingerprint seed（10000–99999 范围），写入 `<profile>/.cloak-seed`
- 之后启动：读取同一个 seed，**呈现完全相同的指纹**（canvas / WebGL / GPU / 屏幕全部一致）
- 模拟「同一个虚拟设备多次访问同一个站点」 —— 比每次随机更不可疑

### 想换一个全新身份

删掉 seed 文件，下次启动重新生成：

```bash
rm ~/.cache/chrome-devtools-mcp/cloak-profile/.cloak-seed
```

### 想要一次性、不留痕

加 `--isolated`：

```bash
npx js-reverse-mcp --cloak --isolated
```

每次启动是临时 profile + 临时随机 seed，浏览器关掉自动清理。

## 验证 `--cloak` 是否生效

启动后，通过 MCP 工具调用 `evaluate_script`：

```javascript
() => ({
  ua: navigator.userAgent,
  webdriver: navigator.webdriver,
  platform: navigator.platform,
  plugins: navigator.plugins.length,
});
```

预期输出：

```json
{
  "ua": "...Chrome/145.0.0.0 Safari/537.36",
  "webdriver": false,
  "platform": "MacIntel",
  "plugins": 5
}
```

UA 里的 `Chrome/145.0.0.0` 是 cloak 二进制的版本（你系统 Chrome 的版本通常更新，比如 142+）。版本不一致就证明 cloak 起作用了。

要更严格地验证反爬效果，访问这些站点：

- https://abrahamjuliot.github.io/creepjs/ — 综合指纹 trust score
- https://bot.sannysoft.com/ — 自动化检测矩阵
- https://browserscan.net/ — 商业反爬服务

## 双 MCP 实例（推荐配置）

如果你需要同时调普通站点和强反爬站点，配置两个 MCP 实例最干净：

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

两个实例：

- profile 物理隔离
- 互相不知道对方存在
- 调哪个站点用哪个

## 故障排除

### macOS Gatekeeper 拦截首次启动

cloak 二进制是 ad-hoc 签名。第一次 macOS 可能挡住：

```bash
xattr -cr ~/.cloakbrowser/chromium-*/Chromium.app
```

### 启动报「Connection closed」/ session 异常

通常是 profile 目录有跨浏览器残留（之前别的 Chromium 版本写过的 cache）。物理隔离的 cloak profile 不应该出现这问题，但万一遇到：

```bash
rm -rf ~/.cache/chrome-devtools-mcp/cloak-profile/
```

下次启动会重新创建。

### 二进制下载失败

cloakbrowser.dev 主站访问慢时，cloakbrowser 包会自动回退到 GitHub Releases。也可以手动设环境变量：

```bash
# 自定义下载镜像
export CLOAKBROWSER_DOWNLOAD_URL=https://your-mirror.example.com

# 或直接指向本地已有的 Chromium 二进制
export CLOAKBROWSER_BINARY_PATH=/path/to/your/Chromium
```

### 强反爬站点仍被拦

cloak 二进制只解决**指纹层**反爬。如果还被拦，通常是另一类问题：

1. **IP 信誉差**：数据中心 IP 会被 IP-reputation 数据库标记 → 用住宅代理
2. **行为分析触发**：你执行操作太快、太机械 → 这超出 MCP 调试场景，得用人类节奏操作
3. **TLS 指纹**：cloak 二进制 TLS 指纹跟真实 Chrome 一致，正常不会被这一项拦

## 进一步阅读

- CloakBrowser 项目：https://github.com/CloakHQ/CloakBrowser
- Patchright 项目：https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs
- 本项目的反检测分层全景：[anti-detection-work.md](anti-detection-work.md)
