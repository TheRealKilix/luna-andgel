package com.lunaandgel.privatechat;

import android.Manifest;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;

@CapacitorPlugin(
    name = "DeviceLocation",
    permissions = @Permission(strings = { Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location")
)
public class DeviceLocationPlugin extends Plugin {
    private static final long MAX_CACHE_AGE_MS = 5 * 60 * 1000L;
    private static final long LOCATION_TIMEOUT_MS = 20000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void getCurrentPosition(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            findPosition(call);
            return;
        }
        requestPermissionForAlias("location", call, "locationPermissionResult");
    }

    @PermissionCallback
    private void locationPermissionResult(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            findPosition(call);
        } else {
            call.reject("Permission de localisation refusée dans les réglages Android.");
        }
    }

    private void findPosition(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (manager == null) {
                call.reject("Service de localisation Android indisponible.");
                return;
            }

            List<String> providers;
            try {
                providers = manager.getProviders(true);
            } catch (SecurityException error) {
                call.reject("Permission de localisation refusée dans les réglages Android.");
                return;
            }

            Location cached = null;
            long now = System.currentTimeMillis();
            for (String provider : providers) {
                try {
                    Location candidate = manager.getLastKnownLocation(provider);
                    if (candidate != null && now - candidate.getTime() >= 0 &&
                        now - candidate.getTime() <= MAX_CACHE_AGE_MS &&
                        (cached == null || candidate.getTime() > cached.getTime())) {
                        cached = candidate;
                    }
                } catch (SecurityException ignored) {
                    // A provider can require fine location while only approximate access is granted.
                }
            }
            if (cached != null) {
                resolvePosition(call, cached);
                return;
            }

            String provider = providers.contains(LocationManager.NETWORK_PROVIDER)
                ? LocationManager.NETWORK_PROVIDER
                : providers.contains(LocationManager.PASSIVE_PROVIDER) ? LocationManager.PASSIVE_PROVIDER : null;
            if (provider == null) {
                call.reject("Active la localisation Android pour obtenir une position approximative.");
                return;
            }

            LocationListener[] listenerRef = new LocationListener[1];
            Runnable timeout = () -> {
                if (listenerRef[0] != null) manager.removeUpdates(listenerRef[0]);
                call.reject("Position introuvable. Vérifie que la localisation Android est activée.");
            };
            LocationListener listener = new LocationListener() {
                @Override
                public void onLocationChanged(Location location) {
                    mainHandler.removeCallbacks(timeout);
                    manager.removeUpdates(this);
                    resolvePosition(call, location);
                }

                @Override
                public void onStatusChanged(String provider, int status, Bundle extras) {}

                @Override
                public void onProviderEnabled(String provider) {}

                @Override
                public void onProviderDisabled(String provider) {}
            };
            listenerRef[0] = listener;

            try {
                manager.requestLocationUpdates(provider, 0, 0, listener, Looper.getMainLooper());
                mainHandler.postDelayed(timeout, LOCATION_TIMEOUT_MS);
            } catch (SecurityException error) {
                call.reject("Permission de localisation refusée dans les réglages Android.");
            } catch (RuntimeException error) {
                call.reject("Impossible de démarrer la localisation Android : " + error.getMessage());
            }
        });
    }

    private void resolvePosition(PluginCall call, Location location) {
        JSObject coords = new JSObject();
        coords.put("latitude", location.getLatitude());
        coords.put("longitude", location.getLongitude());
        coords.put("accuracy", location.getAccuracy());
        JSObject result = new JSObject();
        result.put("coords", coords);
        call.resolve(result);
    }
}
