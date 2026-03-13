//go:build android

package db

import (
	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/profile"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db/sqlite"
)

// NewDBDriver creates new db driver for Android builds.
// Android package currently supports SQLite only to keep binary size small.
func NewDBDriver(profile *profile.Profile) (store.Driver, error) {
	if profile.Driver != "sqlite" {
		return nil, errors.New("android build only supports sqlite driver")
	}

	driver, err := sqlite.NewDB(profile)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create sqlite db driver")
	}

	return driver, nil
}
