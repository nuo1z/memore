# Memore Android 打包说明

## 概述

Memore Android 版采用 **Capacitor + Go AAR（gomobile）** 架构：

- Go 后端（Echo HTTP + SQLite）编译为 `mobile.aar`
- Android 原生前台服务启动本地 Go 服务（`127.0.0.1:8081`）
- Capacitor WebView 加载本地服务页面，实现离线笔记与云端同步

## 架构

```
┌───────────────────────────────────────┐
│  Memore Android App                   │
│  ┌─────────────────────────────────┐  │
│  │  Capacitor WebView              │  │
│  │  ┌──────────────────────────┐   │  │
│  │  │  React 前端               │   │  │
│  │  │  (与桌面版共用源码)         │   │  │
│  │  └──────────────────────────┘   │  │
│  └────────────┬────────────────────┘  │
│               │ HTTP (127.0.0.1:8081) │
│  ┌────────────▼────────────────────┐  │
│  │  Go Backend (mobile.aar)        │  │
│  │  Echo HTTP + SQLite             │  │
│  │  前台服务 + WakeLock            │  │
│  └─────────────────────────────────┘  │
└───────────────────────────────────────┘
```

## 目录与产物

| 路径 | 说明 |
|------|------|
| `mobile/server.go` | Go 移动端入口（gomobile 绑定） |
| `packaging/android/mobile.aar` | gomobile 编译的 AAR 产物 |
| `web/android/` | Capacitor Android 工程 |
| `web/android/app/build/outputs/apk/debug/app-debug.apk` | Debug APK |

## 构建前置条件

| 工具 | 版本要求 |
|------|---------|
| Go | 1.25+ |
| Node.js | 18+ |
| pnpm | 最新版 |
| Android Studio | 最新稳定版（含 SDK、NDK） |
| JDK | 21（推荐使用 Android Studio 自带 JBR） |
| gomobile | `go install golang.org/x/mobile/cmd/gomobile@latest` |
| gobind | `go install golang.org/x/mobile/cmd/gobind@latest` |

安装 gomobile 后需执行 `gomobile init` 初始化。

## 一键构建

在仓库根目录执行：

```powershell
.\scripts\build-android.ps1
```

脚本自动执行以下步骤：

1. `pnpm --dir web release` — 编译前端到 `server/router/frontend/dist`（供 Go `//go:embed` 嵌入）
2. 写入唯一构建标记到前端目录
3. `gomobile bind ... -o packaging/android/mobile.aar ./mobile` — 编译 Go AAR
4. 验证 AAR 是否包含构建标记（不包含则清除 Go 缓存重试）
5. 复制 AAR 到 `web/android/app/libs/`
6. `npx cap sync android` — 同步 Capacitor 资源
7. `gradlew.bat :app:clean :app:assembleDebug` — 构建 APK

### 可选参数

- `-SkipWebBuild`：跳过前端构建
- `-SkipAarBuild`：跳过 AAR 构建
- `-SkipGradleBuild`：跳过 Gradle 构建

## 原生代码

### 前台服务

`web/android/app/src/main/java/com/memore/app/MemoreServerService.kt`

- 作为 Android 前台服务常驻运行
- 调用 `mobile.Mobile.startServer(dataDir, port)` 启动 Go 后端
- 使用 `WakeLock` 降低后台休眠导致的中断风险

### 主 Activity

`web/android/app/src/main/java/com/memore/app/MainActivity.kt`

- 启动前台服务后加载 WebView
- 健康检查就绪后自动 reload 页面
- 注册 `OnBackPressedCallback`，通过 JS Bridge 调用前端返回键处理

## 网络与安全配置

- `web/capacitor.config.ts`：`server.url = "http://127.0.0.1:8081"`，`cleartext = true`
- `AndroidManifest.xml`：`usesCleartextTraffic = true`，声明 `FOREGROUND_SERVICE`、`WAKE_LOCK` 权限
- `res/xml/network_security_config.xml`：放行 `localhost` / `127.0.0.1` 明文本地通信

## 数据路径

Android 本地数据存储在应用内部存储：

- `${filesDir}/memore/`
  - SQLite 数据库：`memore_prod.db`
  - 附件与缩略图目录

卸载应用将清除全部数据。

## Android 端 UI 适配

- **状态栏**：自动检测高度，使用主题色纯色填充（通过 Capacitor StatusBar 插件 + CSS 变量 + 真实 DOM 元素实现）
- **标题栏**：固定在状态栏下方，不随页面滚动
- **Vditor 工具栏**：移除分隔线和编辑模式按钮，18 个按钮按 3 行 × 6 列居中排布
- **编辑模式**：Android 端固定为所见即所得（WYSIWYG）
- **返回键**：支持关闭左右侧栏、对话框、高级编辑器浮层

## 图标替换

Android 图标位于：

```
web/android/app/src/main/res/
  mipmap-hdpi/ic_launcher.png       # 72×72
  mipmap-mdpi/ic_launcher.png       # 48×48
  mipmap-xhdpi/ic_launcher.png      # 96×96
  mipmap-xxhdpi/ic_launcher.png     # 144×144
  mipmap-xxxhdpi/ic_launcher.png    # 192×192
```

建议源图至少 1024×1024 PNG（透明背景），再批量缩放替换各尺寸。
