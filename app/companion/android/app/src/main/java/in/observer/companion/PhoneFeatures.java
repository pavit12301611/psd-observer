package in.observer.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import androidx.core.content.FileProvider;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

final class PhoneFeatures {
    static final int SCAN=2101,SAVE_TEXT=2102,NOTIFICATIONS=2103;
    private final Activity a;private final SecureVault vault;private final NativeResult result;
    private String scanId,saveId;private JSONObject saving,share;
    PhoneFeatures(Activity a,SecureVault vault,NativeResult result){this.a=a;this.vault=vault;this.result=result;accept(a.getIntent());}
    void accept(Intent intent){if(intent==null)return;try{
        if(Intent.ACTION_VIEW.equals(intent.getAction())&&intent.getData()!=null&&"observer-companion".equals(intent.getData().getScheme())){share=new JSONObject().put("qr",intent.getData().toString());return;}
        String page=intent.getStringExtra("observerPage");if(page!=null&&java.util.Arrays.asList("chat","pc","tasks","voice").contains(page)){
            String draft=intent.getStringExtra("observerDraft");
            if(draft!=null)share=new JSONObject().put("page",page).put("text",draft.substring(0,Math.min(16000,draft.length()))).put("reference",false).put("source","notification");
            else share=new JSONObject().put("page",page);
            // An approval notification carries the exact id plus the decision the
            // owner tapped. The PC still re-checks it, so a stale or changed
            // request is refused there rather than executed here.
            String approval=intent.getStringExtra("observerApproval");
            if(approval!=null&&approval.matches("[a-f0-9]{64}")&&intent.hasExtra("observerDecision"))share.put("approval",new JSONObject().put("id",approval).put("decision",intent.getBooleanExtra("observerDecision",false)));
            return;}
        if(!Intent.ACTION_SEND.equals(intent.getAction()))return;
        CharSequence text=intent.getCharSequenceExtra(Intent.EXTRA_TEXT);if(text!=null){share=new JSONObject().put("text",text.toString().substring(0,Math.min(16000,text.length()))).put("reference",true);return;}
        Uri uri=intent.getParcelableExtra(Intent.EXTRA_STREAM);if(uri==null||!"content".equals(uri.getScheme()))return;
        String mime=a.getContentResolver().getType(uri),name="shared-file";
        try(android.database.Cursor c=a.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())name=c.getString(0);}
        byte[] data=NativeHttp.read(a.getContentResolver().openInputStream(uri),8*1024*1024);
        share=new JSONObject().put("file",new JSONObject().put("name",name).put("mime",mime==null?"application/octet-stream":mime).put("base64",android.util.Base64.encodeToString(data,android.util.Base64.NO_WRAP)).put("size",data.length));
    }catch(Exception e){share=null;}}
    boolean ui(String id,String method,JSONObject p){
        if(method.equals("consumeShare")){JSONObject data=share;share=null;result.send(id,data,null);return true;}
        // The tile and widget run one read-only command; the phone owns that choice.
        if(method.equals("getQuickAction")){result.send(id,new JSONObject().put("command",QuickActionService.command(a)),null);return true;}
        if(method.equals("setQuickAction")){String command=p.optString("command");boolean known=false;for(String allowed:QuickActionService.ALLOWED)known|=allowed.equals(command);if(!known){result.send(id,null,"That command is not in the quick-action list.");return true;}QuickActionService.save(a,command);result.send(id,new JSONObject().put("command",command),null);return true;}
        if(method.equals("scanQr")){if(scanId!=null){result.send(id,null,"A QR scan is already open.");return true;}scanId=id;a.startActivityForResult(new Intent(a,QrActivity.class),SCAN);return true;}
        if(method.equals("saveText")){if(saving!=null){result.send(id,null,"Finish the current save first.");return true;}String text=p.optString("text");if(text.length()>2*1024*1024){result.send(id,null,"Export is too large.");return true;}saving=p;saveId=id;Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE,p.optString("name","observer-export.json").replaceAll("[\\\\/\\r\\n]","_"));a.startActivityForResult(intent,SAVE_TEXT);return true;}
        if(method.equals("startAlerts")){
            if(Build.VERSION.SDK_INT>=33&&a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){a.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},NOTIFICATIONS);result.send(id,null,"Allow notification permission, then enable alerts again.");return true;}
            try{if(vault.get("profile")==null)throw new Exception("Pair your PC first.");a.startForegroundService(new Intent(a,AlertService.class));result.send(id,new JSONObject().put("enabled",true).put("mode","private-sse").put("note","Persistent notification required. Android Doze/OEM restrictions can pause this link."),null);}catch(Exception e){result.send(id,null,e.getMessage());}return true;
        }
        if(method.equals("stopAlerts")){a.stopService(new Intent(a,AlertService.class));result.send(id,true,null);return true;}
        if(method.equals("appSettings")){a.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+a.getPackageName())));result.send(id,true,null);return true;}
        if(method.equals("discover")){discover(id);return true;}
        if(method.equals("configurePush")){configurePush(id,p);return true;}
        return false;
    }
    void io(String id,String method,JSONObject p){try{
        if(method.equals("wake")){
            ConnectivityManager cm=(ConnectivityManager)a.getSystemService(Context.CONNECTIVITY_SERVICE);NetworkCapabilities n=cm.getNetworkCapabilities(cm.getActiveNetwork());if(n==null||!n.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))throw new Exception("Wake-on-LAN sends only on the local Wi-Fi network.");
            String address=p.optString("broadcast","255.255.255.255");if(!WakePacket.broadcastAllowed(address))throw new Exception("Use a private LAN broadcast, never a public address.");byte[] packet=WakePacket.build(p.getString("mac"));
            try(DatagramSocket socket=new DatagramSocket()){socket.setBroadcast(true);socket.send(new DatagramPacket(packet,packet.length,InetAddress.getByName(address),9));}
            vault.put("wake",p.toString());result.send(id,new JSONObject().put("sent",true).put("verifiedAwake",false).put("text","Wake packet sent. Hardware/BIOS/NIC support is required; PC power state is not verified."),null);return;
        }
        if(method.equals("wakeProfile")){String value=vault.get("wake");result.send(id,value==null?null:new JSONObject(value),null);return;}
        if(method.equals("pushStatus")){result.send(id,new JSONObject().put("configured",vault.get("fcmConfig")!=null).put("registered",vault.get("fcmToken")!=null),null);return;}
        if(method.equals("shareFile")){shareFile(id,p);return;}
        throw new Exception("Unsupported phone feature.");
    }catch(Exception e){result.send(id,null,e.getMessage());}}
    /** Send a PC file out through the phone's own share sheet. */
    private void shareFile(String id,JSONObject p){
        try{
            String raw=vault.get("profile");if(raw==null)throw new Exception("Pair your PC first.");
            JSONObject profile=new JSONObject(raw);
            String base=OriginPolicy.base(profile.getString("baseUrl"),profile.optBoolean("allowLan")),token=profile.getString("token");
            String path=p.optString("path");if(path.isEmpty())throw new Exception("Choose a file first.");
            String name=downloadName(p.optString("name",path));
            java.net.HttpURLConnection c=NativeHttp.connection(base+OriginPolicy.apiPath("/download?path="+java.net.URLEncoder.encode(path,"UTF-8")),"GET",token);
            byte[] data;
            try{int code=c.getResponseCode();if(code!=200)throw new Exception("File unavailable or expired (HTTP "+code+").");data=NativeHttp.read(c.getInputStream(),64*1024*1024);}
            finally{c.disconnect();}
            if(!data.length)throw new Exception("That file is empty.");
            java.io.File out=new java.io.File(new java.io.File(a.getCacheDir(),"shared"),name);
            out.getParentFile().mkdirs();
            try(java.io.OutputStream write=new java.io.FileOutputStream(out)){write.write(data);}
            android.net.Uri uri=androidx.core.content.FileProvider.getUriForFile(a,a.getPackageName()+".shared",out);
            Intent send=new Intent(Intent.ACTION_SEND).setType(p.optString("mime","application/octet-stream")).putExtra(Intent.EXTRA_STREAM,uri).putExtra(Intent.EXTRA_TITLE,name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK);
            a.startActivity(Intent.createChooser(send,"Share "+name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            result.send(id,new JSONObject().put("shared",true).put("name",name),null);
        }catch(Exception e){result.send(id,null,e.getMessage());}
    }
    private static String downloadName(String raw){
        String name=raw.replaceAll("[\\\\/\\r\\n]","_").trim();
        return name.isEmpty()||name.length()>120?"shared-file":name;
    }
    private void configurePush(String id,JSONObject p){try{
        String raw=vault.get("profile");if(raw==null)throw new Exception("Pair your PC first.");
        FirebaseOptions options=new FirebaseOptions.Builder().setApplicationId(p.getString("appId")).setProjectId(p.getString("projectId")).setGcmSenderId(p.getString("senderId")).setApiKey(p.getString("apiKey")).build();
        if(FirebaseApp.getApps(a).isEmpty())FirebaseApp.initializeApp(a,options);
        else if(!FirebaseApp.getInstance().getOptions().getApplicationId().equals(options.getApplicationId()))throw new Exception("Another push project is active. Restart the app before changing project.");
        vault.put("fcmConfig",p.toString());FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token->new Thread(()->{try{vault.put("fcmToken",token);JSONObject profile=new JSONObject(vault.get("profile"));JSONObject response=NativeHttp.request(OriginPolicy.base(profile.getString("baseUrl"),profile.optBoolean("allowLan"))+"/api/app/devices/push","POST",profile.getString("token"),new JSONObject().put("token",token),false,null);if(response.optInt("status")!=200)throw new Exception("Phone token is available but PC registration failed.");result.send(id,new JSONObject().put("registered",true).put("note","PC service-account credentials must also be configured. Live delivery is not verified by token registration."),null);}catch(Exception e){result.send(id,null,e.getMessage());}},"observer-push-setup").start()).addOnFailureListener(e->result.send(id,null,"Push registration unavailable. Check project configuration, Play services and network."));
    }catch(Exception e){result.send(id,null,e.getMessage());}}
    private void discover(String id){
        NsdManager manager=(NsdManager)a.getSystemService(Context.NSD_SERVICE);JSONArray found=new JSONArray();java.util.Set<String> seen=new java.util.HashSet<>();
        NsdManager.DiscoveryListener listener=new NsdManager.DiscoveryListener(){
            public void onDiscoveryStarted(String type){} public void onDiscoveryStopped(String type){} public void onServiceLost(NsdServiceInfo info){}
            public void onStartDiscoveryFailed(String type,int code){result.send(id,null,"Local discovery unavailable ("+code+"). Use QR/manual pairing.");}public void onStopDiscoveryFailed(String type,int code){}
            public void onServiceFound(NsdServiceInfo info){if(!info.getServiceType().contains("_observer._tcp"))return;manager.resolveService(info,new NsdManager.ResolveListener(){public void onResolveFailed(NsdServiceInfo i,int e){}public void onServiceResolved(NsdServiceInfo i){try{String host=i.getHost().getHostAddress();if(host!=null&&OriginPolicy.privateHost(host)){String origin="http://"+(host.contains(":")?"["+host+"]":host)+":"+i.getPort();synchronized(found){if(seen.add(origin))found.put(new JSONObject().put("name",i.getServiceName()).put("origin",origin));}}}catch(Exception ignored){}}});}
        };
        try{manager.discoverServices("_observer._tcp.",NsdManager.PROTOCOL_DNS_SD,listener);new android.os.Handler(a.getMainLooper()).postDelayed(()->{try{manager.stopServiceDiscovery(listener);}catch(Exception ignored){}result.send(id,found,null);},6000);}catch(Exception e){result.send(id,null,"Discovery requires an allowed local network. Use manual/QR pairing.");}
    }
    boolean result(int request,int code,Intent data){
        if(request==SCAN){String id=scanId;scanId=null;if(id!=null)try{if(code!=Activity.RESULT_OK||data==null)throw new Exception("QR scan cancelled.");result.send(id,new JSONObject().put("raw",data.getStringExtra("raw")),null);}catch(Exception e){result.send(id,null,e.getMessage());}return true;}
        if(request==SAVE_TEXT){String id=saveId;JSONObject p=saving;saveId=null;saving=null;try{if(code!=Activity.RESULT_OK||data==null||data.getData()==null)throw new Exception("Save cancelled.");try(java.io.OutputStream out=a.getContentResolver().openOutputStream(data.getData(),"w")){if(out==null)throw new Exception("Destination unavailable.");out.write(p.getString("text").getBytes(StandardCharsets.UTF_8));}result.send(id,true,null);}catch(Exception e){result.send(id,null,e.getMessage());}return true;}
        return false;
    }
}
