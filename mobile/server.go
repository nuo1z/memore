package mobile

import (
	"context"
	"fmt"
	"sync"

	"github.com/usememos/memos/internal/profile"
	"github.com/usememos/memos/internal/version"
	"github.com/usememos/memos/server"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db"
)

var (
	serverMu      sync.Mutex
	serverContext context.Context
	serverCancel  context.CancelFunc
	serverInst    *server.Server
)

// StartServer boots an embedded Memore server for mobile clients.
// dataDir should be an app-private writable path from Android context.
func StartServer(dataDir string, port int) error {
	serverMu.Lock()
	defer serverMu.Unlock()

	if serverInst != nil {
		return nil
	}
	if dataDir == "" {
		return fmt.Errorf("dataDir is required")
	}
	if port <= 0 {
		return fmt.Errorf("port must be greater than 0")
	}

	instanceProfile := &profile.Profile{
		Addr:   "127.0.0.1",
		Port:   port,
		Data:   dataDir,
		Driver: "sqlite",
	}
	instanceProfile.Version = version.GetCurrentVersion()

	if err := instanceProfile.Validate(); err != nil {
		return fmt.Errorf("validate profile: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	dbDriver, err := db.NewDBDriver(instanceProfile)
	if err != nil {
		cancel()
		return fmt.Errorf("create db driver: %w", err)
	}

	storeInst := store.New(dbDriver, instanceProfile)
	if err := storeInst.Migrate(ctx); err != nil {
		cancel()
		return fmt.Errorf("migrate: %w", err)
	}

	srv, err := server.NewServer(ctx, instanceProfile, storeInst)
	if err != nil {
		cancel()
		return fmt.Errorf("create server: %w", err)
	}
	if err := srv.Start(ctx); err != nil {
		cancel()
		return fmt.Errorf("start server: %w", err)
	}

	serverContext = ctx
	serverCancel = cancel
	serverInst = srv
	return nil
}

// StopServer gracefully stops the embedded server.
func StopServer() {
	serverMu.Lock()
	defer serverMu.Unlock()

	if serverInst == nil {
		return
	}

	serverInst.Shutdown(serverContext)
	serverCancel()
	serverInst = nil
	serverCancel = nil
	serverContext = nil
}

// IsRunning reports whether the embedded server is currently running.
func IsRunning() bool {
	serverMu.Lock()
	defer serverMu.Unlock()
	return serverInst != nil
}
