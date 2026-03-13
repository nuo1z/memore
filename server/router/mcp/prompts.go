package mcp

import (
	"context"
	"errors"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func (s *MCPService) registerPrompts(mcpSrv *mcpserver.MCPServer) {
	// capture — turns free-form user input into a structured create_memo call.
	mcpSrv.AddPrompt(
		mcp.NewPrompt("capture",
			mcp.WithPromptDescription("Capture a thought, idea, or note as a new memo. "+
				"Use this prompt when the user wants to quickly save something. "+
				"The assistant will call create_memo with the provided content."),
			mcp.WithArgument("content",
				mcp.ArgumentDescription("The text to save as a memo"),
				mcp.RequiredArgument(),
			),
			mcp.WithArgument("tags",
				mcp.ArgumentDescription("Comma-separated tags to apply, e.g. \"work,project\""),
			),
		),
		s.handleCapturePrompt,
	)

	// review — surfaces existing memos on a topic for summarisation.
	mcpSrv.AddPrompt(
		mcp.NewPrompt("review",
			mcp.WithPromptDescription("Search and review memos on a given topic. "+
				"The assistant will call search_memos and summarise the results."),
			mcp.WithArgument("topic",
				mcp.ArgumentDescription("Topic or keyword to search for"),
				mcp.RequiredArgument(),
			),
		),
		s.handleReviewPrompt,
	)
}

func (*MCPService) handleCapturePrompt(_ context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	content := req.Params.Arguments["content"]
	if content == "" {
		return nil, errors.New("content argument is required")
	}

	tags := req.Params.Arguments["tags"]
	instruction := fmt.Sprintf(
		"Please save the following as a new private memo using the create_memo tool.\n\nContent:\n%s",
		content,
	)
	if tags != "" {
		instruction += fmt.Sprintf("\n\nAppend these tags inline using #tag syntax: %s", tags)
	}

	return &mcp.GetPromptResult{
		Description: "Capture a memo",
		Messages: []mcp.PromptMessage{
			mcp.NewPromptMessage(mcp.RoleUser, mcp.NewTextContent(instruction)),
		},
	}, nil
}

func (*MCPService) handleReviewPrompt(_ context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	topic := req.Params.Arguments["topic"]
	if topic == "" {
		return nil, errors.New("topic argument is required")
	}

	instruction := fmt.Sprintf(
		"Please use the search_memos tool to find memos about %q, then provide a concise summary of what has been written on this topic, grouped by theme. Include the memo names so the user can reference them.",
		topic,
	)

	return &mcp.GetPromptResult{
		Description: fmt.Sprintf("Review memos about %q", topic),
		Messages: []mcp.PromptMessage{
			mcp.NewPromptMessage(mcp.RoleUser, mcp.NewTextContent(instruction)),
		},
	}, nil
}
