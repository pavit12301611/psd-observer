package in.observer.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import org.json.JSONObject;
final class NotificationHub {
    static final String UPDATES="observer-updates", CONNECTION="observer-connection";
    static void channels(Context c){NotificationManager n=c.getSystemService(NotificationManager.class);n.createNotificationChannel(new NotificationChannel(UPDATES,"Agent updates",NotificationManager.IMPORTANCE_DEFAULT));n.createNotificationChannel(new NotificationChannel(CONNECTION,"Private PC connection",NotificationManager.IMPORTANCE_LOW));}
    static Notification connection(Context c,String text){channels(c);Intent stop=new Intent(c,AlertService.class).setAction("STOP");PendingIntent action=PendingIntent.getService(c,4,stop,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);return new Notification.Builder(c,CONNECTION).setSmallIcon(in.observer.companion.R.drawable.observer_icon).setContentTitle("Observer · private PC link").setContentText(text).setOngoing(true).setVisibility(Notification.VISIBILITY_PRIVATE).addAction(new Notification.Action.Builder(null,"Disconnect alerts",action).build()).build();}
    static synchronized void event(Context c,String serverId,String epoch,long id,String type){
        try{String raw=new SecureVault(c).get("profile");if(raw==null||!serverId.equals(new JSONObject(raw).optString("serverId")))return;}catch(Exception e){return;}
        if(!java.util.Arrays.asList("job_result","job_unknown","approval","reminder","watch","agent_notice").contains(type))return;
        SharedPreferences p=c.getSharedPreferences("observer-alert-cursors",Context.MODE_PRIVATE);String key=serverId+":"+epoch;
        if(id<=p.getLong(key,0))return;p.edit().putLong(key,id).apply();
        channels(c);Intent open=new Intent(c,MainActivity.class).putExtra("observerPage","tasks").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent intent=PendingIntent.getActivity(c,10,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        String title="approval".equals(type)?"PC action needs your review":"reminder".equals(type)?"Your agent has a reminder":"job_result".equals(type)?"Your agent has a result":"Observer update";
        Notification n=new Notification.Builder(c,UPDATES).setSmallIcon(in.observer.companion.R.drawable.observer_icon).setContentTitle(title).setContentText("Open Observer to securely retrieve details. Nothing was approved automatically.").setContentIntent(intent).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();
        try{c.getSystemService(NotificationManager.class).notify((int)(id%100000)+100,n);}catch(SecurityException ignored){}
    }
}
