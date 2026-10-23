package in.observer.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** A small local-first Android host, not a wrapper around a remote website. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int PICK_FILE = 31, SAVE_FILE = 32, MIC_PERMISSION = 33;
    private volatile boolean foreground = true;
    private WebView web;
    private FrameLayout root;
    private SecureVault vault;
    private TextToSpeech speech;
    private boolean speechReady = false;
    private SpeechRecognizer recognizer;
    private String recognitionId;
    private ValueCallback<Uri[]> fileChooser;
    private JSONObject pendingSave;
    private String pendingSaveId;
    private final Object sessionLock = new Object();
    private final AtomicInteger epoch = new AtomicInteger();
    private final AtomicInteger cloudEpoch = new AtomicInteger();
    private volatile HttpURLConnection cloudConnection;
    private volatile String bridgeBase = "", bridgeToken = "";
    private final ThreadPoolExecutor io = new ThreadPoolExecutor(3, 4, 20, TimeUnit.SECONDS, new ArrayBlockingQueue<>(12));

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        vault = new SecureVault(this);
        try { String value = vault.get("profile"); if (value != null) { JSONObject p = new JSONObject(value); bridgeBase = OriginPolicy.base(p.getString("baseUrl"), p.optBoolean("allowLan")); bridgeToken = p.getString("token"); } }
        catch (Exception e) { bridgeBase = ""; bridgeToken = ""; vault.remove("profile"); vault.remove("state"); }
        root = new FrameLayout(this); root.setBackgroundColor(Color.WHITE); setContentView(root);
        web = new WebView(this); web.setBackgroundColor(Color.WHITE); root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom)); return insets;
            });
        }
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true); // Only user-selected SAF uploads; navigation remains origin-blocked.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true); settings.setSafeBrowsingEnabled(true); settings.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && HOST.equals(uri.getHost())) return false;
                if (request.isForMainFrame() && request.hasGesture() && OriginPolicy.external(uri.toString())) external(uri.toString());
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return blocked();
                String path = u.getPath(); if (path == null || path.equals("/")) path = "/index.html";
                if (path.contains("..") || path.contains("\\") || path.contains("\0")) return blocked();
                try { return new WebResourceResponse(mime(path), "UTF-8", getAssets().open("public" + path)); } catch (Exception e) { return blocked(); }
            }
            // Never override SSL errors to proceed. The platform default cancels.
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooser != null) fileChooser.onReceiveValue(null); fileChooser = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
                try { startActivityForResult(intent, PICK_FILE); return true; } catch (Exception e) { callback.onReceiveValue(null); fileChooser = null; return false; }
            }
            @Override public void onPermissionRequest(android.webkit.PermissionRequest request) { request.deny(); }
        });
        web.addJavascriptInterface(new AndroidBridge(), "ObserverAndroid");
        speech = new TextToSpeech(this, status -> speechReady = status == TextToSpeech.SUCCESS);
        web.loadUrl("https://" + HOST + "/index.html");
    }
    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html"; if (path.endsWith(".js")) return "text/javascript"; if (path.endsWith(".css")) return "text/css"; if (path.endsWith(".svg")) return "image/svg+xml"; if (path.endsWith(".png")) return "image/png"; if (path.endsWith(".json")) return "application/json"; return "application/octet-stream";
    }
    private static WebResourceResponse blocked() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0])); }
    private void respond(String id, Object data, String error) {
        try {
            JSONObject packet = new JSONObject().put("id", id).put("ok", error == null);
            if (error == null) packet.put("data", data == null ? JSONObject.NULL : data); else packet.put("error", error);
            String script = "window.dispatchEvent(new CustomEvent('observer-native-result',{detail:" + JSONObject.quote(packet.toString()) + "}));";
            runOnUiThread(() -> { if (web != null && !isFinishing()) web.evaluateJavascript(script, null); });
        } catch (Exception ignored) { /* No credentials, text, tokens or PINs in logs. */ }
    }
    private void external(String url) { if (!OriginPolicy.external(url)) return; try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {} }
    private JSONObject profile() throws Exception { return bridgeToken.isEmpty() ? null : new JSONObject().put("baseUrl", bridgeBase).put("native", true); }
    private void stopSpeech() {
        if (recognizer != null) { recognizer.cancel(); recognizer.destroy(); recognizer = null; }
        if (recognitionId != null) { respond(recognitionId, null, "Speech capture stopped."); recognitionId = null; }
        if (speech != null) speech.stop();
    }
    private void recognize(String id, String language) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            respond(id, null, "Microphone permission is needed. Allow it, then tap the microphone again.");
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_PERMISSION); return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { respond(id, null, "Install or enable a speech recognition provider, or type instead."); return; }
        stopSpeech(); recognitionId = id;
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            public void onReadyForSpeech(Bundle b) {} public void onBeginningOfSpeech() {} public void onRmsChanged(float r) {} public void onBufferReceived(byte[] b) {} public void onEndOfSpeech() {} public void onPartialResults(Bundle b) {} public void onEvent(int t, Bundle b) {}
            public void onError(int code) { String responseId = id.equals(recognitionId) ? id : null; if (responseId != null) recognitionId = null; if (responseId != null) respond(responseId, null, "Speech recognition stopped (" + code + "). Check your provider, language and network."); }
            public void onResults(Bundle b) { String responseId = id.equals(recognitionId) ? id : null; if (responseId != null) recognitionId = null; ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION); try { if (responseId != null) respond(responseId, new JSONObject().put("text", list == null || list.isEmpty() ? "" : list.get(0)), null); } catch (Exception ignored) {} }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_LANGUAGE, language).putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        recognizer.startListening(intent);
    }
    public final class AndroidBridge {
        @JavascriptInterface public void postMessage(String raw) {
            String id = "";
            try {
                if (raw == null || raw.length() > 12 * 1024 * 1024) throw new Exception("Request exceeds the mobile budget.");
                JSONObject packet = new JSONObject(raw); id = packet.getString("id");
                if (!id.matches("[a-fA-F0-9-]{36}")) throw new Exception("Invalid request id.");
                String method = packet.getString("method"); JSONObject p = packet.optJSONObject("payload"); if (p == null) p = new JSONObject();
                final String responseId = id; final JSONObject payload = p;
                if (method.equals("recognize")) { if (!foreground) throw new Exception("Open the app before using the microphone."); runOnUiThread(() -> recognize(responseId, payload.optString("language", "en-IN"))); return; }
                if (method.equals("stopSpeech")) { runOnUiThread(() -> { stopSpeech(); respond(responseId, true, null); }); return; }
                if (method.equals("speak")) { runOnUiThread(() -> { if (!foreground) { respond(responseId, null, "Playback is paused in the background."); return; } if (!speechReady) { respond(responseId, null, "Speech engine is not ready."); return; } speech.setLanguage(Locale.forLanguageTag(payload.optString("language", "en-IN"))); speech.speak(payload.optString("text").substring(0, Math.min(2400, payload.optString("text").length())), TextToSpeech.QUEUE_FLUSH, null, "observer"); respond(responseId, true, null); }); return; }
                if (method.equals("appearance")) { runOnUiThread(() -> { boolean dark = payload.optBoolean("dark"), protect = payload.optBoolean("screenPrivacy"); int color = dark ? Color.rgb(16, 16, 16) : Color.WHITE; root.setBackgroundColor(color); web.setBackgroundColor(color); getWindow().setStatusBarColor(color); getWindow().setNavigationBarColor(color); int flags = dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR; web.setSystemUiVisibility(flags); if (protect) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE); else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE); respond(responseId, true, null); }); return; }
                if (method.equals("openExternal")) { String url = p.getString("url"); if (!OriginPolicy.external(url)) throw new Exception("Unsafe external link."); runOnUiThread(() -> { external(url); respond(responseId, true, null); }); return; }
                if (method.equals("download")) { if (bridgeToken.isEmpty()) throw new Exception("Pair your PC first."); OriginPolicy.apiPath(p.getString("path")); runOnUiThread(() -> {
                    if (pendingSave != null) { respond(responseId, null, "Finish the current save dialog first."); return; }
                    pendingSave = payload; pendingSaveId = responseId;
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, payload.optString("name", "download").replaceAll("[\\\\/\\r\\n]", "_"));
                    try { startActivityForResult(intent, SAVE_FILE); } catch (Exception e) { pendingSave = null; pendingSaveId = null; respond(responseId, null, "No file-saving provider is available."); }
                }); return; }
                if (method.equals("minimize")) { runOnUiThread(() -> moveTaskToBack(true)); respond(id, true, null); return; }
                if (method.equals("logout")) {
                    synchronized (sessionLock) { epoch.incrementAndGet(); bridgeToken = ""; bridgeBase = ""; vault.remove("profile"); vault.remove("state"); }
                    runOnUiThread(MainActivity.this::stopSpeech); respond(responseId, true, null); return;
                }
                if (method.equals("clearCloud") || method.equals("cancelCloud")) {
                    synchronized (sessionLock) { cloudEpoch.incrementAndGet(); if (method.equals("clearCloud")) vault.remove("cloud"); }
                    HttpURLConnection c = cloudConnection; if (c != null) c.disconnect(); respond(responseId, true, null); return;
                }
                final int generation = method.equals("pair") ? epoch.incrementAndGet() : epoch.get();
                final int cloudGeneration = method.equals("configureCloud") ? cloudEpoch.incrementAndGet() : cloudEpoch.get();
                io.execute(() -> execute(responseId, method, payload, generation, cloudGeneration));
            } catch (Exception e) { if (!id.isEmpty()) respond(id, null, e.getMessage() == null ? "Android request unavailable." : e.getMessage()); }
        }
    }
    private void execute(String id, String method, JSONObject p, int requestEpoch, int requestCloudEpoch) {
        try {
            switch (method) {
                case "restore": respond(id, profile(), null); return;
                case "readState": respond(id, vault.get("state"), null); return;
                case "writeState": {
                    String value = p.getString("value"); if (value.length() > 2 * 1024 * 1024) throw new Exception("History exceeds the local storage budget.");
                    new JSONObject(value); synchronized (sessionLock) { if (requestEpoch != epoch.get()) throw new Exception("Session changed; old history was not saved."); vault.put("state", value); } respond(id, true, null); return;
                }
                case "pair": {
                    int generation = requestEpoch; String base = OriginPolicy.base(p.getString("baseUrl"), p.optBoolean("allowLan"));
                    String pin = p.getString("pin"); if (pin.isEmpty() || pin.length() > 128) throw new Exception("Invalid dashboard PIN.");
                    JSONObject r = NativeHttp.request(base + "/api/login", "POST", null, new JSONObject().put("pin", pin), false, null);
                    JSONObject data = r.optJSONObject("json"); if (r.getInt("status") != 200 || data == null || data.optString("token").trim().isEmpty()) throw new Exception(data == null ? "PC login failed." : data.optString("detail", "PC login failed."));
                    synchronized (sessionLock) { if (generation != epoch.get()) throw new Exception("Connection changed."); vault.put("profile", new JSONObject().put("baseUrl", base).put("token", data.getString("token")).put("allowLan", p.optBoolean("allowLan")).toString()); bridgeBase = base; bridgeToken = data.getString("token"); }
                    respond(id, profile(), null); return;
                }
                case "logout": {
                    synchronized (sessionLock) { epoch.incrementAndGet(); bridgeToken = ""; bridgeBase = ""; vault.remove("profile"); vault.remove("state"); }
                    runOnUiThread(this::stopSpeech); respond(id, true, null); return;
                }
                case "request": {
                    String path = OriginPolicy.apiPath(p.getString("path")), base = bridgeBase, token = bridgeToken; int generation = requestEpoch;
                    boolean screenOrInput = path.startsWith("/api/screen") || path.equals("/api/tap") || path.equals("/api/type") || path.equals("/api/key");
                    if (!foreground && screenOrInput) throw new Exception("Screen preview and manual input are paused while backgrounded.");
                    if (token.isEmpty()) throw new Exception("Pair your PC first.");
                    String verb = p.optString("method", "GET"); if (!verb.equals("GET") && !verb.equals("POST")) throw new Exception("Unsupported request method.");
                    JSONObject headers = p.optJSONObject("headers"); String etag = headers == null ? null : headers.optString("if-none-match", "");
                    JSONObject result = NativeHttp.request(base + path, verb, token, p.optJSONObject("body"), p.optBoolean("binary"), etag);
                    if (generation != epoch.get() || !foreground && screenOrInput) throw new Exception("Session or foreground changed. Late result discarded."); respond(id, result, null); return;
                }
                case "checkUpdates": {
                    HttpURLConnection c = NativeHttp.connection("https://api.github.com/repos/pavit12301611/psd-observer/releases?per_page=30", "GET", null);
                    try { if (c.getResponseCode() != 200) throw new Exception("Official update check unavailable. Try again later."); respond(id, new JSONArray(new String(NativeHttp.read(c.getInputStream(), 2 * 1024 * 1024), StandardCharsets.UTF_8)), null); } finally { c.disconnect(); } return;
                }
                case "cloudStatus": {
                    String value = vault.get("cloud"); JSONObject saved = value == null ? null : new JSONObject(value);
                    respond(id, saved == null ? new JSONObject().put("configured", false) : new JSONObject().put("configured", true).put("provider", saved.getString("provider")).put("model", saved.getString("model")), null); return;
                }
                case "configureCloud": {
                    String provider = p.getString("provider"), model = p.getString("model"), key = p.getString("key").trim();
                    cloudEndpoint(provider);
                    if (!model.matches("[a-zA-Z0-9_.:/-]{1,160}") || key.isEmpty() || key.length() > 4096) throw new Exception("Enter a valid model ID and provider key.");
                    synchronized (sessionLock) { if (requestCloudEpoch != cloudEpoch.get()) throw new Exception("Cloud setup cancelled."); vault.put("cloud", new JSONObject().put("provider", provider).put("model", model).put("key", key).toString()); }
                    respond(id, new JSONObject().put("configured", true).put("provider", provider).put("model", model), null); return;
                }
                case "cloudChat": {
                    String cloudSaved = vault.get("cloud"); if (cloudSaved == null) throw new Exception("Configure Direct AI first."); JSONObject saved = new JSONObject(cloudSaved); String key = saved.getString("key"), provider = saved.getString("provider");
                    JSONArray incoming = p.getJSONArray("messages"), messages = new JSONArray();
                    if (incoming.length() > 16) throw new Exception("Too many messages in mobile context.");
                    messages.put(new JSONObject().put("role", "system").put("content", "You are Observer, a helpful mobile AI companion. This is text-only Direct AI mode. You have NO PC access, tools, live browsing or action execution. Never claim to have performed a PC action. Explain uncertainty honestly. Follow the user's language."));
                    int size = 0;
                    for (int i = 0; i < incoming.length(); i++) { JSONObject m = incoming.getJSONObject(i); String role = m.getString("role"), text = m.getString("content"); if (!(role.equals("user") || role.equals("assistant"))) throw new Exception("Invalid chat role."); size += text.length(); if (size > 40000) throw new Exception("Context too large; start a new conversation."); messages.put(new JSONObject().put("role", role).put("content", text)); }
                    if (requestCloudEpoch != cloudEpoch.get()) throw new Exception("Cloud request cancelled.");
                    JSONObject body = new JSONObject().put("model", saved.getString("model")).put("messages", messages).put("stream", false).put(provider.equals("openai") ? "max_completion_tokens" : "max_tokens", 1800);
                    HttpURLConnection c = NativeHttp.connection(cloudEndpoint(provider), "POST", null); cloudConnection = c;
                    try {
                        c.setReadTimeout(90000); c.setDoOutput(true); c.setRequestProperty("Authorization", "Bearer " + key); c.setRequestProperty("Content-Type", "application/json"); byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); c.setFixedLengthStreamingMode(bytes.length);
                        try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                        int code = c.getResponseCode(); if (code >= 300 && code < 400) throw new Exception("Provider redirect blocked.");
                        if (code >= 400) throw new Exception("Provider returned HTTP " + code + ". Check the configured model, API key, quota and account. Provider error text is not echoed to protect key fragments.");
                        JSONObject response = new JSONObject(new String(NativeHttp.read(c.getInputStream(), 2 * 1024 * 1024), StandardCharsets.UTF_8));
                        if (requestCloudEpoch != cloudEpoch.get()) throw new Exception("Cloud request cancelled; late response discarded.");
                        String text = response.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content"); respond(id, new JSONObject().put("ok", true).put("text", text.substring(0, Math.min(48000, text.length()))), null);
                    } finally { if (cloudConnection == c) cloudConnection = null; c.disconnect(); }
                    return;
                }
                case "deviceInfo": respond(id, new JSONObject().put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT).put("debug", BuildConfig.DEBUG).put("version", BuildConfig.VERSION_NAME), null); return;
                default: throw new Exception("Unsupported Android method.");
            }
        } catch (Exception e) { respond(id, null, e.getMessage() == null ? "Android request failed. Its PC-side outcome may be unknown." : e.getMessage()); }
    }
    private static String cloudEndpoint(String provider) throws Exception {
        switch (provider) {
            case "groq": return "https://api.groq.com/openai/v1/chat/completions";
            case "openrouter": return "https://openrouter.ai/api/v1/chat/completions";
            case "openai": return "https://api.openai.com/v1/chat/completions";
            default: throw new Exception("Unsupported cloud provider. Arbitrary endpoints are not accepted.");
        }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILE && fileChooser != null) { fileChooser.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null); fileChooser = null; }
        if (request == SAVE_FILE && pendingSave != null) {
            JSONObject p = pendingSave; String id = pendingSaveId; pendingSave = null; pendingSaveId = null;
            if (result != RESULT_OK || data == null || data.getData() == null) { respond(id, null, "Save cancelled."); return; }
            Uri uri = data.getData(); int generation = epoch.get(); String base = bridgeBase, token = bridgeToken;
            io.execute(() -> {
                HttpURLConnection c = null;
                try {
                    if (token.isEmpty()) throw new Exception("Pair your PC again.");
                    c = NativeHttp.connection(base + OriginPolicy.apiPath(p.getString("path")), "GET", token);
                    if (c.getResponseCode() != 200) throw new Exception("File unavailable or expired (HTTP " + c.getResponseCode() + ").");
                    try (InputStream in = c.getInputStream(); OutputStream out = getContentResolver().openOutputStream(uri, "w")) {
                        if (out == null) throw new Exception("Could not open the chosen destination."); byte[] buffer = new byte[32 * 1024]; long size = 0; int n;
                        while ((n = in.read(buffer)) != -1) { if (generation != epoch.get()) throw new Exception("Session changed; download stopped."); size += n; if (size > 256L * 1024 * 1024) throw new Exception("Download exceeds the 256 MB safety limit."); out.write(buffer, 0, n); }
                    }
                    respond(id, true, null);
                } catch (Exception e) { try { getContentResolver().delete(uri, null, null); } catch (Exception ignored) {} respond(id, null, e.getMessage()); }
                finally { if (c != null) c.disconnect(); }
            });
        }
    }
    @Override public void onBackPressed() { if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('observer-back'));", null); else super.onBackPressed(); }
    @Override protected void onPause() { foreground = false; super.onPause(); stopSpeech(); if (web != null) { web.evaluateJavascript("window.dispatchEvent(new Event('observer-background'));", null); web.onPause(); } }
    @Override protected void onResume() { foreground = true; super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { stopSpeech(); if (speech != null) speech.shutdown(); if (cloudConnection != null) cloudConnection.disconnect(); io.shutdownNow(); if (fileChooser != null) fileChooser.onReceiveValue(null); if (web != null) { web.removeJavascriptInterface("ObserverAndroid"); web.destroy(); web = null; } super.onDestroy(); }
}
