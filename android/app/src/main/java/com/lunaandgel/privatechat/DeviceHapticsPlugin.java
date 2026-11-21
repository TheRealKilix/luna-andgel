package com.lunaandgel.privatechat;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

@CapacitorPlugin(name = "DeviceHaptics")
public class DeviceHapticsPlugin extends Plugin {
    @PluginMethod
    public void vibrate(PluginCall call) {
        Vibrator vibrator;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vibrator = manager == null
                ? (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE)
                : manager.getDefaultVibrator();
        } else {
            vibrator = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (vibrator == null || !vibrator.hasVibrator()) {
            call.reject("Ce téléphone ne possède pas de moteur de vibration.");
            return;
        }

        JSArray values = call.getArray("pattern");
        if (values == null || values.length() == 0) {
            call.reject("Motif de vibration vide.");
            return;
        }

        long[] pattern = new long[values.length() + 1];
        try {
            for (int i = 0; i < values.length(); i++) {
                pattern[i + 1] = Math.max(0, Math.min(800, values.getLong(i)));
            }
        } catch (JSONException error) {
            call.reject("Motif de vibration invalide : " + error.getMessage());
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
            } else {
                vibrator.vibrate(pattern, -1);
            }
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Android n’a pas pu déclencher la vibration : " + error.getMessage());
        }
    }
}
