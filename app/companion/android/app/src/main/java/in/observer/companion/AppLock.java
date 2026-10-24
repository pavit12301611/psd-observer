package in.observer.companion;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Foreground app-access gate. Background alerts do not get PC-action authority. */
final class AppLock {
    static final int CONFIRM_DEVICE = 2201;
    private final Activity activity; private final SecureVault vault; private final FrameLayout root; private final View content;
    private View overlay; private boolean enabled, locked, authenticating; private Runnable success; private Runnable failure; private final Runnable unlockedListener;
    AppLock(Activity activity, SecureVault vault, FrameLayout root, View content, Runnable unlockedListener) {
        this.activity=activity;this.vault=vault;this.root=root;this.content=content;this.unlockedListener=unlockedListener;
        try {enabled="true".equals(vault.get("appLock"));}catch(Exception e){enabled=true;}
        locked=enabled;if(locked)show();
    }
    boolean isLocked(){return locked;}
    boolean isEnabled(){return enabled;}
    void lock(){if(enabled&&!authenticating){locked=true;show();}}
    void show(){
        content.setVisibility(View.INVISIBLE); if(overlay!=null)return;
        LinearLayout box=new LinearLayout(activity);box.setOrientation(LinearLayout.VERTICAL);box.setGravity(Gravity.CENTER);box.setPadding(32,32,32,32);box.setBackgroundColor(Color.BLACK);
        TextView title=new TextView(activity);title.setText("Your space stays private.");title.setTextColor(Color.WHITE);title.setTextSize(25);title.setGravity(Gravity.CENTER);box.addView(title);
        TextView copy=new TextView(activity);copy.setText("Unlock Observer with your phone's biometric or device credential.");copy.setTextSize(14);copy.setTextColor(Color.LTGRAY);copy.setGravity(Gravity.CENTER);copy.setPadding(0,24,0,24);box.addView(copy);
        Button unlock=new Button(activity);unlock.setText("Unlock Observer");unlock.setOnClickListener(v->authenticate(this::unlocked,()->{}));box.addView(unlock);overlay=box;root.addView(box,new FrameLayout.LayoutParams(-1,-1));
    }
    private void unlocked(){boolean changed=locked;locked=false;if(overlay!=null){root.removeView(overlay);overlay=null;}content.setVisibility(View.VISIBLE);if(changed)unlockedListener.run();}
    void change(boolean value,Runnable ok,Runnable fail){
        KeyguardManager manager=(KeyguardManager)activity.getSystemService(Context.KEYGUARD_SERVICE);
        if(!manager.isDeviceSecure()){fail.run();return;}
        authenticate(()->{try{vault.put("appLock",String.valueOf(value));enabled=value;unlocked();ok.run();}catch(Exception e){fail.run();}},fail);
    }
    void authenticate(Runnable ok,Runnable fail){
        if(authenticating)return;authenticating=true;success=ok;failure=fail;
        KeyguardManager km=(KeyguardManager)activity.getSystemService(Context.KEYGUARD_SERVICE);
        if(!km.isDeviceSecure()){finish(false);return;}
        if(Build.VERSION.SDK_INT>=30){
            BiometricManager bm=(BiometricManager)activity.getSystemService(Context.BIOMETRIC_SERVICE);
            int methods=BiometricManager.Authenticators.BIOMETRIC_STRONG|BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            if(bm!=null&&bm.canAuthenticate(methods)==BiometricManager.BIOMETRIC_SUCCESS){
                new BiometricPrompt.Builder(activity).setTitle("Unlock Observer").setSubtitle("Confirm access to your PC companion").setAllowedAuthenticators(methods).build().authenticate(new CancellationSignal(),activity.getMainExecutor(),new BiometricPrompt.AuthenticationCallback(){
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result){finish(true);}
                    @Override public void onAuthenticationError(int code,CharSequence text){finish(false);}
                });return;
            }
        }
        Intent intent=km.createConfirmDeviceCredentialIntent("Unlock Observer","Use your device credential. Observer never receives it.");
        if(intent==null){finish(false);return;}activity.startActivityForResult(intent,CONFIRM_DEVICE);
    }
    boolean result(int request,int result){if(request!=CONFIRM_DEVICE)return false;finish(result==Activity.RESULT_OK);return true;}
    private void finish(boolean ok){authenticating=false;Runnable callback=ok?success:failure;success=null;failure=null;if(ok)unlocked();if(callback!=null)callback.run();}
}
