# 如何拿到 CDP 调试端口（`--browserUrl` 的输入）

`js-reverse-mcp` 只接受**一种**形式的浏览器连接：一个能响应 Chrome DevTools Protocol 的 HTTP 端点（即 `--browserUrl http://127.0.0.1:<port>`）。它会自动探测 `/json/version` 拿到 WebSocket debugger URL，再用 Patchright over CDP 接管。

> **明确不支持**：厂商私有的 Local API（AdsPower `:50325`、BitBrowser `:54345` 等）、Bearer Token 鉴权、`webdriver://` 这类自动化协议。这些都是"管理面"，**不是** CDP。MCP 这一层只做 plumbing，对厂商一无所知 —— 厂商怎么暴露 CDP 是上游的事。

本文讲清楚一件事：**怎么从你手里的浏览器拿到那个真正的 CDP 端口**。

---

## 通用：怎么判断手里的端口是不是 CDP

一行 `curl`，看返回：

```bash
curl http://127.0.0.1:<port>/json/version
```

| 返回                                            | 结论                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| JSON，里面有 `webSocketDebuggerUrl: "ws://..."` | ✅ 就是 CDP，可以直接给 MCP                       |
| `Not Found` / `404` / 任何非 JSON               | ❌ 这个端口不是 CDP（很可能是某厂商的 Local API） |
| `401` / `Unauthorized`                          | ❌ CDP 不要鉴权，能要鉴权的肯定不是 CDP           |
| 连不上 / `Connection refused`                   | ❌ 浏览器没起来，或端口写错                       |

任何时候 MCP 报 `Unexpected token 'N', "Not Found" is not valid JSON`，就是 MCP 在 `/json/version` 拿到了非 JSON。99% 是端口指错了厂商管理 API。

---

## 场景 1：本地 Chrome / Edge / Chromium

最简单的情况：自己用调试端口启动一个 Chrome，端口你定。

### macOS

```bash
# 关掉所有已开的 Chrome 窗口（必须！），然后：
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

### Windows

```powershell
# PowerShell：先把所有 Chrome 都关掉
"C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\chrome-debug"
```

### Linux

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

### Edge / 其他 Chromium 系

把可执行文件替换成对应的（Edge 用 `msedge`、Brave 用 `brave-browser`），参数完全一样。

### 关键提醒

- **必须先关掉所有已开的同款浏览器进程**，否则新命令会被忽略 —— Chrome 检测到已有实例就直接复用，不会开启调试端口。
- **强烈建议用专门的 `--user-data-dir`**（如上 `/tmp/chrome-debug`），**不要**直接挂你的日常 profile。否则 MCP 跑的所有事都会落到你日常账号上（cookies、扩展、历史全会受影响）。
- 端口随便挑没占用的就行，9222 是社区默认值。

### 验证 + 配置 MCP

```bash
curl http://127.0.0.1:9222/json/version  # 应返回包含 webSocketDebuggerUrl 的 JSON
```

`.mcp.json`：

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

---

## 场景 2：AdsPower（详细示例）

AdsPower 上有**两个不一样的 HTTP 端口**，初学者常搞混：

| 端口                               | 是什么                                                 | 给 MCP 用？ |
| ---------------------------------- | ------------------------------------------------------ | ----------- |
| `50325`（默认）                    | AdsPower **Local API**，管理面，需要 Bearer Token 认证 | ❌ 不是 CDP |
| 启动浏览器后动态分配（如 `58229`） | 真正的 Chrome **CDP 调试端口**，无鉴权                 | ✅ 给 MCP   |

CDP 端口是**每次启动浏览器都随机变**的，不能写死。流程必须是"先调 Local API 启浏览器、从响应里拿 `debug_port`、再用这个端口拼 `--browserUrl`"。

### Step 1：拿 API Key

AdsPower 客户端 → 自动化 → API → API Key（CLI 模式或开了"安全校验"时必须用，否则也建议用）。

### Step 2：查询你的环境 ID

```bash
curl 'http://127.0.0.1:50325/api/v1/user/list?page=1&page_size=10' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

响应里 `data.list[].user_id` 就是 profile_id，类似 `k1c4bc0d`。

### Step 3：启动浏览器，拿 debug_port

```bash
curl 'http://127.0.0.1:50325/api/v1/browser/start?user_id=YOUR_PROFILE_ID' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

成功响应：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "ws": {
      "puppeteer": "ws://127.0.0.1:58229/devtools/browser/14bf4496-...",
      "selenium": "127.0.0.1:58229"
    },
    "debug_port": "58229",
    "webdriver": "/.../chromedriver"
  }
}
```

记下 `data.debug_port`（这里是 `58229`，你那次会不一样）。

### Step 4：给 MCP

```bash
# 先验证
curl http://127.0.0.1:58229/json/version
```

`.mcp.json`：

```json
{
  "mcpServers": {
    "js-reverse-adspower": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browserUrl", "http://127.0.0.1:58229"]
    }
  }
}
```

### 端口每次都变 —— 一键启动脚本

