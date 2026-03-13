// Memore Desktop - Windows 桌面版入口
// 使用 Wails v2 将 Memore Web 应用封装为原生 Windows 桌面应用。
// 架构：后台启动 Go HTTP 服务 → WebView2 窗口加载本地页面 → 系统托盘管理。
package main

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/getlantern/systray"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/usememos/memos/internal/profile"
	"github.com/usememos/memos/internal/version"
	"github.com/usememos/memos/server"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db"
)

//go:embed icon.png
var appIconPNG []byte

//go:embed icon.ico
var appIconICO []byte

const singletonLockID = "com.memore.desktop.singleton.v1"
const windowClassName = "MemoreWailsWindow"
const appUserModelID = "com.memore.desktop"

// Win32 常量
const (
	wmSetIcon      = 0x0080
	iconBig        = 1
	iconSmall      = 0
	imageIcon      = 1
	lrDefaultSize  = 0x0040
	swShow         = 5
	swRestore      = 9
	smCxIcon       = 11
	smCyIcon       = 12
	lrShared       = 0x00008000
	iconResourceID = 3 // Wails 固定从资源 ID 3 读取图标
)

var (
	user32              = syscall.NewLazyDLL("user32.dll")
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	shell32             = syscall.NewLazyDLL("shell32.dll")
	pFindWindow         = user32.NewProc("FindWindowW")
	pShowWindow         = user32.NewProc("ShowWindow")
	pIsIconic           = user32.NewProc("IsIconic")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pSendMessage        = user32.NewProc("SendMessageW")
	pLoadImage          = user32.NewProc("LoadImageW")
	pGetModuleHandle    = kernel32.NewProc("GetModuleHandleW")
	pSetAppID           = shell32.NewProc("SetCurrentProcessExplicitAppUserModelID")
)

func main() {
	// getlantern/systray 的 init() 在导入时对 main goroutine 调用了
	// runtime.LockOSThread()。这里释放它，把主线程留给 Wails/WebView2。
	// systray 的消息循环会在专用 goroutine 中重新锁定。
	runtime.UnlockOSThread()

	setProcessAppUserModelID()

	port, err := findAvailablePort()
	if err != nil {
		slog.Error("failed to find available port", "error", err)
		os.Exit(1)
	}

	app := NewApp(port)

	if err := wails.Run(&options.App{
		Title:             "Memore",
		Width:             1280,
		Height:            860,
		MinWidth:          800,
		MinHeight:         600,
		HideWindowOnClose: true,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: singletonLockID,
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				app.requestShowWindow()
			},
		},
		AssetServer: &assetserver.Options{
			Handler: NewProxyHandler(fmt.Sprintf("http://127.0.0.1:%d", port)),
		},
		OnStartup:        app.startup,
		OnDomReady:       app.onDomReady,
		OnShutdown:       app.onShutdown,
		Frameless:        true,
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255},
		WindowStartState: options.Normal,
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
			WindowClassName:      windowClassName,
		},
	}); err != nil {
		slog.Error("wails app error", "error", err)
		os.Exit(1)
	}
}

type App struct {
	ctx      context.Context
	cancel   context.CancelFunc
	port     int
	srv      *server.Server
	showCh   chan struct{}
	trayDone chan struct{}
}

func NewApp(port int) *App {
	return &App{
		port:     port,
		showCh:   make(chan struct{}, 1),
		trayDone: make(chan struct{}),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	bgCtx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel

	go func() {
		if err := a.startServer(bgCtx); err != nil {
			slog.Error("failed to start memore server", "error", err)
		}
	}()

	go a.consumeShowWindowRequests(bgCtx)

	// systray 的 Windows 消息循环必须在固定的 OS 线程上运行：
	// 隐藏窗口的 wndProc 只接收来自创建它的同一线程的消息。
	// 如果不锁定，Go 调度器可能将 goroutine 迁移到其他线程，
	// 导致托盘图标点击事件无法投递——表现为"假死"。
	go func() {
		runtime.LockOSThread()
		systray.Run(a.onTrayReady, a.onTrayExit)
	}()
}

// onDomReady 在 WebView 首次加载完成后触发。
// 此时 Wails 窗口已完全创建，可以安全地通过 WinAPI 补设 ICON_BIG。
func (a *App) onDomReady(_ context.Context) {
	go func() {
		time.Sleep(500 * time.Millisecond)
		setMainWindowBigIcon()
	}()
}

func (a *App) onTrayReady() {
	systray.SetIcon(appIconICO)
	systray.SetTitle("Memore")
	systray.SetTooltip("Memore - 个人笔记")

	mShow := systray.AddMenuItem("打开 Memore", "显示主窗口")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("退出", "关闭 Memore")

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Warn("tray menu goroutine recovered from panic", "error", r)
			}
		}()
		for {
			select {
			case <-a.trayDone:
				return
			case _, ok := <-mShow.ClickedCh:
				if !ok {
					return
				}
				a.requestShowWindow()
			case _, ok := <-mQuit.ClickedCh:
				if !ok {
					return
				}
				systray.Quit()
				wailsruntime.Quit(a.ctx)
				return
			}
		}
	}()

	go a.keepTrayAlive()
}

