# JS Reverse MCP

JavaScript 逆向工程 MCP 服务器，让你的 AI 编码助手（如 Claude、Cursor、Copilot）能够调试和分析网页中的 JavaScript 代码。

## 功能特点

- **脚本分析**: 列出所有加载的 JS 脚本，搜索代码，获取源码
- **断点调试**: 设置/移除断点，支持条件断点，支持在压缩代码中精确定位
- **函数追踪**: Hook 任意函数（包括模块内部函数），监控调用和返回值
- **执行控制**: 暂停/恢复执行，单步调试（step over/into/out）
- **运行时检查**: 在断点处求值表达式，检查作用域变量
- **网络分析**: 查看请求发起的调用栈，设置 XHR 断点
- **事件监控**: 监控 DOM 事件，检查存储数据

## 系统要求

- [Node.js](https://nodejs.org/) v20.19 或更新版本
- [Chrome](https://www.google.com/chrome/) 稳定版
- Git

## 本地安装

```bash
# 克隆仓库
git clone https://github.com/zhizhuodemao/js-reverse-mcp.git
cd js-reverse-mcp

# 安装依赖
npm install

# 构建项目
npm run build
```

## MCP 客户端配置

在你的 MCP 客户端配置文件中添加：

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

### Claude Code

```bash
claude mcp add js-reverse node /你的路径/js-reverse-mcp/build/src/index.js
```

### Cursor

进入 `Cursor Settings` -> `MCP` -> `New MCP Server`，使用上面的配置。

### VS Code Copilot

```bash
code --add-mcp '{"name":"js-reverse","command":"node","args":["/你的路径/js-reverse-mcp/build/src/index.js"]}'
```

## 工具列表

### 脚本分析

| 工具                | 描述                                                 |
| ------------------- | ---------------------------------------------------- |
| `list_scripts`      | 列出页面中所有加载的 JavaScript 脚本                 |
| `get_script_source` | 获取脚本源码，支持行范围或字符偏移（适用于压缩文件） |
| `find_in_script`    | 在脚本中查找文本，返回精确的行号和列号               |
| `search_in_sources` | 在所有脚本中搜索字符串或正则表达式                   |

### 断点管理

| 工具                     | 描述                                           |
| ------------------------ | ---------------------------------------------- |
| `set_breakpoint`         | 在指定 URL 和行号设置断点                      |
| `set_breakpoint_on_text` | 通过搜索代码文本自动设置断点（适用于压缩代码） |
| `remove_breakpoint`      | 移除断点                                       |
| `list_breakpoints`       | 列出所有活动断点                               |

### 调试控制

| 工具                    | 描述                             |
| ----------------------- | -------------------------------- |
| `get_paused_info`       | 获取暂停状态、调用栈和作用域变量 |
| `resume`                | 恢复执行                         |
| `pause`                 | 暂停执行                         |
| `step_over`             | 单步跳过                         |
| `step_into`             | 单步进入                         |
| `step_out`              | 单步跳出                         |
| `evaluate_on_callframe` | 在暂停的调用帧上下文中求值表达式 |

### 函数 Hook

| 工具              | 描述                                                   |
| ----------------- | ------------------------------------------------------ |
| `hook_function`   | Hook 全局函数或对象方法，记录调用和返回值              |
| `unhook_function` | 移除函数 Hook                                          |
| `list_hooks`      | 列出所有活动的 Hook                                    |
| `trace_function`  | 追踪任意函数调用（包括模块内部函数），使用条件断点实现 |

### 网络调试

| 工具                    | 描述                             |
| ----------------------- | -------------------------------- |
| `get_request_initiator` | 获取网络请求的 JavaScript 调用栈 |
| `break_on_xhr`          | 设置 XHR/Fetch 断点              |
| `remove_xhr_breakpoint` | 移除 XHR 断点                    |

### 检查工具

| 工具             | 描述                                       |
| ---------------- | ------------------------------------------ |
| `inspect_object` | 深度检查 JavaScript 对象结构               |
| `get_storage`    | 获取 cookies、localStorage、sessionStorage |
| `monitor_events` | 监控元素或 window 上的 DOM 事件            |
| `stop_monitor`   | 停止事件监控                               |

### 页面导航

| 工具            | 描述                       |
| --------------- | -------------------------- |
| `list_pages`    | 列出浏览器中打开的页面     |
| `select_page`   | 选择一个页面作为调试上下文 |
| `new_page`      | 创建新页面并导航到 URL     |
| `navigate_page` | 导航当前页面               |

### 其他工具

| 工具                    | 描述                    |
| ----------------------- | ----------------------- |
| `take_screenshot`       | 截取页面截图            |
| `take_snapshot`         | 获取页面 DOM 快照       |
| `evaluate_script`       | 在页面中执行 JavaScript |
| `list_console_messages` | 获取控制台消息          |
| `list_network_requests` | 列出网络请求            |
| `get_network_request`   | 获取请求详情和响应内容  |

## 使用示例

### 基本流程

1. **选择页面**

```
列出所有页面并选择要调试的页面
```

2. **查找目标函数**

```
搜索包含 "encrypt" 的代码
```

3. **设置断点**

```
在加密函数上设置断点
```

4. **触发并分析**

```
触发操作，在断点处检查参数和调用栈
```

### Hook 加密函数

```
Hook fetch 函数，记录所有 API 调用的参数和返回值
```

### 追踪模块内部函数

```
使用 trace_function 追踪 webpack 打包的内部函数 "encryptData"
```

## 配置选项

| 选项                   | 描述                                   |
| ---------------------- | -------------------------------------- |
| `--browserUrl, -u`     | 连接到运行中的 Chrome 实例             |
| `--wsEndpoint, -w`     | WebSocket 端点连接                     |
| `--headless`           | 无头模式运行（默认: false）            |
| `--executablePath, -e` | 自定义 Chrome 路径                     |
| `--isolated`           | 使用临时用户数据目录                   |
| `--channel`            | Chrome 通道: stable, canary, beta, dev |
| `--viewport`           | 初始视口大小，如 `1280x720`            |

### 示例配置

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "node",
      "args": [
        "/你的路径/js-reverse-mcp/build/src/index.js",
        "--headless=false",
        "--isolated=true"
      ]
    }
  }
}
```

### 连接到已运行的 Chrome

1. 启动 Chrome（需要关闭所有 Chrome 窗口后重新启动）：

**macOS**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

**Windows**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-debug"
```

2. 配置 MCP 连接：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "node",
      "args": [
        "/你的路径/js-reverse-mcp/build/src/index.js",
        "--browser-url=http://127.0.0.1:9222"
      ]
    }
  }
}
```

## 安全提示

此工具会将浏览器内容暴露给 MCP 客户端，允许检查、调试和修改浏览器中的任何数据。请勿在包含敏感信息的页面上使用。

## 许可证

Apache-2.0
