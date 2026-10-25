package in.observer.companion;

import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** HTTPS uses platform certificate verification. Redirects never receive credentials. */
final class NativeHttp {
    static final int MAX_RESPONSE = 24 * 1024 * 1024;
    static HttpURLConnection connection(String url, String method, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000); c.setReadTimeout(20_000); c.setInstanceFollowRedirects(false);
        c.setRequestMethod(method); c.setUseCaches(false); c.setRequestProperty("Accept", "application/json, image/*, application/octet-stream");
        c.setRequestProperty("User-Agent", "ObserverCompanion/1.0 Android");
        if (token != null && !token.isEmpty()) c.setRequestProperty("x-bridge-token", token);
        return c;
    }
    static byte[] read(InputStream stream, int limit) throws Exception {
        if (stream == null) return new byte[0];
        try (InputStream input = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024]; int n;
            while ((n = input.read(buffer)) != -1) { if (out.size() + n > limit) throw new Exception("Response exceeds the mobile memory budget. Use a smaller file."); out.write(buffer, 0, n); }
            return out.toByteArray();
        }
    }
    static JSONObject request(String url, String method, String token, JSONObject body, boolean binary, String etag) throws Exception {
        return request(url,method,token,body,binary,etag,20000);
    }
    static JSONObject request(String url, String method, String token, JSONObject body, boolean binary, String etag, int timeout) throws Exception {
        HttpURLConnection c = connection(url, method, token);
        c.setReadTimeout(Math.max(3000,Math.min(30000,timeout)));
        try {
            if (etag != null && !etag.isEmpty()) c.setRequestProperty("If-None-Match", etag);
            if (body != null && method.equals("POST")) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 12 * 1024 * 1024) throw new Exception("Upload exceeds the mobile limit.");
                c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int status = c.getResponseCode();
            if (status >= 300 && status < 400 && status != 304) throw new Exception("Redirect blocked. Enter the final HTTPS bridge address; credentials were not forwarded.");
            JSONObject headers = new JSONObject(); String tag = c.getHeaderField("ETag"); if (tag != null) headers.put("etag", tag);
            // The screen size lets the page place its pointer marker even where
            // the compositor never draws a cursor (GNOME Wayland portal).
            String screenWidth = c.getHeaderField("x-screen-width"), screenHeight = c.getHeaderField("x-screen-height");
            if (screenWidth != null) headers.put("x-screen-width", screenWidth);
            if (screenHeight != null) headers.put("x-screen-height", screenHeight);
            String mime = c.getContentType(); if (mime == null) mime = "application/octet-stream";
            JSONObject response = new JSONObject().put("status", status).put("headers", headers).put("mime", mime);
            if (status == 304) return response;
            byte[] bytes = read(status >= 400 ? c.getErrorStream() : c.getInputStream(), MAX_RESPONSE);
            if (binary && status >= 200 && status < 300) return response.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            try { return response.put("json", new JSONObject(new String(bytes, StandardCharsets.UTF_8))); }
            catch (Exception e) { if (status >= 400) return response.put("json", new JSONObject().put("detail", "PC returned HTTP " + status)); throw new Exception("The server did not return the expected JSON response."); }
        } finally { c.disconnect(); }
    }
}
