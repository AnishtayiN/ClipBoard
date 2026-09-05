package com.novaclip.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "ClipboardManager")
public class ClipboardManagerPlugin extends Plugin {
    public static final String ACTION_CLIP_CHANGED = "com.novaclip.app.CLIP_CHANGED";

    private ClipboardManager cm;
    private String lastClip = null;
    private BroadcastReceiver receiver;

    @Override
    public void load() {
        try {
            cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String text = intent.getStringExtra("text");
                    if (text != null && !text.equals(lastClip)) {
                        lastClip = text;
                        JSObject ret = new JSObject();
                        ret.put("value", text);
                        notifyListeners("clipboardChanged", ret);
                    }
                }
            };
            ContextCompat.registerReceiver(getContext(), receiver,
                new IntentFilter(ACTION_CLIP_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED);
        } catch (Exception e) {
            // ignore
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                if (ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS")
                        != PackageManager.PERMISSION_GRANTED && getActivity() != null) {
                    getActivity().requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1001);
                }
            }
            Intent intent = new Intent(getContext(), ClipboardMonitorService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception e) {
            // ignore
        }
        call.resolve();
    }

    @PluginMethod
    public void read(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            if (cm != null && cm.hasPrimaryClip()) {
                ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
                if (item != null && item.getText() != null) {
                    ret.put("value", item.getText().toString());
                }
            }
        } catch (Exception e) {
            // ignore
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String value = call.getString("value", "");
        try {
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("novaclip", value));
            }
        } catch (Exception e) {
            // ignore
        }
        lastClip = value;
        call.resolve();
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "NovaClip");
        String body = call.getString("body", "");
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            String channelId = "novaclip_notes";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(channelId, "NovaClip", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(ch);
            }
            Notification n = new NotificationCompat.Builder(getContext(), channelId)
                .setSmallIcon(getContext().getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .build();
            nm.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), n);
        } catch (Exception e) {
            // ignore
        }
        call.resolve();
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "novaclip-history.json");
        String content = call.getString("content", "");
        String path = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = getContext().getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    try (OutputStream os = resolver.openOutputStream(uri)) {
                        os.write(content.getBytes("UTF-8"));
                    }
                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(uri, values, null, null);
                    path = uri.toString();
                }
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File f = new File(dir, name);
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write(content.getBytes("UTF-8"));
                }
                path = f.getAbsolutePath();
            }
        } catch (Exception e) {
            // ignore
        }
        JSObject ret = new JSObject();
        if (path != null) {
            ret.put("path", path);
            call.resolve(ret);
        } else {
            call.reject("save failed");
        }
    }
}
