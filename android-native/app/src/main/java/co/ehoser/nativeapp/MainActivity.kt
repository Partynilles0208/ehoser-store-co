package co.ehoser.nativeapp

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JavascriptInterface
import android.widget.FrameLayout
import android.widget.Toast

private const val CHAT_URL = "https://www.ehoser.de/chat/"
private const val NOTIFICATION_CHANNEL_ID = "ehoser_chat"
private const val REQUEST_MEDIA_PERMISSION = 4101
private const val REQUEST_NOTIFICATION_PERMISSION = 4102
private const val REQUEST_FILE_PICKER = 4103

/** Mobile shell for ehoser Chat with secure Android device integrations. */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(11, 20, 26)
        window.navigationBarColor = Color.rgb(11, 20, 26)
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        createNotificationChannel()
        configureWebView()
        setContentView(webView)
        openUrlFromIntent(intent)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView = WebView(this)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.setBackgroundColor(Color.rgb(11, 20, 26))
        webView.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString EhoserChatAndroid/1.1"
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.addJavascriptInterface(NativeBridge(), "EhoserAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url ?: return true
                if (isAllowedWebUrl(url)) return false
                openExternalUrl(url)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (isAllowedWebUrl(Uri.parse(url))) {
                    view.evaluateJavascript(
                        "document.documentElement.classList.add('ehoser-android-app');" +
                            "document.body && document.body.classList.add('ehoser-android-app');",
                        null
                    )
                    notifyNotificationPermissionToPage()
                }
            }
        }
        webView.webChromeClient = ChatWebChromeClient()
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            enqueueDownload(url, userAgent, contentDisposition, mimeType)
        })
    }

    private fun openUrlFromIntent(openIntent: Intent?) {
        val requested = openIntent?.data
        webView.loadUrl(if (requested != null && isAllowedWebUrl(requested)) requested.toString() else CHAT_URL)
    }

    private fun isAllowedWebUrl(uri: Uri): Boolean {
        if (uri.scheme != "https") return false
        val host = uri.host?.lowercase() ?: return false
        return host == "ehoser.de" || host.endsWith(".ehoser.de") ||
            host == "accounts.google.com" || host.endsWith(".googleusercontent.com")
    }

    private fun isEhoserPage(): Boolean {
        val current = webView.url ?: return false
        val host = Uri.parse(current).host?.lowercase() ?: return false
        return host == "ehoser.de" || host.endsWith(".ehoser.de")
    }

    private fun openExternalUrl(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(this, "Dieser Link kann nicht geöffnet werden.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun requestWebMediaPermission(request: PermissionRequest) {
        if (!isEhoserPage()) {
            request.deny()
            return
        }
        val needed = mutableListOf<String>()
        if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
            checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.CAMERA
        if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) needed += Manifest.permission.RECORD_AUDIO

        if (needed.isEmpty()) {
            grantWebMediaPermission(request)
        } else {
            pendingWebPermissionRequest?.deny()
            pendingWebPermissionRequest = request
            requestPermissions(needed.distinct().toTypedArray(), REQUEST_MEDIA_PERMISSION)
        }
    }

    private fun grantWebMediaPermission(request: PermissionRequest) {
        val granted = mutableListOf<String>()
        if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
            checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        ) granted += PermissionRequest.RESOURCE_VIDEO_CAPTURE
        if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        ) granted += PermissionRequest.RESOURCE_AUDIO_CAPTURE
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQUEST_MEDIA_PERMISSION -> {
                val request = pendingWebPermissionRequest
                pendingWebPermissionRequest = null
                if (request != null) grantWebMediaPermission(request)
            }
            REQUEST_NOTIFICATION_PERMISSION -> notifyNotificationPermissionToPage()
        }
    }

    private fun requestNativeNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATION_PERMISSION)
            return
        }
        if (notificationsAllowed()) {
            notifyNotificationPermissionToPage()
        } else {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            })
        }
    }

    private fun notificationsAllowed(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    }

    private fun notifyNotificationPermissionToPage() {
        if (!::webView.isInitialized || !isEhoserPage()) return
        val allowed = notificationsAllowed()
        webView.post {
            webView.evaluateJavascript(
                "window.onEhoserAndroidNotificationPermission && " +
                    "window.onEhoserAndroidNotificationPermission($allowed);",
                null
            )
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "ehoser Chat",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Neue Nachrichten und eingehende Anrufe"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun showNativeNotification(title: String, body: String, tag: String, url: String) {
        if (!notificationsAllowed()) return
        val target = Uri.parse(url)
        val openIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = if (isAllowedWebUrl(target)) target else Uri.parse(CHAT_URL)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            tag.hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = android.app.Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.take(90))
            .setContentText(body.take(220))
            .setStyle(android.app.Notification.BigTextStyle().bigText(body.take(420)))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        getSystemService(NotificationManager::class.java).notify(tag, tag.hashCode(), notification)
    }

    private fun enqueueDownload(url: String, userAgent: String, contentDisposition: String, mimeType: String) {
        try {
            val filename = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType)
                setTitle(filename)
                setDescription("Download aus ehoser Chat")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, filename)
                addRequestHeader("User-Agent", userAgent)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
            }
            getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(this, "Download gestartet", Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
            openExternalUrl(Uri.parse(url))
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FILE_PICKER) return
        val callback = pendingFileCallback ?: return
        pendingFileCallback = null
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return
        }
        val result = buildList {
            data.data?.let { add(it) }
            data.clipData?.let { clips ->
                for (index in 0 until clips.itemCount) add(clips.getItemAt(index).uri)
            }
        }.distinct().toTypedArray()
        callback.onReceiveValue(result.ifEmpty { null })
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (fullscreenView != null) {
            hideFullscreenContent()
            return
        }
        webView.evaluateJavascript(
            "window.handleEhoserAndroidBack ? window.handleEhoserAndroidBack() : false;"
        ) { handled ->
            if (handled == "true") return@evaluateJavascript
            if (webView.canGoBack()) webView.goBack() else finish()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openUrlFromIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        notifyNotificationPermissionToPage()
    }

    override fun onDestroy() {
        pendingWebPermissionRequest?.deny()
        pendingFileCallback?.onReceiveValue(null)
        webView.removeJavascriptInterface("EhoserAndroid")
        webView.destroy()
        super.onDestroy()
    }

    private inner class ChatWebChromeClient : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread { requestWebMediaPermission(request) }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingWebPermissionRequest == request) pendingWebPermissionRequest = null
        }

        override fun onShowFileChooser(
            view: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: WebChromeClient.FileChooserParams
        ): Boolean {
            pendingFileCallback?.onReceiveValue(null)
            pendingFileCallback = filePathCallback
            val types = fileChooserParams.acceptTypes.filter { it.isNotBlank() }.distinct().toTypedArray()
            val picker = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = if (types.size == 1) types.first() else "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types)
            }
            startActivityForResult(Intent.createChooser(picker, "Datei auswählen"), REQUEST_FILE_PICKER)
            return true
        }

        override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
            return super.onJsAlert(view, url, message, result)
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden()
                return
            }
            fullscreenView = view
            fullscreenCallback = callback
            addContentView(view, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        }

        override fun onHideCustomView() = hideFullscreenContent()
    }

    private fun hideFullscreenContent() {
        fullscreenView?.let { view ->
            (view.parent as? android.view.ViewGroup)?.removeView(view)
        }
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun hasNotificationPermission(): Boolean = notificationsAllowed()

        @JavascriptInterface
        fun requestNotificationPermission() {
            runOnUiThread {
                if (isEhoserPage()) requestNativeNotifications()
            }
        }

        @JavascriptInterface
        fun showNotification(title: String?, body: String?, tag: String?, url: String?) {
            runOnUiThread {
                if (!isEhoserPage()) return@runOnUiThread
                showNativeNotification(
                    title?.ifBlank { "ehoser Chat" } ?: "ehoser Chat",
                    body.orEmpty(),
                    tag?.ifBlank { "ehoser-chat" } ?: "ehoser-chat",
                    url?.ifBlank { CHAT_URL } ?: CHAT_URL
                )
            }
        }
    }
}
