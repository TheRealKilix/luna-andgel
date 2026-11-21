package com.lunaandgel.privatechat;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final long MAX_APK_BYTES = 150L * 1024L * 1024L;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url");
        String expectedHash = call.getString("sha256");
        if (!isReleaseUrl(url) || expectedHash == null || !expectedHash.matches("(?i)[0-9a-f]{64}")) {
            call.reject("L'adresse ou la signature de la mise à jour est invalide.");
            return;
        }
        EXECUTOR.execute(() -> downloadApk(call, url, expectedHash.toLowerCase(Locale.ROOT)));
    }

    @PluginMethod
    public void isDownloaded(PluginCall call) {
        String expectedHash = call.getString("sha256");
        if (expectedHash == null || !expectedHash.matches("(?i)[0-9a-f]{64}")) {
            call.reject("La signature de mise à jour est invalide.");
            return;
        }
        EXECUTOR.execute(() -> {
            File apk = downloadedApk();
            String savedHash = getContext().getSharedPreferences("app-updater", 0).getString("sha256", "");
            boolean ready = apk.isFile() && expectedHash.equalsIgnoreCase(savedHash) &&
                expectedHash.equalsIgnoreCase(hashFile(apk));
            JSObject result = new JSObject();
            result.put("ready", ready);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void installDownloadedApk(PluginCall call) {
        EXECUTOR.execute(() -> {
            File apk = downloadedApk();
            String expectedHash = getContext().getSharedPreferences("app-updater", 0).getString("sha256", "");
            if (!apk.isFile() || expectedHash.isEmpty() || !expectedHash.equalsIgnoreCase(hashFile(apk))) {
                call.reject("La mise à jour téléchargée est absente ou invalide.");
                return;
            }
            getActivity().runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent settings = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                    );
                    getActivity().startActivity(settings);
                    JSObject result = new JSObject();
                    result.put("permissionRequired", true);
                    call.resolve(result);
                    return;
                }
                try {
                    Uri apkUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        apk
                    );
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(install);
                    call.resolve();
                } catch (Exception error) {
                    call.reject("Android n’a pas pu ouvrir l’installateur.", error);
                }
            });
        });
    }

    private boolean isReleaseUrl(String value) {
        if (value == null || !value.startsWith("https://")) return false;
        try {
            URL url = new URL(value);
            return "github.com".equalsIgnoreCase(url.getHost()) &&
                url.getPath().contains("/releases/download/");
        } catch (Exception error) {
            return false;
        }
    }

    private File downloadedApk() {
        return new File(getContext().getCacheDir(), "luna-andgel-update.apk");
    }

    private void downloadApk(PluginCall call, String url, String expectedHash) {
        File apk = downloadedApk();
        File partial = new File(getContext().getCacheDir(), "luna-andgel-update.apk.part");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "LunaAndgel-Updater");
            int status = connection.getResponseCode();
            URL finalUrl = connection.getURL();
            String finalHost = finalUrl.getHost().toLowerCase(Locale.ROOT);
            if (status != HttpURLConnection.HTTP_OK ||
                !(finalHost.equals("github.com") || finalHost.endsWith(".githubusercontent.com"))) {
                throw new IllegalStateException("Téléchargement de l’APK refusé.");
            }
            long contentLength = connection.getContentLengthLong();
            if (contentLength > MAX_APK_BYTES) throw new IllegalStateException("APK trop volumineuse.");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_APK_BYTES) throw new IllegalStateException("APK trop volumineuse.");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
            }
            StringBuilder actualHash = new StringBuilder();
            for (byte value : digest.digest()) actualHash.append(String.format(Locale.ROOT, "%02x", value));
            if (!expectedHash.contentEquals(actualHash)) {
                throw new IllegalStateException("La vérification de l’APK a échoué.");
            }
            if (apk.exists() && !apk.delete()) throw new IllegalStateException("Impossible de remplacer l’ancienne mise à jour.");
            if (!partial.renameTo(apk)) throw new IllegalStateException("Impossible d’enregistrer l’APK téléchargée.");
            getContext().getSharedPreferences("app-updater", 0).edit().putString("sha256", expectedHash).apply();
            JSObject result = new JSObject();
            result.put("downloaded", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Impossible de télécharger la mise à jour.", error);
        } finally {
            partial.delete();
            if (connection != null) connection.disconnect();
        }
    }

    private String hashFile(File file) {
        if (!file.isFile()) return "";
        try (InputStream input = new java.io.FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[16384];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            StringBuilder result = new StringBuilder();
            for (byte value : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", value));
            return result.toString();
        } catch (Exception error) {
            return "";
        }
    }
}
