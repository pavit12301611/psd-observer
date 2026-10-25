package in.observer.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import org.json.JSONObject;
final class NotificationHub {
    static final String UPDATES="observer-updates", CONNECTION="observer-connection";
    /** Key for the inline "Reply" box on a result/reminder notification. */
    static final String REPLY_KEY="observer_reply";
    static void channels(Context c){NotificationManager n=c.getSystemService(NotificationManager.class);n.createNotificationChannel(new NotificationChannel(UPDATES,"Agent updates",NotificationManager.IMPORTANCE_DEFAULT));n.createNotificationChannel(new NotificationChannel(CONNECTION,"Private PC connection",NotificationManager.IMPORTANCE_LOW));}
    static Notification connection(Context c,String text){channels(c);Intent stop=new Intent(c,AlertService.class).setAction("STOP");PendingIntent action=PendingIntent.getService(c,4,stop,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);return new Notification.Builder(c,CONNECTION).setSmallIcon(in.observer.companion.R.drawable.observer_icon).setContentTitle("Observer · private PC link").setContentText(text).setOngoing(true).setVisibility(Notification.VISIBILITY_PRIVATE).addAction(new Notification.Action.Builder(null,"Disconnect alerts",action).build()).build();}
    static synchronized void event(Context c,String serverId,String epoch,long id,String type){
        event(c,serverId,epoch,id,type,null);
    }
    /**
     * A PC event as a local notification. Nothing private is written into the
     * shade: the notification only says that something happened, and every
     * action lands in the app, which is the only place a request can be sent.
     * `approvalId` is the exact request the PC is waiting on, so Approve and
     * Decline act on that request and not on whatever is pending later.
     */
    static synchronized void event(Context c,String serverId,String epoch,long id,String type,String approvalId){
        try{String raw=new SecureVault(c).get("profile");if(raw==null||!serverId.equals(new JSONObject(raw).optString("serverId")))return;}catch(Exception e){return;}
        if(!java.util.Arrays.asList("job_result","job_unknown","approval","reminder","watch","agent_notice").contains(type))return;
        SharedPreferences p=c.getSharedPreferences("observer-alert-cursors",Context.MODE_PRIVATE);String key=serverId+":"+epoch;
        if(id<=p.getLong(key,0))return;p.edit().putLong(key,id).apply();
        channels(c);
        boolean approval="approval".equals(type);
        Intent open=new Intent(c,MainActivity.class).putExtra("observerPage",approval?"tasks":"tasks").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if(approval&&approvalId!=null)open.putExtra("observerApproval",approvalId);
        PendingIntent intent=PendingIntent.getActivity(c,10,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        String title=approval?"PC action needs your review":"reminder".equals(type)?"Your agent has a reminder":"job_result".equals(type)?"Your agent has a result":"Observer update";
        Notification.Builder n=new Notification.Builder(c,UPDATES).setSmallIcon(in.observer.companion.R.drawable.observer_icon).setContentTitle(title).setContentText("Open Observer to securely retrieve details. Nothing was approved automatically.").setContentIntent(intent).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE);
        if(approval&&approvalId!=null){
            // Both actions only open the app on that exact request; the PC
            // re-checks the id and refuses anything stale or already resolved.
            for(int decision=1;decision>=0;decision--){
                Intent act=new Intent(c,MainActivity.class).putExtra("observerPage","tasks").putExtra("observerApproval",approvalId).putExtra("observerDecision",decision==1).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi=PendingIntent.getActivity(c,20+decision,act,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
                n.addAction(new Notification.Action.Builder(null,decision==1?"Approve":"Decline",pi).build());
            }
        }else{
            // Inline reply: the text is handed to the app as a draft, so the
            // owner still sees it and sends it. Nothing is transmitted by the
            // shade itself, and the PC's own gates are unchanged.
            Intent reply=new Intent(c,ReplyReceiver.class).putExtra("observerApproval","").setPackage(c.getPackageName());
            PendingIntent rp=PendingIntent.getBroadcast(c,30,reply,PendingIntent.FLAG_MUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
            n.addAction(new Notification.Action.Builder(null,"Reply",rp).setAllowGeneratedReplies(true).addRemoteInput(new RemoteInput.Builder(REPLY_KEY).setLabel("Reply to your agent").build()).build());
        }
        Notification built=n.build();
        try{c.getSystemService(NotificationManager.class).notify((int)(id%100000)+100,built);}catch(SecurityException ignored){}
    }
    /** True when the notification action carried an inline reply. */
    static String replyText(Intent intent){
        if(intent==null)return null;
        Bundle input=RemoteInput.getResultsFromIntent(intent);
        if(input==null)return null;
        CharSequence text=input.getCharSequence(REPLY_KEY);
        return text==null?null:text.toString().substring(0,Math.min(16000,text.length()));
    }
}
