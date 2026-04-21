# 共享 SSH 终端前端设计文档

## 1. 目标

把当前项目从“只读 viewer + MCP 控制 SSH”升级为“共享 SSH 终端前端”：

- 终端主画面接近 MobaXterm / Xshell / SecureCRT 的使用体验
- 远端只有一个真实 SSH PTY 会话
- AI Agent 可以通过 MCP 持续接管这个会话并发送命令
- 用户也可以在同一个前端中直接手动输入
- 用户输入和 AI 输入都要能区分来源
- 来源标记应由本地 UI 渲染，不应污染远端终端流

一句话定义：

> 一个用户与 AI 共用同一 SSH PTY 的共享终端前端，终端输出保持原样，输入来源通过本地叠加层标记。

## 2. 为什么不能继续沿用当前 viewer

当前 viewer 的本质是“读取会话状态后重新排版输出”：

- 它是轮询式、只读的
- 它不是一个真正的终端模拟器
- 它把 SSH 输出和输入事件重新组织为文本 dashboard

这不适合做真正交互式终端，原因如下：

- 如果把 `[user]` / `[codex]` 直接插入远端流，会污染真实终端画面
- 一旦运行 `vim`、`top`、`htop`、`less`、`tmux`、ROS TUI 等程序，额外插入的文本会破坏界面
- 当前 viewer 会清理部分控制字符和 ANSI 行为，不能完整保留终端状态

因此后续方向必须从“读状态后重绘 dashboard”转为“真实终端附着 + 本地事件标记层”。

## 3. 核心设计原则

### 3.1 真实终端流与来源标记分离

必须分成两条通道：

- 终端通道
  - 只承载真实 SSH PTY 输出
  - 不插入任何额外标记
  - 保留 ANSI、光标控制、全屏程序行为

- 来源事件通道
  - 单独记录谁发送了什么输入
  - 用于本地 UI 的提示、颜色、图标、事件条
  - 不回写到远端 shell

### 3.2 单会话共享

用户和 AI 不应各自连自己的 SSH：

- 只维护一个远端 PTY
- 用户输入和 AI 输入都写入同一个 `SSHSession`
- 所有输出都从同一个 PTY 回流

这样才能保证：

- 用户看到的就是 AI 实际操作的上下文
- AI 看到的也是用户刚刚手动执行后的结果
- 不会出现两个终端状态不一致

### 3.3 标记是 UI 叠加，不是终端内容

来源区分通过本地界面体现，例如：

- 输入框提交后在终端顶部短暂显示一条事件提示
- 左侧窄栏显示最近几条输入来源
- 底部事件条显示最近命令是谁发的
- 颜色区分 `user` / `codex` / `claude`

不推荐把标记作为字符写进终端。

## 4. 用户体验目标

### 4.1 主画面

目标 UI：

- 中央是一整块正常终端
- 不再使用左右双栏
- 终端行为应尽可能接近原生 SSH 客户端
- 支持窗口 resize
- 支持 ANSI 彩色输出
- 支持全屏程序
- 支持复制、滚动、粘贴

### 4.2 来源提示

推荐第一阶段的来源标记形式：

- 底部状态条显示最近输入事件
- 颜色区分来源
  - `user`：蓝色
  - `codex`：橙色
  - `claude`：紫色或青色
  - `session`：灰色
- 每条事件包含：
  - 来源
  - 时间
  - 命令摘要

第一阶段不强求复杂图标，只要颜色与文本标签足够稳定即可。

### 4.3 用户可直接接管

用户必须能够像正常 SSH 工具那样直接输入：

- 键盘输入直接发往远端 PTY
- 回车、方向键、Tab、Ctrl+C 等控制键应被正常转发
- 用户不需要绕过 MCP 再调用额外命令

### 4.4 AI 可继续接管

AI 继续通过 MCP 工具控制会话：

- `ssh-session-send`
- `ssh-session-control`
- `ssh-session-resize`

共享终端前端只是新增了“用户附着入口”，不会替代 AI 的 MCP 路径。

## 5. 技术方向

## 5.1 总体方案

采用“本地终端前端 + MCP 持有 SSH 会话”的结构：

- MCP 服务仍然持有 SSH 连接与会话对象
- 本地 viewer server 升级为“终端附着服务”
- 前端界面只作为一个 attach client
- 用户与 AI 都向 MCP 中的同一个 `SSHSession` 写入

