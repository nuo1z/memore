// HTTP 反向代理：将 Wails WebView 的请求转发到本地 Memore HTTP 服务。
// Wails AssetServer 在请求静态资源和 API 时，都会经过此 handler，
// 由它代理到后台运行的 Go HTTP 服务器（127.0.0.1:{port}）。
package main

import (
	"io"
	"net/http"
	"strings"
	"time"
)

type ProxyHandler struct {
	backendURL string
	client     *http.Client
}

func NewProxyHandler(backendURL string) *ProxyHandler {
	return &ProxyHandler{
		backendURL: strings.TrimRight(backendURL, "/"),
		client: &http.Client{
			Timeout: 120 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

const loadingPage = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memore</title>
<style>
  body{margin:0;display:flex;align-items:center;justify-content:center;
       height:100vh;font-family:system-ui,sans-serif;background:#f5f0e8;color:#444}
  .c{text-align:center}
  .spinner{width:32px;height:32px;border:3px solid #d4c5a9;border-top-color:#8b7355;
           border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{font-size:14px;opacity:.7}
</style>
</head>
<body>
<div class="c"><div class="spinner"></div><p>Memore 正在启动…</p></div>
<script>setTimeout(function(){location.reload()},1500)</script>
</body>
</html>`

func (p *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	targetURL := p.backendURL + r.URL.RequestURI()

	proxyReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, "proxy request creation failed", http.StatusBadGateway)
		return
	}

	for key, values := range r.Header {
		for _, value := range values {
			proxyReq.Header.Add(key, value)
		}
	}

	// 等待后端服务就绪（启动时可能有短暂延迟）
	var resp *http.Response
	for attempts := 0; attempts < 60; attempts++ {
		resp, err = p.client.Do(proxyReq)
		if err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)

		// 重新创建请求（body 可能已被消费）
		proxyReq, _ = http.NewRequestWithContext(r.Context(), r.Method, targetURL, nil)
		for key, values := range r.Header {
			for _, value := range values {
				proxyReq.Header.Add(key, value)
			}
		}
	}

	if err != nil {
		// 对 HTML 页面请求返回加载页面（带自动刷新），而不是 502 错误文本
		accept := r.Header.Get("Accept")
		if strings.Contains(accept, "text/html") || r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, loadingPage)
			return
		}
		http.Error(w, "backend server unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