// keepTrayAlive periodically refreshes the tray tooltip to prevent the
// Windows shell from marking the notification icon as unresponsive.
func (a *App) keepTrayAlive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-a.trayDone:
			return
		case <-ticker.C:
			func() {
				defer func() { recover() }()
				systray.SetTooltip("Memore - 个人笔记")
			}()
		}
	}
}

func (a *App) requestShowWindow() {
	select {
	case a.showCh <- struct{}{}:
	default:
	}
}

func (a *App) consumeShowWindowRequests(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.showCh:
			showMainWindow()
		}
	}
}

func (a *App) onTrayExit() {
	select {
	case <-a.trayDone:
	default:
		close(a.trayDone)
	}
}

func (a *App) startServer(ctx context.Context) error {
	dataDir := defaultDataDir()

	instanceProfile := &profile.Profile{
		Addr:   "127.0.0.1",
		Port:   a.port,
		Data:   dataDir,
		Driver: "sqlite",
	}
	instanceProfile.Version = version.GetCurrentVersion()

	if err := instanceProfile.Validate(); err != nil {
		return fmt.Errorf("validate profile: %w", err)
	}

	dbDriver, err := db.NewDBDriver(instanceProfile)
	if err != nil {
		return fmt.Errorf("create db driver: %w", err)
	}

	storeInst := store.New(dbDriver, instanceProfile)
	if err := storeInst.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	srv, err := server.NewServer(ctx, instanceProfile, storeInst)
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}
	a.srv = srv

	slog.Info("memore desktop server starting", "port", a.port, "data", dataDir)
	return srv.Start(ctx)
}

func (a *App) shutdown() {
	// Signal all goroutines (tray menu, keepalive, showWindow consumer) to stop.
	select {
	case <-a.trayDone:
	default:
		close(a.trayDone)
	}
	if a.cancel != nil {
		a.cancel()
	}

	// Give goroutines a moment to exit before tearing down systray & server.
	time.Sleep(100 * time.Millisecond)

	func() {
		defer func() { recover() }()
		systray.Quit()
	}()

	if a.srv != nil {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		a.srv.Shutdown(shutdownCtx)
	}
}

func (a *App) onShutdown(_ context.Context) {
	a.shutdown()
}

// ========== Win32 辅助函数 ==========

func findMainWindow() uintptr {
	clsPtr, _ := syscall.UTF16PtrFromString(windowClassName)
	hwnd, _, _ := pFindWindow.Call(uintptr(unsafe.Pointer(clsPtr)), 0)
	if hwnd == 0 {
		titlePtr, _ := syscall.UTF16PtrFromString("Memore")
		hwnd, _, _ = pFindWindow.Call(0, uintptr(unsafe.Pointer(titlePtr)))
	}
	return hwnd
}

// showMainWindow 纯 WinAPI 实现的窗口前置，不调用 Wails runtime，避免跨线程卡死。
func showMainWindow() {
	hwnd := findMainWindow()
	if hwnd == 0 {
		return
	}
	iconic, _, _ := pIsIconic.Call(hwnd)
	if iconic != 0 {
		pShowWindow.Call(hwnd, swRestore)
	} else {
		pShowWindow.Call(hwnd, swShow)
	}
	pSetForegroundWindow.Call(hwnd)
}

// setMainWindowBigIcon 从 EXE 嵌入资源加载图标并设置为 ICON_BIG。
// Wails 只设置了 ICON_SMALL(0)，导致任务栏预览回退到窗口类默认图标。
func setMainWindowBigIcon() {
	hwnd := findMainWindow()
	if hwnd == 0 {
		return
	}

	hModule, _, _ := pGetModuleHandle.Call(0)
	if hModule == 0 {
		return
	}

	// 加载大图标（通常 32x32）
	hIconBig, _, _ := pLoadImage.Call(
		hModule,
		uintptr(iconResourceID),
		imageIcon,
		0, 0,
		lrDefaultSize|lrShared,
	)
	if hIconBig != 0 {
		pSendMessage.Call(hwnd, wmSetIcon, iconBig, hIconBig)
	}

	// 也重新设置小图标以确保一致
	hIconSmall, _, _ := pLoadImage.Call(
		hModule,
		uintptr(iconResourceID),
		imageIcon,
		16, 16,
		lrShared,
	)
	if hIconSmall != 0 {
		pSendMessage.Call(hwnd, wmSetIcon, iconSmall, hIconSmall)
	}
}

func setProcessAppUserModelID() {
	ptr, err := syscall.UTF16PtrFromString(appUserModelID)
	if err != nil {
		return
	}
	pSetAppID.Call(uintptr(unsafe.Pointer(ptr)))
}

func defaultDataDir() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("ProgramData"), "memore")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".memore")
}

func findAvailablePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port, nil
}
