package in.observer.companion;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/** Explicit opt-in SSE link, not periodic task polling. Doze/OEM limits apply. */
public final class AlertService extends Service {
    private volatile boolean running; private volatile HttpURLConnection connection;private Thread worker;
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&"STOP".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}
        if(Build.VERSION.SDK_INT>=34)startForeground(1,NotificationHub.connection(this,"Listening for PC events; Android may pause this link in Doze."),ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(1,NotificationHub.connection(this,"Listening for PC events; Android may pause this link in Doze."));
        if(!running){running=true;worker=new Thread(this::listen,"observer-private-alerts");worker.start();}return START_STICKY;
    }
    private void listen(){long backoff=3000;while(running){
        HttpURLConnection c=null;
        try{
            String raw=new SecureVault(this).get("profile");if(raw==null)break;JSONObject profile=new JSONObject(raw);String serverId=profile.optString("serverId");
            String base=OriginPolicy.base(profile.getString("baseUrl"),profile.optBoolean("allowLan"));String token=profile.getString("token");
            // Cursor is private metadata; start with no historical notification spam.
            android.content.SharedPreferences prefs=getSharedPreferences("observer-sse-state",MODE_PRIVATE);String epoch=prefs.getString(serverId+":epoch","");long cursor=prefs.getLong(serverId+":cursor",0);
            c=NativeHttp.connection(base+"/api/app/events/stream?after="+cursor,"GET",token);connection=c;c.setReadTimeout(45000);
            int status=c.getResponseCode();if(status==401){stopSelf();break;}if(status!=200)throw new Exception("Event stream unavailable");
            backoff=3000;String eventType="message";
            try(BufferedReader reader=new BufferedReader(new InputStreamReader(c.getInputStream(),StandardCharsets.UTF_8))){String line;while(running&&(line=reader.readLine())!=null){
                if(line.length()>12000)throw new Exception("Oversized event");
                if(line.startsWith("event:"))eventType=line.substring(6).trim();
                if(!line.startsWith("data:"))continue;JSONObject data=new JSONObject(line.substring(5).trim());
                if("ready".equals(eventType)){
                    String next=data.optString("epoch");long latest=data.optLong("latest");if(epoch.isEmpty()||!epoch.equals(next)){epoch=next;cursor=latest;prefs.edit().putString(serverId+":epoch",epoch).putLong(serverId+":cursor",cursor).apply();}eventType="message";continue;
                }
                long id=data.optLong("id");if(id<=cursor)continue;cursor=id;prefs.edit().putLong(serverId+":cursor",cursor).apply();
                NotificationHub.event(this,serverId,data.optString("epoch",epoch),id,data.optString("type"),data.optString("approvalId",null));
            }}
        }catch(Exception ignored){/* Never log credentials/private event text. */}
        finally{if(c!=null)c.disconnect();connection=null;}
        if(running)try{Thread.sleep(backoff);backoff=Math.min(60000,backoff*2);}catch(InterruptedException e){break;}
    }running=false;stopSelf();}
    @Override public void onDestroy(){running=false;if(connection!=null)connection.disconnect();if(worker!=null)worker.interrupt();stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
