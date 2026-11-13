package app.netlify.todoenunoapp;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import kotlin.Unit;

/**
 * Video and audio downloads with yt-dlp, which youtubedl-android runs on the phone together with Python
 * and FFmpeg. Same options as the Windows app (server/downloader.js). Files go to Download/TodoEnUno.
 */
@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private static final Set<String> HEIGHTS = Set.of("2160", "1440", "1080", "720", "480", "360");
    private static final String FOLDER = "TodoEnUno";

    // One download at a time: yt-dlp and FFmpeg already use the whole connection and processor.
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private boolean ready = false;
    private boolean updated = false;

    private void prepare() throws Exception {
        if (!ready) {
            YoutubeDL.getInstance().init(getContext());
            FFmpeg.getInstance().init(getContext());
            ready = true;
        }
        // Video sites change often and an old yt-dlp stops working, so it is updated once per start.
        // Without a connection the download fails anyway; an update error is not worth reporting.
        if (!updated) {
            try {
                YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel._STABLE);
            } catch (Exception ignored) {
            }
            updated = true;
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String kind = "audio".equals(call.getString("kind")) ? "audio" : "video";
        String quality = call.getString("quality", "");
        // http(s) only: keeps yt-dlp away from files on the phone and other schemes.
        Uri parsed = Uri.parse(url);
        if (!"http".equals(parsed.getScheme()) && !"https".equals(parsed.getScheme())) {
            call.reject("Solo se admiten URL http o https.");
            return;
        }
        worker.execute(() -> {
            File dir = new File(getContext().getCacheDir(), "descargas/" + System.nanoTime());
            try {
                prepare();
                if (!dir.mkdirs()) throw new Exception("No se pudo preparar la descarga.");
                YoutubeDLRequest request = new YoutubeDLRequest(url);
                request.addOption("--no-playlist");
                request.addOption("--no-warnings");
                request.addOption("--restrict-filenames");
                request.addOption("-o", new File(dir, "%(title).100B.%(ext)s").getAbsolutePath());
                if (kind.equals("audio")) {
                    request.addOption("-x");
                    request.addOption("--audio-format", "mp3");
                    request.addOption("--audio-quality", "0");
                } else {
                    String limit = HEIGHTS.contains(quality) ? "[height<=" + quality + "]" : "";
                    request.addOption("-f", "bv*" + limit + "+ba/b" + limit + "/b");
                    request.addOption("--merge-output-format", "mp4");
                }
                YoutubeDL.getInstance().execute(request, null, (progress, eta, line) -> {
                    JSObject event = new JSObject();
                    event.put("progress", progress / 100.0);
                    notifyListeners("progress", event);
                    return Unit.INSTANCE;
                });
                File[] files = dir.listFiles();
                if (files == null || files.length == 0) throw new Exception("yt-dlp no produjo ningún archivo.");
                // The biggest file is the result; anything else is a leftover of the merge.
                File result = Arrays.stream(files).max((a, b) -> Long.compare(a.length(), b.length())).get();
                JSObject answer = new JSObject();
                answer.put("name", result.getName());
                answer.put("location", save(result));
                call.resolve(answer);
            } catch (Exception error) {
                String message = error.getMessage() == null ? error.toString() : error.getMessage();
                String[] lines = message.trim().split("\n");
                call.reject("No se pudo descargar: " + lines[lines.length - 1]);
            } finally {
                deleteAll(dir);
            }
        });
    }

    /** Copies the file to Download/TodoEnUno and returns where it is, as the user sees it. */
    private String save(File file) throws Exception {
        String extension = file.getName().substring(file.getName().lastIndexOf('.') + 1);
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, file.getName());
            values.put(MediaStore.Downloads.MIME_TYPE, type == null ? "application/octet-stream" : type);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("No se pudo guardar en Descargas.");
            try (InputStream in = new FileInputStream(file); OutputStream out = resolver.openOutputStream(uri)) {
                copy(in, out);
            }
            return Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + "/" + file.getName();
        }
        // Android 9 and older: the app's own folder, which needs no storage permission.
        File folder = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), FOLDER);
        if (!folder.exists() && !folder.mkdirs()) throw new Exception("No se pudo guardar el archivo.");
        File target = new File(folder, file.getName());
        try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(target)) {
            copy(in, out);
        }
        return target.getAbsolutePath();
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buffer = new byte[1 << 16];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
    }

    private static void deleteAll(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteAll(child);
        file.delete();
    }
}
