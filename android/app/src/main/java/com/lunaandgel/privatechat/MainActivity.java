package com.lunaandgel.privatechat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MicrophonePlugin.class);
        registerPlugin(DeviceHapticsPlugin.class);
        registerPlugin(DeviceLocationPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
