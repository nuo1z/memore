package com.memore.app

import android.os.Bundle
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : BridgeActivity() {
  private val healthCheckExecutor = Executors.newSingleThreadExecutor()
  private var lastBackPressedAt = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    // 先启动前台服务，再初始化 WebView 容器。
    MemoreServerService.start(this)
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          handleBackPressed()
        }
      },
    )
    waitForServerAndReload()
  }

  private fun handleBackPressed() {
    val webView = bridge?.webView
    if (webView == null) {
      handleDefaultBackPress()
      return
    }

    // 先让前端尝试消费返回键（关闭侧栏、弹层、聚焦编辑器等）。
    webView.evaluateJavascript(
      "(function(){try{return (window.__memoreHandleAndroidBack && window.__memoreHandleAndroidBack()) ? '1' : '0';}catch(_){return '0';}})();",
    ) { result ->
      val consumed = result == "\"1\"" || result == "1" || result == "\"true\"" || result == "true"
      if (!consumed) {
        runOnUiThread { handleDefaultBackPress() }
      }
    }
  }

  private fun handleDefaultBackPress() {
    val webView = bridge?.webView
    if (webView != null && webView.canGoBack()) {
      webView.goBack()
      return
    }

    val now = System.currentTimeMillis()
    if (now - lastBackPressedAt < 1800) {
      moveTaskToBack(true)
      return
    }

    lastBackPressedAt = now
    Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show()
  }

  override fun onDestroy() {
    healthCheckExecutor.shutdownNow()
    super.onDestroy()
  }

  private fun waitForServerAndReload() {
    healthCheckExecutor.execute {
      repeat(60) {
        if (isServerReady()) {
          runOnUiThread {
            bridge?.webView?.reload()
          }
          return@execute
        }
        Thread.sleep(150)
      }
    }
  }

  private fun isServerReady(): Boolean {
    val connection = (URL(HEALTHCHECK_URL).openConnection() as HttpURLConnection).apply {
      connectTimeout = 500
      readTimeout = 500
      requestMethod = "GET"
    }

    return try {
      connection.responseCode in 200..299
    } catch (_: Exception) {
      false
    } finally {
      connection.disconnect()
    }
  }

  companion object {
    private const val HEALTHCHECK_URL = "http://127.0.0.1:${MemoreServerService.SERVER_PORT}/healthz"
  }
}
