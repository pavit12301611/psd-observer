package in.observer.companion;
import org.junit.Test;
import static org.junit.Assert.*;
public final class UpdateRulesTest {
    @Test public void onlyStrictNewerVersionsWin() {
        assertTrue(UpdateRules.newer("1.2.1", "1.2.0"));
        assertTrue(UpdateRules.newer("1.10.0", "1.9.9"));
        assertTrue(UpdateRules.newer("2.0.0", "1.99.99"));
        assertTrue("a first install is newer than nothing", UpdateRules.newer("1.0.0", ""));
        assertFalse("equal versions are refused, not reinstalled", UpdateRules.newer("1.2.0", "1.2.0"));
        assertFalse(UpdateRules.newer("1.1.9", "1.2.0"));
        for (String bad : new String[]{null, "", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-preview", "1.2.x", "../1.2.3", "99999.0.0"}) assertFalse(String.valueOf(bad), UpdateRules.newer(bad, "0.0.0"));
        assertTrue("an unreadable installed version must not block a real update", UpdateRules.newer("1.2.3", "not a version"));
        assertTrue("an unreadable installed version also lets a signed update through", UpdateRules.newer("0.0.9", "bad"));
    }
    @Test public void archiveNamesCannotEscapeOrDuplicateStructure() {
        for (String name : new String[]{"index.html", "assets/app-1.2.3.js", "assets/fonts/inter.woff2", "a/b/c.png"}) assertTrue(name, UpdateRules.safeEntry(name));
        for (String name : new String[]{null, "", "/etc/passwd", "../secret", "a/../../b", "a/./b", "a//b", "a\\b", "./x", "x\u0000y", "line\nbreak"}) assertFalse(String.valueOf(name), UpdateRules.safeEntry(name));
        StringBuilder longName = new StringBuilder(); for (int i = 0; i < 181; i++) longName.append('a');
        assertFalse(UpdateRules.safeEntry(longName.toString()));
    }
    @Test public void previewSuffixStrippedBeforeComparingNativeFloor() {
        assertEquals("1.2.0", "1.2.0-preview".replaceAll("[^0-9.].*$", ""));
        assertTrue(UpdateRules.newer("1.3.0", "1.2.0-preview".replaceAll("[^0-9.].*$", "")));
        assertFalse(UpdateRules.newer("1.2.0", "1.2.0-preview".replaceAll("[^0-9.].*$", "")));
    }
}
