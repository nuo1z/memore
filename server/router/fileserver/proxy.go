// 远端附件代理下载服务。
// Memore 同步功能需要从远端 Memos 服务器下载附件二进制内容，
// 但远端 /file/attachments/* 路由没有 CORS 头，浏览器会拦截跨域请求。
// 本代理通过 Go 后端中转请求，完全绕过浏览器 CORS 限制。
package fileserver

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/labstack/echo/v5"
)

// proxyRemoteAttachmentRequest 代理请求参数。
type proxyRemoteAttachmentRequest struct {
	ServerURL     string `json:"serverUrl"`
	AttachmentUID string `json:"attachmentUid"`
	Filename      string `json:"filename"`
	AccessToken   string `json:"accessToken"`
	// 可选：S3 等外部存储的直链，优先使用
	ExternalLink string `json:"externalLink,omitempty"`
}

var proxyHTTPClient = &http.Client{
	Timeout: 120 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return nil
	},
}

// RegisterProxyRoutes 注册需要 CORS 支持的代理路由。
// corsMiddleware 由调用方传入，确保浏览器跨域请求可通过。
func (s *FileServerService) RegisterProxyRoutes(echoServer *echo.Echo, corsMiddleware echo.MiddlewareFunc) {
	proxyGroup := echoServer.Group("", corsMiddleware)
	proxyGroup.POST("/api/v1/memore/proxy-attachment", s.proxyRemoteAttachment)
}

// proxyRemoteAttachment 代理下载远端 Memos 附件。
// 前端发 POST 请求到本地后端，后端代为请求远端服务器，将附件内容流式返回。
func (s *FileServerService) proxyRemoteAttachment(c *echo.Context) error {
	ctx := c.Request().Context()

	// 鉴权：只有已登录的本地用户可使用代理
	authHeader := c.Request().Header.Get(echo.HeaderAuthorization)
	cookieHeader := c.Request().Header.Get("Cookie")
	user, err := s.authenticator.AuthenticateToUser(ctx, authHeader, cookieHeader)
	if err != nil || user == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}

	var req proxyRemoteAttachmentRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	req.ServerURL = strings.TrimRight(strings.TrimSpace(req.ServerURL), "/")
	req.AttachmentUID = strings.TrimSpace(req.AttachmentUID)
	req.Filename = strings.TrimSpace(req.Filename)
	req.AccessToken = strings.TrimSpace(req.AccessToken)

	if req.ServerURL == "" || req.AttachmentUID == "" || req.Filename == "" || req.AccessToken == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "missing required fields: serverUrl, attachmentUid, filename, accessToken")
	}

	// 安全校验：serverUrl 必须是 http(s) 协议
	parsedURL, err := url.Parse(req.ServerURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid server URL")
	}

	// 优先尝试 externalLink（S3 预签名等可直接访问的 URL）
	if req.ExternalLink != "" {
		if resp, err := s.tryFetchURL(ctx, req.ExternalLink, ""); err == nil {
			defer resp.Body.Close()
			return s.streamProxyResponse(c, resp)
		}
	}

	// 构建远端文件服务 URL
	remoteURL := fmt.Sprintf("%s/file/attachments/%s/%s",
		req.ServerURL,
		url.PathEscape(req.AttachmentUID),
		url.PathEscape(req.Filename),
	)

	resp, err := s.tryFetchURL(ctx, remoteURL, req.AccessToken)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, fmt.Sprintf("failed to fetch remote attachment: %v", err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return echo.NewHTTPError(resp.StatusCode, fmt.Sprintf("remote server returned %d: %s", resp.StatusCode, string(body)))
	}

	return s.streamProxyResponse(c, resp)
}

// tryFetchURL 向指定 URL 发起 GET 请求，可选携带 Bearer token。
func (*FileServerService) tryFetchURL(ctx context.Context, targetURL string, bearerToken string) (*http.Response, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	if bearerToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	resp, err := proxyHTTPClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return resp, nil
}

// streamProxyResponse 将远端响应流式转发给客户端。
func (*FileServerService) streamProxyResponse(c *echo.Context, resp *http.Response) error {
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	h := c.Response().Header()
	h.Set(echo.HeaderContentType, contentType)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		h.Set(echo.HeaderContentLength, cl)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		h.Set(echo.HeaderContentDisposition, cd)
	}

	c.Response().WriteHeader(http.StatusOK)
	_, err := io.Copy(c.Response(), resp.Body)
	return err
}
