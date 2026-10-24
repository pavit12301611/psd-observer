package in.observer.companion;

/** Pure version and archive-name rules for the PC-delivered update channel. */
final class UpdateRules {
    static final String VERSION = "\\d{1,4}\\.\\d{1,3}\\.\\d{1,3}";

    private UpdateRules() { }

    /** Parses a strict X.Y.Z version, or returns null so callers can refuse it. */
    static int[] tuple(String version) {
        if (version == null || !version.matches(VERSION)) return null;
        String[] parts = version.split("\\.");
        try { return new int[]{ Integer.parseInt(parts[0]), Integer.parseInt(parts[1]), Integer.parseInt(parts[2]) }; }
        catch (NumberFormatException e) { return null; }
    }

    /** True only when {@code candidate} is strictly newer; unparsable input never wins. */
    static boolean newer(String candidate, String installed) {
        int[] a = tuple(candidate), b = tuple(installed);
        if (a == null) return false;
        if (b == null) return true;
        for (int i = 0; i < 3; i++) if (a[i] != b[i]) return a[i] > b[i];
        return false;
    }

    /** Archive names must stay inside the target folder; absolute, parent and empty segments are refused. */
    static boolean safeEntry(String name) {
        if (name == null || name.isEmpty() || name.length() > 180 || name.startsWith("/") || name.indexOf('\\') >= 0) return false;
        for (int i = 0; i < name.length(); i++) if (name.charAt(i) < 0x20) return false;
        for (String part : name.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return true;
    }
}