数据流：

1. MCP 打开 SSH PTY
2. AI 通过 MCP tool 写入
3. 用户通过终端前端写入
4. SSH PTY 输出统一回流到 MCP
5. 前端订阅终端输出增量
6. 前端单独订阅输入来源事件

## 5.2 前端形态选择

第一优先级建议：

- 浏览器终端前端

原因：

- 当前项目已经具备本地 HTTP viewer server
- 在现有架构上扩展成本最低
- 可以复用成熟终端模拟器而不是自己在控制台里硬写
- 用户体验更接近图形化 SSH 工具

推荐技术：

- `xterm.js` 作为终端模拟器
- 本地 viewer server 提供静态页面和 attach API

后续可选增强：

- Windows 单独封装桌面壳
- 或继续保留 `viewer-cli` 作为纯终端旁观模式

## 5.3 通信模型

建议新增两类本地接口：

- 输出流接口
  - 用于把远端 PTY 输出增量推送到 attach 前端
  - 首选 WebSocket
  - 次选 Server-Sent Events

- 输入写入接口
  - 用于前端把用户按键、粘贴内容、控制键发送给 MCP
  - 可以走 WebSocket 双向消息
  - 也可以走 HTTP POST，但实时性和状态同步较差

首选方案：

- WebSocket 双向通信

原因：

- 终端天然是实时双向交互
- 更适合处理 resize、paste、control keys、focus、detach 等事件

## 6. 新的运行模型

### 6.1 会话对象

现有 `SSHSession` 继续作为单一真实会话源，不拆分。

需要新增：

- attach client 概念
  - 一个会话可以有 0..n 个本地附着前端
- provenance/input event 流
  - 记录最近一次用户或 AI 发送了什么

### 6.2 输出缓存

需要区分两类缓存：

- 原始终端输出缓存
  - 尽量保留 ANSI 和控制序列
  - 供 attach 前端直接消费

- 输入来源事件缓存
  - 记录 `actor`、时间、摘要、类型
  - 供 UI 做状态条与来源标记

当前项目里 `normalizePaneText()` 这类用于 dashboard 文本化显示的逻辑，不应作为 attach 前端的主输出通道。

### 6.3 输入来源记录

建议定义：

- `actor=user`
- `actor=codex`
- `actor=claude`
- `actor=session`

记录策略：

- 普通输入
  - 在提交时记录摘要
- 控制键
  - 单独记录控制事件
- resize
  - 记录系统事件

注意：

- 不要按“每个按键”写一条 provenance
- 否则事件流会非常嘈杂

第一阶段推荐：

- 用户按回车后记录一次命令摘要
- AI 每次 `ssh-session-send` 记录一次摘要
- 控制键单独记录

## 7. UI 设计

### 7.1 第一阶段可用版

目标：先把“像正常 SSH 工具一样使用”做出来。

建议布局：

- 主区域
  - 全屏终端
- 顶部状态条
  - 会话名
  - 主机
  - 连接状态
  - AI 状态
- 底部事件条
  - 显示最近 1 到 5 条输入事件

示例：

- `[user] ros2 launch ...`
- `[codex] cat /etc/os-release`
- `[session] resized 160x40`

### 7.2 第二阶段增强版

可选增强：

- 左侧窄栏显示历史事件
- 用户输入时短暂高亮边框
- AI 正在发送命令时显示“AI active”
- 用户强制打断时显示提示
- 多个 attach client 并发可见

## 8. 并发与接管策略

共享会话最大的风险不是连接，而是“谁正在操作”。

需要定义策略：

- 默认允许用户与 AI 都能写入
- UI 提示当前最近活跃输入来源
- 用户可随时手动打断 AI

第一阶段不做硬锁，只做软提示：

- AI 发命令时，状态栏显示 `AI active`
- 用户一旦输入，状态栏切换为 `User active`
- 若短时间内双方连续输入，只做事件记录，不阻止

后续可选增强：

- soft lock
- explicit handoff
- user interrupt hotkey

## 9. 安全边界

本设计仍坚持现有边界：

- SSH 数据不主动上传第三方服务器
- attach UI 默认只绑定本地 `127.0.0.1`
- 前端只是本机附着界面，不改变 SSH 终端的远端权限模型

