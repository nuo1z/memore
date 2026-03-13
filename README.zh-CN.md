# Memore

> Memos More — 更好的 Memos

Memore 是基于开源项目 [Memos](https://github.com/usememos/memos) 深度定制的**本地个人笔记应用**，专为 Windows 和 Android 平台设计。在保留 Memos 核心能力的基础上，Memore 大幅优化了编辑体验、界面沉浸感和本地数据管理，同时支持与远端 Memos 服务器双向同步。

当前版本：**v0.2.1**

---

## v0.2.1 更新日志

### 修复与优化

- **修复安卓端默认主题为 Dark 的问题**：当手机系统处于暗色模式时，应用会自动跟随变为 Dark 主题，覆盖了预设的 Paper 默认。现已移除"跟随系统"主题选项，主题固定为用户选择（Light / Dark / Paper），不再受系统暗色模式影响。

- **修复 Windows 端首次打开不显示窗口控件**：首次启动时 WebView2 初始化较慢，自定义标题栏中的最小化/最大化/关闭按钮可能无法显示。现改为持续轮询检测（最多 30 秒），并在后端未就绪时显示友好的加载页面而非 502 错误。

- **安卓端下载/保存附件**：安卓 WebView 不支持 `<a download>` 属性，之前完全无法在应用内保存图片和文档。新增功能：
  - 图片预览对话框顶部新增下载按钮
  - 附件列表中每个文件/图片都有独立的下载按钮
  - 安卓端通过 Capacitor Filesystem + Share 插件保存文件，触发系统分享对话框，可选择保存到文件管理器或发送给其他应用
  - 桌面端使用标准浏览器下载（拖拽图片到桌面同样保存原图）

### 项目清理

- 移除了 Docker 相关文件（Dockerfile、compose.yaml、entrypoint 等）——Memore 专注于桌面/移动端
- 修正图标源文件命名（`memoreicon.png` → `memore.png`）以匹配生成脚本
- 修复 Android 构建脚本的 JDK 21 检测逻辑（强制使用 Android Studio JBR）

---

## v0.2.0 更新日志

### 新功能

- **双向同步置顶和归档状态**：新增两个可选同步开关（"置顶同步"和"归档同步"），位于 设置 > 偏好设置 > Memore 同步 中，默认关闭。开启后，置顶和归档操作将在本地与远端之间双向同步，包括远端到本地的元数据变更检测（即使 `updateTime` 未变化也能正确同步）。

- **双向同步笔记可见性**：修复了已完成笔记修改可见性（私有/公开/工作区）后无法双向同步的问题。可见性变更现在始终参与同步，无需单独开关。

- **同步触发队列机制**：当一次同步正在执行时，新的同步请求不再被丢弃，而是加入等待队列，在当前同步完成后自动执行。

### 默认设置优化

- **默认主题**：新安装默认使用 Paper 主题，提供更柔和的阅读体验
- **默认周开始日**：新安装默认周一作为一周的开始
- **内容长度限制**：默认从 8KB 提升至 256KB，满足长文章和代码笔记需求

### 其他

- **项目图标更新**：全平台（Windows、Android、Web）更换新图标

## v0.1.9 更新日志

### Bug 修复

- **深度修复 Windows 托盘图标假死问题**：v0.1.8 的修复未彻底解决问题。根因是 `getlantern/systray` 的 `init()` 在导入时锁定了主 goroutine 的 OS 线程，但 `systray.Run()` 在另一个未锁定的 goroutine 中运行。Windows 消息泵必须在创建隐藏窗口的同一 OS 线程上运行，Go 调度器后续可能将该 goroutine 迁移到其他线程，导致托盘消息无法投递。修复：在 `main()` 中释放主线程锁，在 systray goroutine 中重新锁定 OS 线程（`runtime.LockOSThread()`）。

- **修复同步不同步置顶（pinned）状态**：pinning 操作不更新数据库的 `updated_ts` 时间戳，导致同步引擎的 `shouldSkip` 检查认为无变化而跳过。修复：后端 `UpdateMemo` 在任何字段变更时自动更新时间戳，不再依赖 update mask 中显式包含 `update_time`。

- **修复同步不同步归档（archived）状态**：之前同步只列出 NORMAL 状态的笔记，归档笔记完全不参与同步。修复包括：
  - Push 路径改为列出所有状态的本地笔记（含归档），后端 `ListMemos` 支持 `STATE_UNSPECIFIED` 返回全部
  - Pull 路径分两次拉取远端 NORMAL 和 ARCHIVED 笔记
  - Push/Pull 的 payload 和 update mask 中加入 `state` 字段
  - 创建远端/本地 memo 后自动同步归档状态（`CreateMemo` 默认 NORMAL，通过后续 PATCH 设为 ARCHIVED）

> 关于归档功能：归档是将笔记从主列表移到「已归档」区域的操作，归档后笔记不再显示在主页，但仍保留在数据库中，可随时恢复。适合存放不再活跃但不想删除的笔记。

## v0.1.8 更新日志

### Bug 修复

- **修复多附件同步覆盖问题**：当笔记包含多个附件进行同步时，之前只有最后一个附件能正确同步到另一端，其余附件丢失。根因是后端 `CreateAttachment` 在 UID 重复时返回 `Internal` 错误而非 `AlreadyExists`，导致前端无法识别已存在的附件。修复包括：
  - 后端：`CreateAttachment` 检测 UID 唯一约束冲突，返回 `AlreadyExists` 错误码
  - 前端 Push（本地→远端）：当远端创建附件失败时，先尝试 GET 确认附件是否已存在，避免误判为失败
  - 前端 Pull（远端→本地）：创建本地附件前先检查是否已存在，跳过不必要的下载和重复创建

- **修复 Windows 托盘图标假死问题**（初步修复，v0.1.9 中深度修复）

---

## 核心特性

### 本地优先

- 所有笔记和附件存储在本地文件系统，无需依赖云服务
- 默认使用 SQLite + Local 存储模式，附件以独立文件形式保存，数据库保持轻量
- Windows 数据目录：`C:\ProgramData\memore`
- Android 数据目录：`${filesDir}/memore/`（应用内部存储）

### 增强编辑器

- 集成 [Vditor](https://github.com/Vanessa219/vditor) Markdown 编辑器，支持所见即所得、即时渲染、分屏预览三种模式
- 双击笔记直接进入 Vditor 高级编辑模式（可在设置中开关）
- 点击编辑器外部阴影区域自动取消编辑，恢复展示状态
- 支持代码高亮、数学公式（KaTeX）、Mermaid 图表、地图嵌入等
- 自定义字体：在 设置 > 偏好设置 > 基础 中输入系统已安装字体名称即可全局替换
- 编辑器模式自动适配平台：Android 端默认所见即所得，Windows/Web 端默认即时渲染

### 云端同步

- 与远端部署的 Memos 实例双向同步笔记和附件
- **Push**：本地新建/修改/删除的笔记推送到云端
- **Pull**：云端新建/修改/删除的笔记拉取到本地
- **置顶/归档同步**：可选开关，开启后双向同步置顶和归档状态
- **可见性同步**：笔记可见性（私有/公开/工作区）变更始终双向同步
- 附件同步通过后端代理中转，绕过浏览器 CORS 限制
- 冲突策略：Last-Writer-Wins（LWW），以 `updateTime` 时间戳判断
- 内容指纹去重，防止意外重复创建
- 断点续传：同步进度增量保存，中断后可从断点继续
- Dry Run 预览：同步前预览变更数量，不执行实际写入
- 安全删除确认：当同步操作将删除超过 2 条笔记时弹窗确认
- 复制远端链接：笔记菜单中「复制链接」直接复制远端 Memos 对应 URL；未同步笔记复制为空

### 沉浸式桌面体验（Windows）

- 无边框窗口 + 自定义标题栏，与应用主题完美融合
- 系统托盘驻留，关闭窗口时自动隐藏到托盘而非退出
- 单实例保护：重复启动会自动唤醒已运行实例
- 全局隐藏滚动条，界面更简洁
- 单文件 EXE 发布，双击即可运行
- 编辑器浮层开关带平滑动画过渡

### Android 原生端

- 通过 Capacitor + gomobile AAR 运行本地 Go 后端，支持完全离线使用
- Android 前台服务启动本地 API（`127.0.0.1:8081`），WebView 直接访问
- 与桌面版共用同一套前端和同步引擎
- 自动适配系统状态栏高度和主题色填充
- 标题栏固定在顶部，不随页面滚动
- Vditor 工具栏针对移动端重排：3 行 × 6 按钮，去除分隔线
- 系统返回键支持关闭侧栏、对话框和高级编辑器浮层
- 支持保存图片和附件到本地（通过系统分享对话框保存或转发）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Go 1.25 + Echo HTTP + gRPC + Connect RPC |
| 前端 | React 18.3 + TypeScript + Vite 7 + Tailwind CSS v4 |
| 数据库 | SQLite（默认）/ MySQL / PostgreSQL |
| 协议 | Protocol Buffers v2 + buf 代码生成 |
| 编辑器 | Vditor（可选增强模式） |
| 桌面框架 | Wails v2 + WebView2 |
| Android 框架 | Capacitor + Android 前台服务 + gomobile AAR |
| 系统托盘 | getlantern/systray |
| 资源嵌入 | go-winres（图标 + 版本信息） |

---

## 项目结构

```
cmd/
  memos/                    # Web 服务入口（Cobra CLI）
  memore-desktop/           # Windows 桌面版入口（Wails v2）
    main.go                 # Wails 应用配置、后端启动、系统托盘
    proxy.go                # HTTP 反向代理（WebView → 内部后端）
    generate_icons.py       # 图标生成工具（PNG → 多尺寸 ICO + 各平台图标）
    icon.png / icon.ico     # 应用图标

mobile/
  server.go                 # gomobile 绑定入口（Android AAR）

server/                     # HTTP 服务器
  server.go                 # Echo 服务器初始化、后台运行器
  auth/                     # 认证（JWT v2、PAT、会话）
  router/
    api/v1/                 # gRPC + Connect RPC 服务实现
    frontend/               # 静态前端资源（go:embed 嵌入）
    fileserver/             # 文件服务 + 附件代理
    rss/                    # RSS 生成

store/                      # 数据层
  driver.go                 # 数据库驱动接口
  store.go                  # Store 封装 + 内存缓存
  db/sqlite/                # SQLite 实现
  db/mysql/                 # MySQL 实现
  db/postgres/              # PostgreSQL 实现
  migration/                # 数据库迁移文件（按版本号组织）

proto/                      # Protocol Buffer 定义 + 生成代码
plugin/                     # 插件（markdown、S3、scheduler、email、webhook 等）

web/                        # React 前端
  src/
    components/             # UI 组件
      MemoEditor/           # 编辑器（含 Vditor 聚焦模式）
      MemoView/             # 笔记展示（含双击编辑）
      MobileHeader.tsx      # 移动端标题栏（安卓端固定定位）
      DesktopTitleBar.tsx   # 桌面端自定义标题栏
    contexts/               # React Context（Auth、View、MemoFilter）
    hooks/                  # React Query hooks
      useMemoreSyncPreferences.ts  # 同步偏好（含置顶/归档开关）
      useMemoreTriggeredSync.ts    # 事件触发同步 + 重试队列
      useMemoreStartupSync.ts      # 启动时自动同步
    lib/
      memore-sync.ts        # 核心同步引擎
      memore-auto-auth.ts   # 自动登录凭据管理
    pages/                  # 页面组件
    locales/                # 国际化资源
  android/                  # Capacitor Android 工程
    app/src/main/java/      # Kotlin 原生代码（前台服务、返回键等）

scripts/
  build-desktop.ps1         # Windows 桌面版构建脚本
  build-android.ps1         # Android 构建脚本（含嵌入验证）
  build.sh                  # 跨平台 Web 服务构建脚本

packaging/
  windows/README.md         # Windows 桌面版打包说明
  android/README.md         # Android 打包说明
```

---

## 快速开始

### 使用构建好的桌面版

双击 `build/Memore.exe` 即可启动。首次启动时需要注册本地账户（用户名和密码）。

- 关闭窗口 → 隐藏到系统托盘（后台运行）
- 右键托盘图标 → 「打开 Memore」或「退出」
- 重复启动 EXE → 自动唤醒已运行的实例
- 数据存储在 `C:\ProgramData\memore\`
- 首次登录后自动保存凭据，后续启动免登录

### 使用 Android 版

安装 `Memore.apk` 后首次启动需要注册账户。注册完成后自动登录进入主界面。

### 开发模式

```bash
# 启动后端（端口 8081）
go run ./cmd/memos --port 8081

# 启动前端开发服务器（新终端，自动代理到后端）
cd web && pnpm install && pnpm dev
```

浏览器打开 `http://localhost:5173` 即可开始开发。

### 构建桌面版

```powershell
# 完整构建（前端 + 资源嵌入 + Go 编译）
.\scripts\build-desktop.ps1

# 跳过前端构建（仅在前端未修改时使用）
.\scripts\build-desktop.ps1 -SkipWebBuild
```

构建产物：`build/Memore.exe`（约 46 MB，单文件可执行）

### 构建 Android 版

```powershell
.\scripts\build-android.ps1
```

构建产物：`web/android/app/build/outputs/apk/debug/app-debug.apk`

构建脚本内置"强验证"机制：写入唯一标记到前端目录 → 构建 AAR → 验证 AAR 是否包含标记 → 不包含则清除缓存重试。

---

## 配置

### 环境变量（Web 服务模式）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMOS_PORT` | `8081` | HTTP 端口 |
| `MEMOS_ADDR` | `""` | 绑定地址（空 = 所有接口） |
| `MEMOS_DATA` | 平台相关 | 数据目录 |
| `MEMOS_DRIVER` | `sqlite` | 数据库驱动（sqlite / mysql / postgres） |
| `MEMOS_DSN` | `""` | 数据库连接字符串 |

### 桌面版

桌面版无需手动配置环境变量：

- **端口**：自动分配可用端口
- **绑定地址**：固定为 `127.0.0.1`（仅本机访问）
- **数据目录**：`C:\ProgramData\memore`
- **存储模式**：Local（附件存为独立文件）

### Android 版

- **端口**：固定 8081
- **数据目录**：`${filesDir}/memore/`（应用内部存储）
- **存储模式**：Database（附件存入 SQLite 数据库）

### 默认设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 主题 | Paper | 柔和纸质风格 |
| 周开始日 | 周一 | 日历和统计以周一为一周起始 |
| 内容长度限制 | 256 KB | 单条笔记最大字节数 |
| 默认可见性 | PRIVATE | 新建笔记默认为私有 |

---

## Memore 同步

在 **设置 > 偏好设置 > Memore 同步** 中配置：

1. 开启「启用远端同步」
2. 填写远端 Memos 服务器地址（如 `https://memos.example.com`）
3. 填写访问令牌（在远端 Memos 的 设置 > 访问令牌 中生成）
4. 点击「测试连接」验证
5. 开启「启动时自动同步」（可选）
6. 按需开启「置顶同步」和「归档同步」（可选）

### 同步操作

- **手动同步**：点击编辑框旁的同步按钮
- **自动同步**：启动时自动执行（需开启选项）
- **Dry Run 预览**：在设置中点击「Dry Run 预览」查看变更统计

### 同步范围

| 数据 | 同步行为 | 开关 |
|------|---------|------|
| 笔记内容 | 始终同步 | — |
| 附件 | 始终同步 | — |
| 可见性（私有/公开/工作区） | 始终同步 | — |
| 置顶状态 | 可选 | 「置顶同步」开关 |
| 归档状态 | 可选 | 「归档同步」开关 |

### 冲突处理

当本地和云端都修改了同一条笔记时：

- 比较双方的 `updateTime` 时间戳
- 更晚修改的一方获胜（Last-Writer-Wins）
- 冲突记录可在同步状态面板中查看

### 安全保护

- 当一次同步将删除超过 2 条笔记时，弹窗要求手动确认
- 同步锁机制防止多个标签页/实例同时执行同步

---

## 数据存储说明

### Windows 桌面版

| 内容 | 路径 |
|------|------|
| 数据库 + 附件 | `C:\ProgramData\memore\` |
| 浏览器缓存（localStorage、同步元数据） | `%APPDATA%\Memore.exe\EBWebView\` |

> 删除 `ProgramData\memore\` 会清除笔记和附件，但登录凭据和同步配置保存在 WebView 缓存中，仍会保留。

### Android

| 内容 | 路径 |
|------|------|
| 数据库 + 附件 | `${filesDir}/memore/` |
| WebView 缓存 | 应用内部存储 |

> 卸载 App 会同时清除所有数据。

---

## 与 Memos 的主要差异

| 方面 | Memos | Memore |
|------|-------|--------|
| 定位 | Web 部署的笔记服务 | 本地桌面/移动端笔记应用 |
| 编辑器 | 原生 textarea | Vditor 增强编辑器 |
| 窗口 | 浏览器标签页 | 无边框独立窗口 + 系统托盘 |
| 默认主题 | Default（可跟随系统） | Paper（不跟随系统） |
| 默认可见性 | PUBLIC | PRIVATE |
| 用户注册 | 多用户 | 单用户本地账户 |
| 数据存储 | 服务器端 | 本地文件系统 |
| 同步 | 无 | 双向同步远端 Memos |
| 字体 | 固定 | 可自定义全局字体 |
| 复制链接 | 复制本地 URL | 复制远端 Memos URL（方便分享） |
| 滚动条 | 默认显示 | 全局隐藏 |
| Android | 无原生端 | Capacitor + gomobile 原生端 |
| 登录 | 每次手动 | 首次注册后自动登录 |

---

## 图标替换

1. 准备一张至少 512×512 的 PNG 源图（透明背景），放置于项目根目录
2. 运行图标生成脚本：
   ```bash
   python cmd/memore-desktop/generate_icons.py
   ```
3. 脚本自动生成并替换所有平台图标：Windows ICO/PNG、Web favicon、Android mipmap
4. 重新执行构建脚本

---

## 致谢

本项目基于 [Memos](https://github.com/usememos/memos)（MIT 许可证）开发。感谢 Memos 团队的出色工作。

编辑器增强功能由 [Vditor](https://github.com/Vanessa219/vditor) 提供支持。
