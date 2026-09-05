package com.novaclip.app;

import android.accessibilityservice.AccessibilityService;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

public class ClipboardAccessibilityService extends AccessibilityService {
    private ClipboardManager cm;
    private String last = null;

    @Override
    public void onServiceConnected() {
        try {
            cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        } catch (Exception e) {
            // ignore
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        try {
            if (cm != null && cm.hasPrimaryClip()) {
                ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
                if (item != null && item.getText() != null) {
                    String text = item.getText().toString();
                    if (text != null && !text.equals(last)) {
                        last = text;
                        Intent i = new Intent(ClipboardManagerPlugin.ACTION_CLIP_CHANGED);
                        i.putExtra("text", text);
                        sendBroadcast(i);
                    }
                }
            }
        } catch (Exception e) {
            // ignore
        }
    }

    @Override
    public void onInterrupt() {
    }
}