新增风险点：

- 一旦前端变成可写，本地 viewer server 就不再只是只读接口
- 因此前端 attach 接口必须默认只监听本地地址
- 如果以后允许远程浏览器连接，需要单独加鉴权

## 10. 分阶段实施计划

### 第一阶段：可用版

目标：

- 一个真正可输入的共享终端前端
- AI 和用户共用同一个 SSH PTY
- UI 能显示最近输入来源

实现项：

- 引入真实终端渲染前端
- viewer server 新增 attach 双向通信
- 用户输入写入 `SSHSession`
- AI 输入继续走 MCP
- 前端显示最近 provenance 事件

交付结果：

- 能像正常 SSH 工具一样使用
- 用户看到 AI 的操作
- AI 看到用户的操作
- 不污染远端终端流

### 第二阶段：增强版

目标：

- 更接近成熟 SSH 工具体验

实现项：

- 更完整的状态条
- 更好的输入来源高亮
- 用户打断 AI 的提示机制
- attach 多实例策略
- 更好的滚动和历史浏览

## 11. 当前版本与目标版本的关系

当前版本：

- 有 SSH 会话管理
- 有 actor 概念
- 有 viewer server
- 有只读终端观察能力

缺失部分：

- 真正的可写 attach 前端
- 原始终端输出直通渲染
- 本地 UI 叠加层来源标记
- 用户与 AI 共用同一前端输入能力

结论：

当前仓库已经具备“共享 SSH 会话”的后端基础，但前端仍停留在“观察器”阶段。  
后续改造重点不在 SSH 本身，而在“把 viewer 升级为共享终端前端”。

## 12. 实施结论

后续开发方向正式确定为：

- 不再继续强化只读 dashboard
- 改为共享 SSH 终端前端
- 终端内容保持原样
- 输入来源标记只在本地 UI 中表现
- 第一阶段先完成”可像 MobaXterm 一样使用”的可用版

## 13. 答疑记录

### 第一轮：核心技术决策

**Q1: xterm.js 页面策略**

决定：新增 xterm.js 终端页面，保留旧版浏览器页面作为 fallback。

- 新增路由（如 `/terminal/session/:id`、`/terminal/binding/:key`）使用 xterm.js 真实终端渲染
- 旧的 `/session/:id` 和 `/binding/:key` 页面保留，继续作为轻量级 fallback
- 首页增加入口链接到新终端页面

**Q2: 通信协议**

决定：全部迁移到 WebSocket。

- viewer-cli.ts 也从 HTTP 轮询改为 WebSocket 连接
- 现有 HTTP attach API（`/api/attach/...`）废弃，统一走 WebSocket
- WebSocket 端点挂在现有 viewer server 上，不新开端口
- 双向消息：服务端推送终端输出增量 + 事件流，客户端发送用户输入 + 控制键 + resize

**Q3: 前端资源加载**

决定：CDN 引入 xterm.js。

- 通过 unpkg 或 jsdelivr 在 HTML 中直接引入 xterm.js 和 xterm-addon-fit
- 不引入 Vite/webpack 等前端构建工具
- 继续使用服务端拼 HTML 字符串的方式生成页面

**Q4: 实施范围与核心定位**

决定：这不是”viewer 小改版”，而是新增”interactive attach mode”。

核心定位：
- 一个 MobaXterm 风格的共享 SSH 终端
- 用户和 AI 共用同一个远端 PTY
- 本地 UI 标记每次输入的来源，不污染远端终端流

实施范围（第一阶段）：
- xterm.js 真实终端渲染（保留 ANSI、光标控制、全屏程序）
- WebSocket 双向通信（替代 HTTP 轮询）
- 用户可直接在终端界面输入，键盘透传到远端 PTY
- AI 继续通过 MCP 工具发送命令
- 底部状态条显示最近输入来源（颜色区分 user/codex/claude）
- Ctrl+] 脱离 attach
- viewer-cli 新增 --interactive 模式（或默认改为交互模式）
- 输入记录策略：回车提交时记录一次命令摘要，控制键单独记录，不按每个按键记录

保留项：
- 现有只读 viewer 保留用于旁观
- 现有 MCP 工具接口不变（ssh-session-send 等）

### 第二轮：实现细节决策

