package app.netlify.todoenunoapp;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Optional models, downloaded the first time a tool needs them from the project's "componentes"
 * release (GitHub does not let the page fetch them itself) and checked against a fixed SHA-256, like
 * the Windows app does (electron/components.js). They are kept in the app's own storage.
 */
@CapacitorPlugin(name = "Components")
public class ComponentsPlugin extends Plugin {
    private static final String BASE = "https://github.com/Tupyton/todoenuno/releases/download/componentes/";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /** get({ file, sha256 }) → { path }, downloading the file unless it is already there. */
    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("file", "");
        String sha256 = call.getString("sha256", "");
        if (!name.matches("[\\w-]+\\.[a-z0-9]+") || !sha256.matches("[0-9a-f]{64}")) {
            call.reject("Componente no válido.");
            return;
        }
        worker.execute(() -> {
            File folder = new File(getContext().getFilesDir(), "componentes");
            File target = new File(folder, name);
            File partial = new File(folder, name + ".parcial");
            try {
                if (!target.exists()) {
                    if (!folder.exists() && !folder.mkdirs()) throw new Exception("No se pudo preparar la carpeta.");
                    download(name, sha256, partial);
                    if (!partial.renameTo(target)) throw new Exception("No se pudo guardar el componente.");
                }
                JSObject answer = new JSObject();
                answer.put("path", target.getAbsolutePath());
                call.resolve(answer);
            } catch (Exception error) {
                partial.delete();
                call.reject("No se pudo descargar el componente: " + error.getMessage());
            }
        });
    }

    private void download(String name, String sha256, File out) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + name).openConnection();
        connection.setInstanceFollowRedirects(true);
        if (connection.getResponseCode() != 200) throw new Exception("el servidor respondió " + connection.getResponseCode() + ".");
        long total = connection.getContentLengthLong();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long received = 0;
        long reported = 0;
        try (InputStream in = connection.getInputStream(); OutputStream stream = new FileOutputStream(out)) {
            byte[] buffer = new byte[1 << 16];
            for (int n; (n = in.read(buffer)) > 0; ) {
                stream.write(buffer, 0, n);
                digest.update(buffer, 0, n);
                received += n;
                if (total > 0 && received - reported > total / 100) {
                    reported = received;
                    JSObject event = new JSObject();
                    event.put("progress", (double) received / total);
                    notifyListeners("progress", event);
                }
            }
        } finally {
            connection.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b));
        // A file that does not match exactly what was published is never used.
        if (!hex.toString().equals(sha256)) throw new Exception("el archivo descargado no coincide con el publicado.");
    }
}
