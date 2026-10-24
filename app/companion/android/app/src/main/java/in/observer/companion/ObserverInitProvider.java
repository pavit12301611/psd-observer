package in.observer.companion;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
public final class ObserverInitProvider extends ContentProvider {
 @Override public boolean onCreate(){try{String raw=new SecureVault(getContext()).get("fcmConfig");if(raw!=null&&FirebaseApp.getApps(getContext()).isEmpty()){JSONObject p=new JSONObject(raw);FirebaseApp.initializeApp(getContext(),new FirebaseOptions.Builder().setApplicationId(p.getString("appId")).setProjectId(p.getString("projectId")).setGcmSenderId(p.getString("senderId")).setApiKey(p.getString("apiKey")).build());FirebaseMessaging.getInstance().setAutoInitEnabled(true);}}catch(Exception ignored){}return true;}
 @Override public Cursor query(Uri u,String[]p,String s,String[]a,String sort){throw new UnsupportedOperationException();}@Override public String getType(Uri u){return null;}@Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}@Override public int delete(Uri u,String s,String[]a){throw new UnsupportedOperationException();}@Override public int update(Uri u,ContentValues v,String s,String[]a){throw new UnsupportedOperationException();}
}
