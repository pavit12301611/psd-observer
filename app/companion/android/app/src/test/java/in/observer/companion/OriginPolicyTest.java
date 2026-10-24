package in.observer.companion;
import org.junit.Test;
import static org.junit.Assert.*;
public final class OriginPolicyTest {
    @Test public void privateNetworksAreExactAndNeverSuffixOrOctal() {
        for (String host : new String[]{"10.0.0.1", "192.168.1.2", "172.16.0.1", "100.64.1.1", "[fd00::1]"}) assertTrue(host, OriginPolicy.privateHost(host));
        for (String host : new String[]{"10.evil.com", "10.300.0.1", "172.32.0.1", "100.128.0.1", "010.0.0.1", "127.0.0.1", "10.0.0.1.example"}) assertFalse(host, OriginPolicy.privateHost(host));
    }
    @Test public void credentialsAndPublicHttpCannotBecomeBridgeOrigins() {
        for (String url : new String[]{"http://example.com", "https://user:pass@example.com", "https://127.0.0.1", "https://[::1]", "file:///tmp", "https://pc.example/path", "https://pc.example/?t=secret", "https://pc.example/#secret", "http://192.168.1.2:0"}) {
            try { OriginPolicy.base(url, true); fail(url); } catch (Exception expected) { }
        }
    }
    @Test public void localHttpIsExplicitOptInAndOnlyRelativeAuthenticatedApiPathsAreAllowed() throws Exception {
        assertEquals("http://10.0.2.2:8787", OriginPolicy.base("http://10.0.2.2:8787", true));
        try { OriginPolicy.base("http://10.0.2.2:8787", false); fail(); } catch (Exception expected) { }
        assertEquals("/api/chat", OriginPolicy.apiPath("/api/chat"));
        for (String path : new String[]{"https://evil.example/api/chat", "//evil.example", "/api/login", "/api/%2e%2e/secret", "/api/../secret", "/api/chat\r\nsecret"}) { try { OriginPolicy.apiPath(path); fail(path); } catch (Exception expected) { } }
    }
    @Test public void externalLinksCannotLaunchArbitraryIntentsOrFiles() {
        assertTrue(OriginPolicy.external("https://example.com"));
        for (String url : new String[]{"javascript:alert(1)", "file:///etc/passwd", "intent://example", "https://user:pass@host/"}) assertFalse(OriginPolicy.external(url));
    }
}
