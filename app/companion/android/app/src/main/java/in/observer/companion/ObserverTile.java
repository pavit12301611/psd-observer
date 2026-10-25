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
  Context c=this;
  if(!paired(c)){Toast.makeText(c,"Pair your PC first.",Toast.LENGTH_LONG).show();openApp(c);return;}
  try{c.startForegroundService(new Intent(c,QuickActionService.class));collapse(c);}
  catch(Exception e){Toast.makeText(c,"Could not start that quick action.",Toast.LENGTH_LONG).show();}
 }
 private void collapse(Context c){
  Intent open=new Intent(c,MainActivity.class).putExtra("observerPage","chat").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
  try{if(Build.VERSION.SDK_INT>=34)startActivityAndCollapse(PendingIntent.getActivity(c,31,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT));else startActivityAndCollapse(open);}catch(Exception ignored){}
 }
 private void openApp(Context c){
  Intent open=new Intent(c,MainActivity.class).putExtra("observerPage","chat").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
  try{if(Build.VERSION.SDK_INT>=34)startActivityAndCollapse(PendingIntent.getActivity(c,32,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT));else startActivityAndCollapse(open);}catch(Exception ignored){}
 }
 private static boolean paired(Context c){try{return new SecureVault(c).get("profile")!=null;}catch(Exception e){return false;}}
}
