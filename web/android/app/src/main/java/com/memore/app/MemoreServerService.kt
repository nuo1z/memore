package com.memore.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import mobile.Mobile
import java.io.File
import kotlin.concurrent.thread

class MemoreServerService : Service() {
  @Volatile
  private var startupRequested = false
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    acquireWakeLock()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, createNotification())
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!startupRequested) {
      startupRequested = true
      thread(name = "memore-server-bootstrap", isDaemon = true) {
        startEmbeddedServer()
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    try {
      Mobile.stopServer()
    } catch (_: Exception) {
      // Ignore stop errors during process teardown.
    }
    releaseWakeLock()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startEmbeddedServer() {
    val dataDir = File(filesDir, "memore").apply { mkdirs() }.absolutePath
    try {
      if (!Mobile.isRunning()) {
        Mobile.startServer(dataDir, SERVER_PORT)
      }
      Log.i(TAG, "Memore embedded server ready: $dataDir, port=$SERVER_PORT")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to start embedded server", e)
    }
  }

  private fun createNotification(): Notification {
    val launchIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Memore")
      .setContentText("Memore 正在后台运行")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Memore Background Service",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Memore local server foreground service"
    }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(channel)
  }

  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Memore:ServerWakeLock").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
  }

  companion object {
    private const val TAG = "MemoreServerService"
    private const val CHANNEL_ID = "memore_server_channel"
    private const val NOTIFICATION_ID = 11001
    const val SERVER_PORT: Long = 8081

    fun start(context: Context) {
      val intent = Intent(context, MemoreServerService::class.java)
      ContextCompat.startForegroundService(context, intent)
    }
  }
}