把"启 AdsPower → 解析端口 → 启 MCP"串成一条命令。下面是 bash 版（macOS/Linux），Windows 用户可改成 PowerShell 或直接用 WSL。

```bash
#!/usr/bin/env bash
# scripts/adspower-mcp.sh
# Usage: ADSPOWER_API_KEY=xxx ADSPOWER_PROFILE_ID=k1c4bc0d ./adspower-mcp.sh
set -euo pipefail

: "${ADSPOWER_API_KEY:?need ADSPOWER_API_KEY}"
: "${ADSPOWER_PROFILE_ID:?need ADSPOWER_PROFILE_ID}"
ADSPOWER_HOST="${ADSPOWER_HOST:-http://127.0.0.1:50325}"

resp=$(curl -fsS "${ADSPOWER_HOST}/api/v1/browser/start?user_id=${ADSPOWER_PROFILE_ID}" \
  -H "Authorization: Bearer ${ADSPOWER_API_KEY}")

port=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['debug_port'])")

# Sanity check：CDP 一定能响应 /json/version
curl -fsS "http://127.0.0.1:${port}/json/version" >/dev/null

# stdio 透传给 MCP client（重要：MCP 走 stdout）
exec npx js-reverse-mcp --browserUrl "http://127.0.0.1:${port}"
```

`.mcp.json` 把 `command` 指向脚本：

```json
{
  "mcpServers": {
    "js-reverse-adspower": {
      "command": "/absolute/path/to/adspower-mcp.sh",
      "env": {
        "ADSPOWER_API_KEY": "...",
        "ADSPOWER_PROFILE_ID": "..."
      }
    }
  }
}
```

> ⚠️ `.mcp.json` 这种地方写 API Key 之前，先确认它在 `.gitignore` 里。本仓库默认是 ignore 的。

---

## 场景 3：BitBrowser（比特指纹）

接口风格和 AdsPower 类似，但端口、字段名不同。以下基于 BitBrowser 公开文档，未在仓库 CI 中测试过，使用时以你那边实际响应为准。

| 端口            | 用途                                     |
| --------------- | ---------------------------------------- |
| `54345`（默认） | BitBrowser Local API（POST + JSON 风格） |

### 启动浏览器拿 CDP

```bash
curl -X POST 'http://127.0.0.1:54345/browser/open' \
  -H 'Content-Type: application/json' \
  -d '{"id":"YOUR_PROFILE_ID"}'
```

预期响应（关注 `data.http` 字段，那就是 CDP HTTP 端点 `127.0.0.1:<port>`）：

```json
{
  "success": true,
  "data": {
    "http": "127.0.0.1:12345",
    "ws": "ws://127.0.0.1:12345/devtools/browser/xxxx",
    "driver": "/.../chromedriver",
    "port": 12345
  }
}
```

### 给 MCP

```bash
curl http://127.0.0.1:12345/json/version  # 验证
```

```json
{
  "mcpServers": {
    "js-reverse-bit": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--browserUrl", "http://127.0.0.1:12345"]
    }
  }
}
```

同样：端口动态变化、想自动化就照场景 2 末尾的 bash 脚本改字段名（`data.http` 或 `data.port` 替换 `data.debug_port`）。

---

## 通用故障排除

| 现象                                                           | 原因                                                                    | 怎么办                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Unexpected token 'N', "Not Found"`                            | MCP 拿到的不是 JSON，端口不对                                           | 用 `curl /json/version` 自检；十有八九你把厂商 Local API 端口给 MCP 了 |
| `Unexpected token '<', "<!DOCTYPE..."`                         | 拿到的是 HTML，端口不对                                                 | 同上                                                                   |
| `ECONNREFUSED`                                                 | 端口没监听                                                              | 浏览器没起来；或者端口号错了                                           |
| 401 / 403 / `Unauthorized`                                     | 端口需要鉴权                                                            | CDP 是不鉴权的，这个端口一定不是 CDP                                   |
| `/json/version` 正常但 MCP 报 `The browser is already running` | 你 MCP 本身在 launch 模式，又恰好你启动的 Chrome 占了默认 user-data-dir | 用 `--browserUrl` 模式（这份文档讲的），或者用 `--isolated`            |

---

## 其他厂商（Multilogin / Hubstudio / Dolphin{anty} / VMLogin / Gologin ...）

思路完全一样，只是 API 路径和字段名不同。三步通用 checklist：

1. 找厂商的 **Local API** 文档（一般在它的官网"自动化"/"开发者"章节）
2. 找"启动浏览器"那个接口，POST/GET 都行，看返回里哪个字段是 CDP 端点（关键词：`ws`、`webSocketDebuggerUrl`、`debug_port`、`http`、`puppeteerWs`）
3. 提取出 `host:port`，用 `curl http://host:port/json/version` 验证有 `webSocketDebuggerUrl` 后，传给 MCP `--browserUrl`

没必要在 MCP 这一层做任何厂商适配 —— **MCP 这一层只关心 CDP，端口怎么拿是你的事**。
