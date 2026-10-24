package in.observer.companion;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;
public final class ObserverMessagingService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage message){java.util.Map<String,String> data=message.getData();try{NotificationHub.event(this,data.getOrDefault("serverId",""),data.getOrDefault("epoch",""),Long.parseLong(data.getOrDefault("id","0")),data.getOrDefault("type","agent_notice"));}catch(Exception ignored){}}
    @Override public void onNewToken(String token){new Thread(()->{try{SecureVault v=new SecureVault(this);v.put("fcmToken",token);String raw=v.get("profile");if(raw==null)return;JSONObject p=new JSONObject(raw);NativeHttp.request(OriginPolicy.base(p.getString("baseUrl"),p.optBoolean("allowLan"))+"/api/app/devices/push","POST",p.getString("token"),new JSONObject().put("token",token),false,null);}catch(Exception ignored){}},"observer-push-registration").start();}
}
