package in.observer.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;

/**
 * One configured read-only command, run from the tile or the widget without
 * opening the app. It is a foreground service because Android would otherwise
 * kill the work, and it shows its own notification so the answer is visible
 * wherever the owner is.
 *
 * The command comes from a fixed allowlist the owner chose in Settings; the
 * service refuses anything else, and the PC still applies every owner gate.
 */
public final class QuickActionService extends android.app.Service {
    /** The only commands this service will ever send. Read-only reports. */
    static final String[] ALLOWED = {"/status", "/usage", "/todo", "/apps", "/pending", "/audit", "/routine"};
    static final String CHANNEL = "observer-quick-action";
    private static final String PREFS = "observer-quick-action";
    private static final String KEY = "command";
    private volatile boolean running;

    /** What the tile and widget run. Defaults to the safest report there is. */
    static String command(Context c) {
        String value = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "/status");
        for (String allowed : ALLOWED) if (allowed.equals(value)) return value;
        return "/status";
    }

    static void save(Context c, String command) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, command).apply();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String command = command(this);
        if (running) {
            finish("Already running", "Your PC is still answering the last quick action.");
            return START_NOT_STICKY;
        }
        if (Build.VERSION.SDK_INT >= 34)
            startForeground(1, progress(this, command), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(1, progress(this, command));
        running = true;
        new Thread(() -> {
            try {
                run(command);
            } catch (Exception e) {
                finish("Quick action failed", e.getMessage() == null ? "Your PC did not answer." : e.getMessage());
            } finally {
                running = false;
                stopSelf();
            }
        }, "observer-quick-action").start();
        return START_NOT_STICKY;
    }

    private void run(String command) throws Exception {
        String raw = new SecureVault(this).get("profile");
        if (raw == null) throw new Exception("Pair your PC first.");
        JSONObject profile = new JSONObject(raw);
        String base = OriginPolicy.base(profile.getString("baseUrl"), profile.optBoolean("allowLan")), token = profile.getString("token");
        String id = UUID.randomUUID().toString();
        JSONObject body = new JSONObject().put("id", id).put("kind", "chat").put("text", command).put("history", new JSONArray());
        android.util.Log.i("Observer", "quick action " + command);
        post(base + "/api/app/jobs", token, body);
        // Read the stable ID only; never repeat the request.
        for (int attempt = 0; attempt < 24; attempt++) {
            Thread.sleep(attempt < 3 ? 1200 : 2500);
            JSONObject job = get(base + "/api/app/jobs/" + id, token);
            String state = job.optString("state");
            if ("replied".equals(state) || "unknown".equals(state) || "cancelled".equals(state) || "rejected".equals(state)) {
                JSONObject result = job.optJSONObject("result");
                String text = result == null ? null : result.optString("text");
                if (text == null || text.isEmpty())
                    text = "unknown".equals(state)
                        ? "Your PC accepted it but kept no result. Open Observer to check."
                        : "No retained result. Open Observer before asking again.";
                finish(command, text);
                return;
            }
        }
        throw new Exception("Your PC is still working. Open Observer to see the result.");
    }

    private static void post(String url, String token, JSONObject body) throws Exception {
        java.net.HttpURLConnection c = NativeHttp.connection(url, "POST", token);
        try {
            byte[] bytes = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(bytes.length);
            try (java.io.OutputStream out = c.getOutputStream()) { out.write(bytes); }
            int code = c.getResponseCode();
            if (code >= 300) throw new Exception("Your PC refused the quick action (HTTP " + code + ").");
        } finally { c.disconnect(); }
    }

    private static JSONObject get(String url, String token) throws Exception {
        java.net.HttpURLConnection c = NativeHttp.connection(url, "GET", token);
        try {
            int code = c.getResponseCode();
            if (code >= 300) throw new Exception("Your PC could not be reached (HTTP " + code + ").");
            return new JSONObject(new String(NativeHttp.read(c.getInputStream(), 2 * 1024 * 1024), java.nio.charset.StandardCharsets.UTF_8));
        } finally { c.disconnect(); }
    }

    private void finish(String title, String text) {
        channels(this);
        Intent open = new Intent(this, MainActivity.class).putExtra("observerPage", "tasks")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 40, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(in.observer.companion.R.drawable.observer_icon)
            .setContentTitle(title)
            .setContentText(text.length() > 220 ? text.substring(0, 220) + "…" : text)
            .setStyle(new Notification.BigTextStyle().bigText(text.substring(0, Math.min(4000, text.length()))))
            .setContentIntent(tap).setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).build();
        try {
            getSystemService(NotificationManager.class).notify(4101, n);
        } catch (SecurityException ignored) { /* Permission revoked between start and answer. */ }
    }

    private static void channels(Context c) {
        NotificationManager n = c.getSystemService(NotificationManager.class);
        n.createNotificationChannel(new NotificationChannel(CHANNEL, "Quick PC actions", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static Notification progress(Context c, String command) {
        channels(c);
        return new Notification.Builder(c, CHANNEL)
            .setSmallIcon(in.observer.companion.R.drawable.observer_icon)
            .setContentTitle("Asking your PC")
            .setContentText(command + " is running. The answer arrives as a notification.")
            .setOngoing(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();
    }

    @Override public android.os.IBinder onBind(Intent intent) { return null; }
}
