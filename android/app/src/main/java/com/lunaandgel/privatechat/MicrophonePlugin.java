package com.lunaandgel.privatechat;

import android.Manifest;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "Microphone",
    permissions = @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "recordAudio")
)
public class MicrophonePlugin extends Plugin {
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState("recordAudio") == PermissionState.GRANTED) {
            resolvePermission(call);
            return;
        }
        requestPermissionForAlias("recordAudio", call, "permissionResult");
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("recordAudio") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (getPermissionState("recordAudio") == PermissionState.GRANTED) {
            resolvePermission(call);
        } else {
            call.reject("L'autorisation du microphone a été refusée.");
        }
    }

    private void resolvePermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", true);
        call.resolve(result);
    }
}
