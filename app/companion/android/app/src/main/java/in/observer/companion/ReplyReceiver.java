package in.observer.companion;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/**
 * The "Reply" action on a result or reminder notification. The typed text is
 * handed to the app as a draft — it is never sent from the shade, so nothing
 * reaches the PC without the owner seeing it first. The key result is that the
 * reply survives the app being closed: the receiver starts the activity itself.
 */
public final class ReplyReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String text = NotificationHub.replyText(intent);
        if (text == null || text.trim().isEmpty()) return;
        Intent open = new Intent(context, MainActivity.class)
            .putExtra("observerPage", "chat")
            .putExtra("observerDraft", text.trim())
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(open);
        } catch (Exception e) {
            // No foreground activity allowed (rare OEM states): the draft is
            // simply not created, and the owner can open the app by hand.
            Toast.makeText(context, "Open Observer to send that reply.", Toast.LENGTH_SHORT).show();
        }
    }
}
