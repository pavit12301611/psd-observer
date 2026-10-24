package in.observer.companion;

import android.util.Base64;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Signed web-interface updates delivered by the paired PC ("pc_managed" channel).
 *
 * The PC packs a static web build, signs a canonical manifest with a key that
 * never leaves the PC, and serves it over the authenticated device token. This
 * app pins the first key it is paired with, verifies every manifest and bundle
 * hash, stages the archive, and keeps one previous copy for rollback. A bundle
 * only carries web assets: native Java/manifest changes still need an APK that
 * is installed once. Updates are refused while the boot of a previous update is
 * still unconfirmed, so a bad interface cannot become permanent.
 */
final class WebUpdate {
    static final long MAX_BUNDLE = 32L * 1024 * 1024;
    static final long MAX_TOTAL = 64L * 1024 * 1024;
    static final long MAX_ENTRY = 16L * 1024 * 1024;
    static final int MAX_FILES = 4000;

    private final File root, active, previous, staging;
    private final Object lock = new Object();

    WebUpdate(File root) {
        this.root = root;
        this.active = new File(root, "active");
        this.previous = new File(root, "previous");
        this.staging = new File(root, "staging");
    }

    /**
     * Must match the PC's canonicalManifest() byte for byte: fixed key order, no
     * whitespace, schema pinned to 1, notes optional.
     */
    static String canonical(JSONObject manifest) throws Exception {
        if (manifest.getInt("schema") != 1) throw new Exception("Unsupported update manifest schema.");
        String version = manifest.getString("version");
        if (UpdateRules.tuple(version) == null) throw new Exception("Invalid update version.");
        String hash = manifest.getString("sha256");
        if (!hash.matches("[0-9a-f]{64}")) throw new Exception("Invalid bundle hash.");
        long size = manifest.getLong("size");
        if (size <= 0 || size > MAX_BUNDLE) throw new Exception("Bundle size outside limits.");
        int files = manifest.getInt("fileCount");
        if (files <= 0 || files > MAX_FILES) throw new Exception("Bundle file count outside limits.");
        return "{\"schema\":1,\"version\":" + JSONObject.quote(version)
            + ",\"createdAt\":" + JSONObject.quote(manifest.getString("createdAt"))
            + ",\"sha256\":" + JSONObject.quote(hash)
            + ",\"size\":" + size
            + ",\"fileCount\":" + files
            + ",\"minNative\":" + JSONObject.quote(manifest.optString("minNative", "0.0.0"))
            + ",\"notes\":" + JSONObject.quote(manifest.optString("notes", "")) + "}";
    }

    /** RSA-SHA256 over the canonical manifest using the SPKI key pinned at pairing time. */
    static boolean verify(JSONObject manifest, String signatureBase64, String spkiBase64) {
        if (signatureBase64 == null || spkiBase64 == null) return false;
        try {
            byte[] der = Base64.decode(spkiBase64, Base64.DEFAULT);
            PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
            Signature verifier = Signature.getInstance("SHA256withRSA");
            verifier.initVerify(key);
            verifier.update(canonical(manifest).getBytes(StandardCharsets.UTF_8));
            return verifier.verify(Base64.decode(signatureBase64, Base64.DEFAULT));
        } catch (Exception e) { return false; }
    }

    static String pinId(String spkiBase64) {
        try { return sha256(Base64.decode(spkiBase64, Base64.DEFAULT)).substring(0, 32); }
        catch (Exception e) { return null; }
    }

