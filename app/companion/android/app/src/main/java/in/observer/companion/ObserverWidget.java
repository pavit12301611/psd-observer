package in.observer.companion;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
public final class ObserverWidget extends AppWidgetProvider {
 @Override public void onUpdate(Context c,AppWidgetManager m,int[] ids){for(int id:ids){RemoteViews v=new RemoteViews(c.getPackageName(),R.layout.observer_widget);String[] pages={"chat","pc","voice"};int[] targets={R.id.widget_chat,R.id.widget_pc,R.id.widget_voice};for(int n=0;n<pages.length;n++){Intent i=new Intent(c,MainActivity.class).putExtra("observerPage",pages[n]).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);v.setOnClickPendingIntent(targets[n],PendingIntent.getActivity(c,id*10+n,i,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT));}m.updateAppWidget(id,v);}}
}
