package in.observer.companion;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;
import android.widget.Toast;
/**
 * The tile runs the owner's configured read-only command without opening the
 * app. Tapping a tile is a user action on the app's own UI, which is what
 * allows the foreground service to start from here at all.
 */
public final class ObserverTile extends TileService {
 @Override public void onClick(){
  super.onClick();
  if(!paired(this)){Toast.makeText(this,"Pair your PC first.",Toast.LENGTH_LONG).show();openChat(this);return;}
  try{startForegroundService(new Intent(this,QuickActionService.class));openChat(this);}
  catch(Exception e){Toast.makeText(this,"Could not start that quick action.",Toast.LENGTH_LONG).show();}
 }
 /** Collapse the shade and land the owner on the chat page, whatever the API level. */
 private void openChat(Context c){
  Intent open=new Intent(c,MainActivity.class).putExtra("observerPage","chat").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
  try{if(Build.VERSION.SDK_INT>=34)startActivityAndCollapse(PendingIntent.getActivity(c,31,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT));else legacyLaunch(open);}catch(Exception ignored){}
 }
 @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
 private void legacyLaunch(Intent intent){if(Build.VERSION.SDK_INT<34)startActivityAndCollapse(intent);}
 private static boolean paired(Context c){try{return new SecureVault(c).get("profile")!=null;}catch(Exception e){return false;}}
}