    static String sha256(byte[] bytes) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] out = digest.digest(bytes);
        StringBuilder text = new StringBuilder(out.length * 2);
        for (byte b : out) text.append(String.format(Locale.ROOT, "%02x", b));
        return text.toString();
    }

    /** Serves an installed asset, or null so the caller falls back to the APK's bundled files. */
    InputStream open(String path) {
        try {
            if (path == null || !active.isDirectory()) return null;
            String relative = path.startsWith("/") ? path.substring(1) : path;
            if (!UpdateRules.safeEntry(relative)) return null;
            File file = new File(active, relative);
            if (!file.isFile()) return null;
            String base = active.getCanonicalPath() + File.separator, target = file.getCanonicalPath();
            if (!target.startsWith(base)) return null;
            return new FileInputStream(file);
        } catch (Exception e) { return null; }
    }

    synchronized JSONObject status() {
        JSONObject state = state();
        JSONObject out = new JSONObject();
        try {
            out.put("installed", state.optString("version", ""));
            out.put("previous", state.optString("previousVersion", ""));
            out.put("pendingBoot", state.optBoolean("pendingBoot", false));
            out.put("rolledBackFrom", state.optString("rolledBackFrom", ""));
            out.put("lastError", state.optString("lastError", ""));
            out.put("storageBytes", directorySize(active));
        } catch (Exception ignored) { /* status is best effort */ }
        return out;
    }

    /**
     * Runs before the WebView loads. If the previous process died while a freshly
     * installed bundle was booting, that bundle is swapped back out first.
     */
    void beginBoot(String shellVersion) {
        synchronized (lock) {
            try {
                JSONObject state = state();
                boolean restored = false;
                // A freshly installed APK may already carry a newer interface than
                // the downloaded bundle; the bundled copy wins so both stay in step.
                String downloaded = state.optString("version", "");
                if (UpdateRules.tuple(shellVersion) != null && UpdateRules.tuple(downloaded) != null && UpdateRules.newer(shellVersion, downloaded)) {
                    deleteRecursive(active);
                    deleteRecursive(previous);
                    state = new JSONObject();
                    state.put("lastError", "The app's built-in interface is newer, so the downloaded one was removed.");
                }
                if (state.optBoolean("pendingBoot", false)) {
                    String bad = state.optString("version", "");
                    if (previous.isDirectory() && new File(previous, "index.html").isFile()) {
                        String restoredVersion = state.optString("previousVersion", "");
                        swapActiveWithPrevious();
                        state = state();
                        state.put("version", restoredVersion);
                        state.put("sha256", "");
                        state.put("previousVersion", bad);
                        state.put("rolledBackFrom", bad);
                        state.put("lastError", "The last interface update did not start; the previous version was restored.");
                        restored = true;
                    } else {
                        deleteRecursive(active);
                        state.put("version", "");
                        state.put("sha256", "");
                        state.put("previousVersion", "");
                        state.put("rolledBackFrom", bad);
                        state.put("lastError", "The last interface update did not start; the built-in interface was restored.");
                    }
                    state.put("pendingBoot", false);
                }
                if (!restored && active.isDirectory() && new File(active, "index.html").isFile()) {
                    state.put("pendingBoot", true);
                    state.put("bootAttempts", state.optInt("bootAttempts", 0) + 1);
                }
                save(state);
            } catch (Exception ignored) { /* the installed interface is still served as-is */ }
        }
    }

    /** The web app confirms it rendered and its bridge answered. */
    synchronized void markHealthy() {
        try {
            JSONObject state = state();
            if (!state.optBoolean("pendingBoot", false)) return;
            state.put("pendingBoot", false);
            state.put("bootAttempts", 0);
            state.put("healthyAt", System.currentTimeMillis());
            save(state);
        } catch (Exception ignored) { /* the next boot retries confirmation */ }
    }

    private HttpURLConnection connection(String url, String token) throws Exception {
        HttpURLConnection c = NativeHttp.connection(url, "GET", token);
        c.setRequestProperty("Accept", "application/json, application/zip");
        return c;
    }

    /** Reads the signed manifest from the paired PC and reports whether it can be applied. */
    JSONObject check(String base, String token, String spkiBase64) throws Exception {
        JSONObject state = status(), out = new JSONObject();
        out.put("installed", state.optString("installed", ""));
        out.put("available", false);
        if (spkiBase64 == null || spkiBase64.isEmpty()) { out.put("reason", "Pair with an updated PC agent before using PC-delivered updates."); return out; }
        HttpURLConnection c = connection(base + "/api/app/update/manifest", token);
        try {
            int code = c.getResponseCode();
            if (code == 404) { out.put("reason", "No signed interface update has been prepared on your PC yet."); return out; }
            if (code != 200) throw new Exception("Your PC did not offer an update (HTTP " + code + ").");
            String body = new String(NativeHttp.read(c.getInputStream(), 64 * 1024), StandardCharsets.UTF_8);
            JSONObject envelope = new JSONObject(body);
            JSONObject manifest = envelope.getJSONObject("manifest");
            String signature = envelope.getString("signature");
            if (!envelope.optString("keyId").equals(pinId(spkiBase64))) throw new Exception("The PC offered an update signed by a different key. Nothing was installed.");
            if (!verify(manifest, signature, spkiBase64)) throw new Exception("The update signature does not match this PC. Nothing was installed.");
            String version = manifest.getString("version");
            out.put("version", version);
            out.put("notes", manifest.optString("notes", ""));
            out.put("size", manifest.getLong("size"));
            out.put("fileCount", manifest.getInt("fileCount"));
            out.put("sha256", manifest.getString("sha256"));
            out.put("minNative", manifest.optString("minNative", "0.0.0"));
            if (!UpdateRules.newer(version, state.optString("installed", ""))) { out.put("reason", "The signed update on your PC is not newer than the installed interface."); return out; }
            out.put("available", true);
            return out;
        } finally { c.disconnect(); }
    }

    /**
     * Downloads, verifies, stages and activates a signed bundle. The manifest is
     * re-fetched rather than trusted from the caller, and every failure leaves
     * the currently installed interface untouched.
     */
    synchronized JSONObject apply(String base, String token, String spkiBase64, String nativeVersion) throws Exception {
        if (spkiBase64 == null || spkiBase64.isEmpty()) throw new Exception("PC-delivered updates need a paired update key. Re-pair with an updated PC agent.");
        String body;
        HttpURLConnection manifestConnection = connection(base + "/api/app/update/manifest", token);
        try {
            if (manifestConnection.getResponseCode() != 200) throw new Exception("No signed update is available from your PC.");
            body = new String(NativeHttp.read(manifestConnection.getInputStream(), 64 * 1024), StandardCharsets.UTF_8);
        } finally { manifestConnection.disconnect(); }
        JSONObject envelope = new JSONObject(body), manifest = envelope.getJSONObject("manifest");
        String signature = envelope.getString("signature");
        if (!envelope.optString("keyId").equals(pinId(spkiBase64)) || !verify(manifest, signature, spkiBase64)) throw new Exception("The update signature does not match this PC. Nothing was installed.");
        String version = manifest.getString("version");
        JSONObject state = state();
        if (!UpdateRules.newer(version, state.optString("version", ""))) throw new Exception("Only a newer signed interface can be installed.");
        String minNative = manifest.optString("minNative", "0.0.0");
        String shellVersion = nativeVersion == null ? "" : nativeVersion.replaceAll("[^0-9.].*$", "");
        if (UpdateRules.tuple(minNative) != null && UpdateRules.newer(minNative, shellVersion)) throw new Exception("This update needs a newer Observer app (" + minNative + "). Install the APK once, then retry.");
        long declared = manifest.getLong("size");
        if (declared <= 0 || declared > MAX_BUNDLE) throw new Exception("The offered bundle is outside the allowed size.");
        File downloaded = new File(root, "download.zip");
        deleteRecursive(staging);
        if (!staging.mkdirs()) throw new Exception("Cannot prepare update storage.");
        try {
            HttpURLConnection bundleConnection = connection(base + "/api/app/update/bundle", token);
            try {
                if (bundleConnection.getResponseCode() != 200) throw new Exception("Your PC did not send the update bundle.");
                long read = 0;
                try (InputStream in = bundleConnection.getInputStream(); OutputStream out = new FileOutputStream(downloaded)) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = in.read(buffer)) > 0) {
                        read += count;
                        if (read > MAX_BUNDLE) throw new Exception("The update bundle is too large.");
                        out.write(buffer, 0, count);
                    }
                }
                if (read != declared) throw new Exception("The update bundle was truncated or padded. Nothing was installed.");
            } finally { bundleConnection.disconnect(); }
            String actual = sha256(readAll(downloaded, MAX_BUNDLE));
            if (!actual.equals(manifest.getString("sha256"))) throw new Exception("The update bundle failed its integrity check. Nothing was installed.");
            File staged = new File(staging, "files");
            if (!staged.mkdirs()) throw new Exception("Cannot stage the update.");
            int count = extract(downloaded, staged);
            if (count != manifest.getInt("fileCount")) throw new Exception("The update bundle does not match its manifest. Nothing was installed.");
            if (!new File(staged, "index.html").isFile()) throw new Exception("The update has no entry page. Nothing was installed.");
            JSONObject current = state();
            String installedNow = current.optString("version", "");
            deleteRecursive(previous);
            if (active.isDirectory() && !active.renameTo(previous)) throw new Exception("Cannot keep a rollback copy. Nothing was installed.");
            if (!staged.renameTo(active)) {
                if (previous.isDirectory()) previous.renameTo(active);
                throw new Exception("Cannot activate the staged update. The previous interface is unchanged.");
            }
            JSONObject next = new JSONObject();
            next.put("version", version);
            next.put("sha256", manifest.getString("sha256"));
            next.put("installedAt", System.currentTimeMillis());
            next.put("pendingBoot", true);
            next.put("previousVersion", installedNow);
            next.put("bootAttempts", 0);
            next.put("lastError", "");
            save(next);
            return status();
        } finally {
            deleteRecursive(downloaded);
            deleteRecursive(staging);
        }
    }

    /** Puts the previous interface back. Used by the owner and by a failed start. */
    synchronized JSONObject rollback() throws Exception {
        if (!active.isDirectory()) throw new Exception("No downloaded interface is installed.");
        String bad = state().optString("version", "");
        if (!previous.isDirectory()) {
            deleteRecursive(active);
            JSONObject next = new JSONObject();
            next.put("version", "");
            next.put("sha256", "");
            next.put("previousVersion", "");
            next.put("pendingBoot", false);
            next.put("rolledBackFrom", bad);
            next.put("lastError", "Reverted to the interface built into this app.");
            save(next);
            return status();
        }
        String restored = state().optString("previousVersion", "");
        swapActiveWithPrevious();
        JSONObject next = new JSONObject();
        next.put("version", restored);
        next.put("sha256", "");
        next.put("previousVersion", bad);
        next.put("pendingBoot", false);
        next.put("rolledBackFrom", bad);
        next.put("lastError", "Reverted to the previous interface.");
        save(next);
        return status();
    }

    private void swapActiveWithPrevious() throws Exception {
        File retired = new File(root, "retired");
        deleteRecursive(retired);
        if (!active.renameTo(retired)) throw new Exception("Cannot move the current interface aside.");
        if (!previous.renameTo(active)) {
            if (!retired.renameTo(active)) throw new Exception("Rollback failed; reinstall the app if the interface does not load.");
            throw new Exception("Cannot restore the previous interface.");
        }
        if (!retired.renameTo(previous)) deleteRecursive(retired);
    }

    private int extract(File zip, File target) throws Exception {
        int count = 0;
        long total = 0;
        Set<String> seen = new HashSet<>();
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry entry;
            byte[] buffer = new byte[16384];
            while ((entry = zin.getNextEntry()) != null) {
                String name = entry.getName();
                if (!UpdateRules.safeEntry(name) || !seen.add(name)) throw new Exception("The update archive contains unsafe paths. Nothing was installed.");
                File file = new File(target, name);
                String base = target.getCanonicalPath() + File.separator;
                if (!file.getCanonicalPath().startsWith(base)) throw new Exception("The update archive escapes its folder. Nothing was installed.");
                if (entry.isDirectory()) {
                    if (!file.isDirectory() && !file.mkdirs()) throw new Exception("Cannot create update folders.");
                    continue;
                }
                File parent = file.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new Exception("Cannot create update folders.");
                count++;
                if (count > MAX_FILES) throw new Exception("The update archive has too many files.");
                long size = 0;
                try (OutputStream out = new FileOutputStream(file)) {
                    int read;
                    while ((read = zin.read(buffer)) > 0) {
                        size += read;
                        if (size > MAX_ENTRY || total + size > MAX_TOTAL) throw new Exception("The update archive is too large.");
                        out.write(buffer, 0, read);
                    }
                }
                total += size;
            }
        }
        return count;
    }

    private static byte[] readAll(File file, long limit) throws Exception {
        if (file.length() > limit) throw new Exception("File exceeds the allowed size.");
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursive(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static long directorySize(File folder) {
        if (folder == null || !folder.isDirectory()) return 0;
        long total = 0;
        File[] children = folder.listFiles();
        if (children != null) for (File child : children) total += child.isDirectory() ? directorySize(child) : child.length();
        return total;
    }

    private JSONObject state() {
        File file = new File(root, "state.json");
        try {
            if (!file.isFile() || file.length() > 16384) return new JSONObject();
            String text = new String(readAll(file, 16384), StandardCharsets.UTF_8);
            return new JSONObject(text);
        } catch (Exception e) { return new JSONObject(); }
    }

    private void save(JSONObject state) throws Exception {
        if (!root.isDirectory() && !root.mkdirs()) throw new Exception("Cannot create update storage.");
        File temp = new File(root, "state.tmp"), target = new File(root, "state.json");
        try (FileOutputStream out = new FileOutputStream(temp)) { out.write(state.toString().getBytes(StandardCharsets.UTF_8)); out.flush(); out.getFD().sync(); }
        deleteRecursive(target);
        if (!temp.renameTo(target)) throw new IOException("Cannot persist update state.");
    }
}
