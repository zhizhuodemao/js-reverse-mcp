# GUI 工作流脚本 — 后续规划

已完成的基础模块：

- [x] cdp-client.mjs — CDP 连接层（GUI/CLI 共享）
- [x] discover-apis.mjs — API 端点发现
- [x] intercept-response.mjs — 网络响应拦截与篡改
- [x] bulk-collect.mjs — 批量分页采集

待完善：

- [ ] page-navigate.mjs — 多步骤导航链（支持条件等待、重试）
- [ ] capture-screenshot.mjs — 自动截图（可调用 MCP Server 的 take_screenshot 复用）
- [ ] extract-table.mjs — 从页面提取表格数据
- [ ] evaluate-flow.mjs — 执行 JS 并跟踪返回值变化
- [ ] export-to-curl.mjs — 将捕获的请求导出为 curl 命令

与 MCP Server 整合：

- [ ] 在 package.json 中添加 `scripts/gui/` 路径
- [ ] 统一 CLI 参数格式（与 MCP CLI 的 flag 风格对齐）
- [ ] 新增 `--gui` 启动参数，启动后进入交互式 GUI 模式提示

## 设计理念

GUI 脚本遵循以下原则：

1. **不重复实现 MCP Server 已有功能** — 断点、源码分析、Console 使用 MCP Server 的 21 个工具
2. **提供更高层的工作流封装** — API 发现、批量采集、响应拦截是跨场景的通用步骤
3. **与 CLI 模式共享 CDP 连接** — 所有脚本都基于 `cdp-client.mjs`，该模块也可被 MCP Server 内部引用
4. **浏览器实例复用** — GUI 脚本和 MCP Server 可以连接同一个浏览器，互不干扰
