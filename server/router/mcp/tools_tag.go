package mcp

import (
	"context"
	"fmt"
	"sort"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"

	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func (s *MCPService) registerTagTools(mcpSrv *mcpserver.MCPServer) {
	mcpSrv.AddTool(mcp.NewTool("list_tags",
		mcp.WithDescription("List all tags with their memo counts. Authenticated users see tags from their own and visible memos; unauthenticated callers see tags from public memos only. Results are sorted by count descending, then alphabetically."),
	), s.handleListTags)
}

type tagEntry struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

func (s *MCPService) handleListTags(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	userID := auth.GetUserID(ctx)

	rowStatus := store.Normal
	find := &store.FindMemo{
		ExcludeComments: true,
		ExcludeContent:  true,
		RowStatus:       &rowStatus,
	}
	applyVisibilityFilter(find, userID)

	memos, err := s.store.ListMemos(ctx, find)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("failed to list memos: %v", err)), nil
	}

	counts := make(map[string]int)
	for _, m := range memos {
		if m.Payload == nil {
			continue
		}
		for _, tag := range m.Payload.Tags {
			counts[tag]++
		}
	}

	entries := make([]tagEntry, 0, len(counts))
	for tag, count := range counts {
		entries = append(entries, tagEntry{Tag: tag, Count: count})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Count != entries[j].Count {
			return entries[i].Count > entries[j].Count
		}
		return entries[i].Tag < entries[j].Tag
	})

	out, err := marshalJSON(entries)
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(out), nil
}
