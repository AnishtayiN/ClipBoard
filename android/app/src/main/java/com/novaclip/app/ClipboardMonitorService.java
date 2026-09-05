package com.novaclip.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;

public class ClipboardMonitorService extends Service {
    private static final int NOTIF_ID = 1;
    private final Handler handler = new Handler();
    private ClipboardManager cm;
    private String last = null;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            String text = readClip();
            if (text != null && !text.equals(last)) {
                last = text;
                Intent i = new Intent(ClipboardManagerPlugin.ACTION_CLIP_CHANGED);
                i.putExtra("text", text);
                sendBroadcast(i);
            }
            handler.postDelayed(this, 1000);
        }
    };

    private String readClip() {
        try {
            if (cm != null && cm.hasPrimaryClip()) {
                ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
                if (item != null && item.getText() != null) {
                    return item.getText().toString();
                }
            }
        } catch (Exception e) {
            // clipboard read restricted in background (Android 10+)
        }
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        startForegroundCompat();
    }

    private void startForegroundCompat() {
        String chId = "novaclip_monitor";
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(chId, "NovaClip", NotificationManager.IMPORTANCE_MIN);
            nm.createNotificationChannel(ch);
        }
        Notification n;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            n = new Notification.Builder(this, chId)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("NovaClip")
                .setContentText("Clipboard monitor active")
                .setOngoing(true)
                .build();
        } else {
            n = new Notification.Builder(this)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("NovaClip")
                .setContentText("Clipboard monitor active")
                .setOngoing(true)
                .build();
        }
        try {
            startForeground(NOTIF_ID, n);
        } catch (Exception e) {
            // ignore
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(poll);
        handler.post(poll);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(poll);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