**Q1: WebSocket 端点设计**

决定：路径式端点。

- `/ws/attach/session/:id` — 按 sessionId 或 sessionName attach
- `/ws/attach/binding/:key` — 按 viewer binding key attach
- 挂在现有 viewer server 上，通过 HTTP upgrade 事件处理
- 不新开端口

**Q2: viewer-cli 交互模式**

决定：默认只读，`--interactive` 进入交互模式。

- 保持向后兼容，现有行为不变
- `--interactive` 时捕获键盘输入，通过 WebSocket 转发到 MCP 服务
- 交互模式下 Ctrl+] 脱离

**Q3: 原始输出缓冲区**

决定：SSHSession 新增独立的 rawBuffer。

- 现有 buffer 继续服务 dashboard 和 MCP 工具读取
- 新增 rawBuffer 保留完整的原始 PTY 输出（含 ANSI、光标控制等）
- rawBuffer 专门供 WebSocket attach 前端和 xterm.js 消费
- rawBuffer 有独立的偏移量追踪（rawBufferStart / rawBufferEnd）

**Q4: WebSocket 依赖**

决定：引入 `ws` npm 包。

- 成熟稳定，处理 WebSocket 协议细节
- 新增 dependencies: `ws`
- 新增 devDependencies: `@types/ws`

**补充：终端持久化需求**

用户明确了关键使用场景：
- MCP 启动后，AI agent 通过 SSH 连接板卡，同时打开终端画面
- 用户在终端画面中观看 AI 与板卡的交互（像在 MobaXterm 中看别人操作）
- 用户也可以在同一终端中输入命令
- AI 和用户的输入通过标识区分（颜色、图标等）
- 终端持久化运行：不因一轮对话结束而关闭，下一轮对话继续复用同一个终端会话
- 这意味着 SSH 会话的生命周期独立于 AI agent 的对话轮次

### 第三轮：协议细节与改造边界

**Q1: WebSocket 消息格式**

决定：二进制输出 + JSON 事件。

服务端 → 客户端：
- 终端输出：二进制帧（Binary frame），原始 PTY 字节，xterm.js 直接写入
- 事件通知：JSON 文本帧（Text frame），包含 type/actor/text/at 等字段
- 会话状态变更（resize、close 等）：JSON 文本帧

客户端 → 服务端：
- 用户输入：JSON 文本帧 `{ "type": "input", "data": "...", "actor": "user" }`
- 控制键：JSON 文本帧 `{ "type": "control", "key": "ctrl_c", "actor": "user" }`
- resize：JSON 文本帧 `{ "type": "resize", "cols": N, "rows": N }`

**Q2: HTTP API 保留策略**

决定：HTTP attach API 和 WebSocket 并存。

- 现有 HTTP attach API（`/api/attach/...`）保留，旧浏览器页面继续使用
- 新增 WebSocket 端点（`/ws/attach/...`）供 xterm.js 页面和 viewer-cli --interactive 使用
- viewer-cli 默认只读模式继续用 HTTP 轮询
- viewer-cli --interactive 模式使用 WebSocket

**Q3: 终端自动打开**

决定：可配置。

- 新增命令行参数 `--autoOpenTerminal`（默认 false）
- 当 AI 调用 ssh-session-open 时，如果 `--autoOpenTerminal=true`，自动在浏览器中打开 xterm.js 终端页面
- 也可以通过 ssh-viewer-ensure 手动触发打开
- 自动打开时使用新的 xterm.js 终端页面路由

**Q4: 改造文件范围**

确认需要改动的文件：

1. `src/index.ts` — WebSocket 服务端逻辑（upgrade 处理、消息广播、输入转发）、新增 xterm.js 页面 HTML 生成函数、autoOpenTerminal 参数
2. `src/session.ts` — 新增 rawBuffer（独立的原始输出缓冲区）、WebSocket 客户端订阅通知机制
3. `src/viewer-cli.ts` — 新增 `--interactive` 模式、WebSocket 连接逻辑
4. 新增前端页面 — xterm.js 终端页面（通过 CDN 引入 xterm.js，服务端拼 HTML）

不改动的文件：
- `src/shared.ts` — 现有工具函数保持不变
- MCP 工具定义 — ssh-session-send 等接口不变
- package.json — 仅新增 ws 和 @types/ws 依赖

