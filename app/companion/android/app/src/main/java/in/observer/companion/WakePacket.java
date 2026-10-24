package in.observer.companion;
public final class WakePacket {
    private WakePacket() {}
    public static byte[] build(String mac) throws Exception {
        if (mac == null || !mac.matches("(?i)^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$")) throw new Exception("Enter a valid six-byte PC network-card MAC address.");
        String[] fields = mac.split("[:-]"); byte[] out = new byte[102];
        for (int n=0;n<6;n++) out[n]=(byte)0xff;
        for(int repeat=0;repeat<16;repeat++) for(int n=0;n<6;n++) out[6+repeat*6+n]=(byte)Integer.parseInt(fields[n],16);
        return out;
    }
    public static boolean broadcastAllowed(String host) { return "255.255.255.255".equals(host) || OriginPolicy.privateHost(host) && host.endsWith(".255"); }
}
