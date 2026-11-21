package com.lunaandgel.privatechat;

import android.Manifest;
import android.media.MediaRecorder;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

@CapacitorPlugin(
    name = "Microphone",
    permissions = @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "recordAudio")
)
public class MicrophonePlugin extends Plugin {
    private static final long MAX_RECORDING_BYTES = 2_800L * 1024L;
    private MediaRecorder recorder;
    private File recordingFile;

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

    @PluginMethod
    public synchronized void startRecording(PluginCall call) {
        if (getPermissionState("recordAudio") != PermissionState.GRANTED) {
            call.reject("L'autorisation du microphone n'est pas accordée.");
            return;
        }
        if (recorder != null) {
            call.reject("Un enregistrement vocal est déjà en cours.");
            return;
        }

        MediaRecorder nextRecorder = null;
        File nextFile = null;
        try {
            nextFile = File.createTempFile("luna-voice-", ".m4a", getContext().getCacheDir());
            nextRecorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? new MediaRecorder(getContext())
                : new MediaRecorder();
            nextRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            nextRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            nextRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            nextRecorder.setAudioEncodingBitRate(32000);
            nextRecorder.setAudioSamplingRate(22050);
            nextRecorder.setOutputFile(nextFile.getAbsolutePath());
            nextRecorder.prepare();
            nextRecorder.start();
            recorder = nextRecorder;
            recordingFile = nextFile;
            JSObject result = new JSObject();
            result.put("recording", true);
            call.resolve(result);
        } catch (Exception error) {
            if (nextRecorder != null) nextRecorder.release();
            if (nextFile != null) nextFile.delete();
            call.reject("Impossible de démarrer l'enregistrement vocal : " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public synchronized void stopRecording(PluginCall call) {
        MediaRecorder currentRecorder = recorder;
        File currentFile = recordingFile;
        recorder = null;
        recordingFile = null;
        if (currentRecorder == null || currentFile == null) {
            call.reject("Aucun enregistrement vocal n'est en cours.");
            return;
        }

        try {
            currentRecorder.stop();
            currentRecorder.release();
            currentRecorder = null;
            long fileSize = currentFile.length();
            if (fileSize <= 0 || fileSize > MAX_RECORDING_BYTES) {
                throw new IOException(fileSize <= 0 ? "Le vocal est vide." : "Le vocal dépasse la limite autorisée.");
            }
            byte[] audio = new byte[(int) fileSize];
            try (FileInputStream input = new FileInputStream(currentFile)) {
                int offset = 0;
                while (offset < audio.length) {
                    int count = input.read(audio, offset, audio.length - offset);
                    if (count < 0) throw new IOException("Le fichier vocal est incomplet.");
                    offset += count;
                }
            }
            JSObject result = new JSObject();
            result.put("dataUrl", "data:audio/mp4;base64," + Base64.encodeToString(audio, Base64.NO_WRAP));
            result.put("mimeType", "audio/mp4");
            result.put("size", audio.length);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Impossible de récupérer le vocal : " + error.getMessage(), error);
        } finally {
            if (currentRecorder != null) currentRecorder.release();
            currentFile.delete();
        }
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
