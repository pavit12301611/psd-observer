package in.observer.companion;
import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import com.journeyapps.barcodescanner.BarcodeView;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;
public final class QrActivity extends Activity {
    private BarcodeView camera;
    @Override public void onCreate(Bundle state){super.onCreate(state);FrameLayout root=new FrameLayout(this);root.setBackgroundColor(Color.BLACK);setContentView(root);
        camera=new BarcodeView(this);camera.setDecoderFactory(new DefaultDecoderFactory(java.util.Collections.singletonList(com.google.zxing.BarcodeFormat.QR_CODE)));root.addView(camera,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout overlay=new LinearLayout(this);overlay.setOrientation(LinearLayout.VERTICAL);overlay.setGravity(Gravity.TOP|Gravity.CENTER_HORIZONTAL);overlay.setPadding(24,64,24,24);TextView title=new TextView(this);title.setText("Scan the one-time QR on your PC");title.setTextColor(Color.WHITE);title.setTextSize(20);overlay.addView(title);Button cancel=new Button(this);cancel.setText("Cancel");cancel.setOnClickListener(v->finish());overlay.addView(cancel);root.addView(overlay,new FrameLayout.LayoutParams(-1,-2));
        camera.decodeSingle(new BarcodeCallback(){public void barcodeResult(BarcodeResult result){if(result!=null){setResult(RESULT_OK,new Intent().putExtra("raw",result.getText()));finish();}}public void possibleResultPoints(java.util.List<com.google.zxing.ResultPoint> points){}});
    }
    @Override protected void onResume(){super.onResume();if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)camera.resume();else requestPermissions(new String[]{Manifest.permission.CAMERA},1);}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==1&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)camera.resume();else finish();}
    @Override protected void onPause(){camera.pause();super.onPause();}
}
