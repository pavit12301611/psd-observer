package in.observer.companion;

import java.net.URI;
import java.util.Locale;

/** Small pure-Java policy, also tested on the JVM without Android. */
public final class OriginPolicy {
    private OriginPolicy() {}
    public static boolean privateHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
        if (h.matches("^(fc|fd)[0-9a-f]{2}:.*")) return true;
        if (!h.matches("\\d+\\.\\d+\\.\\d+\\.\\d+")) return false;
        String[] p = h.split("\\."); int[] b = new int[4];
        try { for (int i = 0; i < 4; i++) { if (p[i].length() > 1 && p[i].charAt(0) == '0') return false; b[i] = Integer.parseInt(p[i]); if (b[i] < 0 || b[i] > 255) return false; } } catch (NumberFormatException e) { return false; }
        return b[0] == 10 || b[0] == 192 && b[1] == 168 || b[0] == 172 && b[1] >= 16 && b[1] <= 31 || b[0] == 100 && b[1] >= 64 && b[1] <= 127;
    }
    public static String base(String raw, boolean allowLan) throws Exception {
        URI u = new URI(raw);
        String scheme = u.getScheme(), host = u.getHost();
        if (host == null || !("https".equals(scheme) || "http".equals(scheme)) || u.getUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null || !(u.getRawPath() == null || u.getRawPath().isEmpty() || u.getRawPath().equals("/"))) throw new Exception("Use an HTTPS bridge origin without credentials, path or query.");
        String h = host.toLowerCase(Locale.ROOT);
        if (h.equals("localhost") || h.startsWith("127.") || h.equals("0.0.0.0") || h.equals("::1") || h.equals("[::1]")) throw new Exception("Use your PC network address, not localhost.");
        if ("http".equals(scheme) && (!allowLan || !privateHost(host))) throw new Exception("Public HTTP is blocked. Use HTTPS or explicitly allow a trusted private IP.");
        if (u.getPort() == 0 || u.getPort() < -1 || u.getPort() > 65535) throw new Exception("Invalid port.");
        return scheme + "://" + u.getRawAuthority();
    }
    public static String apiPath(String path) throws Exception {
        if (!path.matches("^/api/[a-zA-Z0-9/_-]+(?:\\?[^#]*)?$") || path.contains("..") || path.indexOf('\\') >= 0 || path.indexOf('\r') >= 0 || path.indexOf('\n') >= 0 || path.startsWith("/api/login")) throw new Exception("Unsafe API path blocked.");
        return path;
    }
    public static boolean mobileVersion(String version){try{String[] p=version.split("\\.");int major=Integer.parseInt(p[0]),minor=Integer.parseInt(p[1]);return major>3||major==3&&minor>=10;}catch(Exception e){return false;}}
    public static boolean external(String url) {
        try { URI u = new URI(url); return ("https".equals(u.getScheme()) || "http".equals(u.getScheme())) && u.getHost() != null && u.getUserInfo() == null; } catch (Exception e) { return false; }
    }
}
