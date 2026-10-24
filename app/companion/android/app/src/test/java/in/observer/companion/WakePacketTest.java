package in.observer.companion;
import org.junit.Test;
import static org.junit.Assert.*;
public final class WakePacketTest {
 @Test public void magicPacketIsExactlySixFFThenSixteenMacCopies()throws Exception{byte[] p=WakePacket.build("01:23:45:67:89:AB");assertEquals(102,p.length);for(int n=0;n<6;n++)assertEquals((byte)0xff,p[n]);for(int n=0;n<16;n++){assertEquals((byte)1,p[6+n*6]);assertEquals((byte)0xab,p[11+n*6]);}}
 @Test public void invalidMacAndPublicTargetsAreRejected(){for(String m:new String[]{"bad","00:00","0G:12:34:56:78:90"}){try{WakePacket.build(m);fail();}catch(Exception expected){}}assertFalse(WakePacket.broadcastAllowed("8.8.8.8"));assertTrue(WakePacket.broadcastAllowed("192.168.1.255"));assertTrue(WakePacket.broadcastAllowed("255.255.255.255"));}
}
