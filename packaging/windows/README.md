# Memore Windows 桌面版

## 概述

Memore Windows 桌面版使用 [Wails v2](https://wails.io/) 框架构建，将 Go 后端和 React 前端封装为单文件原生 Windows 应用。通过 WebView2 渲染前端界面，提供与原生应用一致的沉浸式体验。

## 架构

```
┌─────────────────────────────────────────────────┐
│  Memore.exe（单文件可执行）                       │
│  ┌───────────────────────────────────────────┐   │
│  │  Wails v2 Runtime                         │   │
│  │  ┌─────────────┐  ┌──────────────────┐    │   │
│  │  │ Go 后端      │  │  WebView2 窗口    │   │   │
│  │  │ (Echo HTTP)  │◄─│  (React 前端)     │   │   │
│  │  │ 127.0.0.1:N  │  │  ProxyHandler    │   │   │
│  │  └─────────────┘  └──────────────────┘    │   │
│  └───────────────────────────────────────────┘   │
│  ┌───────────────┐                               │
│  │  系统托盘       │  getlantern/systray           │
│  │  - 打开 Memore  │                               │
│  │  - 退出         │                               │
│  └───────────────┘                               │
└─────────────────────────────────────────────────┘
```

## 使用方法

### 启动

双击 `Memore.exe` 即可启动。首次启动时需要注册本地账户（输入用户名和密码）。注册完成后自动登录进入主界面，后续启动免登录。

### 单实例保护

程序启用了单实例限制。如果后台已有运行中的 Memore，再次双击 EXE 不会创建新进程，而是自动唤醒已有窗口。

### 窗口管理

- **最小化 / 最大化 / 关闭**：使用窗口右上角的自定义控制按钮
- **关闭窗口**：隐藏到系统托盘（应用继续在后台运行）
- **拖拽移动**：按住标题栏区域拖拽窗口
- **完全退出**：右键托盘图标 → 「退出」

### 系统托盘

- **左键单击**或选择「打开 Memore」→ 显示主窗口
- **退出** → 完全关闭 Memore（停止后端服务）

## 数据存储

| 内容 | 路径 |
|------|------|
| 数据库 | `C:\ProgramData\memore\memos_prod.db` |
| 附件文件 | `C:\ProgramData\memore\assets\` |
| 缩略图缓存 | `C:\ProgramData\memore\thumbnails\` |
| WebView 缓存 | `%APPDATA%\Memore.exe\EBWebView\` |

- 默认使用 **Local** 存储模式，附件以独立文件形式保存在 `assets/` 目录下
- 登录凭据和同步配置保存在 WebView 的 localStorage 中
- 删除 `ProgramData\memore\` 会清除笔记和附件，但 WebView 缓存中的登录信息仍会保留

## 构建

### 前置条件

- Go 1.25+
- Node.js 18+ 和 pnpm
- [go-winres](https://github.com/tc-hib/go-winres)（嵌入图标和版本信息）

### 构建命令

```powershell
# 完整构建
.\scripts\build-desktop.ps1

# 跳过前端构建（仅在前端未修改时使用）
.\scripts\build-desktop.ps1 -SkipWebBuild
```

### 构建流程

1. `pnpm release` — 编译前端到 `server/router/frontend/dist/`
2. `go-winres make` — 生成 Windows 资源文件（图标 + 版本信息）
3. `go build -tags "desktop,production"` — 编译 Go 二进制，通过 `go:embed` 嵌入前端资源

### 手动构建

```powershell
cd web; pnpm release
cd ..\cmd\memore-desktop; go-winres make
cd ..\..
go build -tags "desktop,production" -ldflags "-H windowsgui -s -w" -o build/Memore.exe ./cmd/memore-desktop/
```

## 关键文件

| 文件 | 说明 |
|------|------|
| `cmd/memore-desktop/main.go` | 应用入口：Wails 配置、后端启动、系统托盘 |
| `cmd/memore-desktop/proxy.go` | HTTP 代理：WebView 请求 → 内部后端 |
| `cmd/memore-desktop/icon.png` | 应用图标（PNG，嵌入到二进制） |
| `cmd/memore-desktop/icon.ico` | 应用图标（ICO，用于 Windows 资源） |
| `cmd/memore-desktop/generate_icons.py` | 图标生成工具（从源 PNG 生成全平台图标） |
| `cmd/memore-desktop/winres/` | go-winres 资源配置 |
| `scripts/build-desktop.ps1` | 自动化构建脚本 |
| `wails.json` | Wails 项目配置 |

## 图标替换

1. 准备一张至少 512×512 的 PNG 源图（透明背景），放置于项目根目录
2. 运行 `python cmd/memore-desktop/generate_icons.py` 生成全平台图标（Windows ICO/PNG、Web favicon、Android mipmap）
3. 重新执行构建脚本

## 注意事项

- 编译时必须包含 `-tags "desktop,production"` 标志，否则 Wails 会报错
- `-ldflags "-H windowsgui"` 用于隐藏控制台窗口
- 端口为启动时自动分配的可用端口，无需手动配置
- 数据目录在首次启动时自动创建
- 如果系统仍显示旧图标，通常是 Windows 图标缓存未刷新，可重启资源管理器或清理图标缓存后再观察
