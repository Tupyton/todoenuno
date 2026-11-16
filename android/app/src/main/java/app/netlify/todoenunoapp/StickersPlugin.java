package app.netlify.todoenunoapp;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.util.List;

/**
 * Saves a sticker pack made on the page and asks WhatsApp to add it. WhatsApp then reads the files
 * through StickerProvider. Limits from WhatsApp's validator: 3 to 30 stickers, WebP of 512×512 up to
 * 100 KB, a tray image up to 50 KB, a name up to 128 characters and 1 to 3 emoji per sticker.
 */
@CapacitorPlugin(name = "Stickers")
public class StickersPlugin extends Plugin {
    /** addToWhatsApp({ name, emoji, tray, stickers: [base64 WebP] }) → { added } */
    @PluginMethod
    public void addToWhatsApp(PluginCall call) {
        String name = call.getString("name", "").trim();
        String emoji = call.getString("emoji", "").trim();
        String tray = call.getString("tray", "");
        JSArray stickers = call.getArray("stickers", new JSArray());
        if (name.isEmpty() || name.length() > 128) {
            call.reject("El nombre del paquete debe tener entre 1 y 128 caracteres.");
            return;
        }
        if (emoji.isEmpty()) {
            call.reject("WhatsApp pide al menos un emoji para los stickers.");
            return;
        }
        if (stickers.length() < 3 || stickers.length() > 30) {
            call.reject("Un paquete de WhatsApp lleva entre 3 y 30 stickers.");
            return;
        }
        String id = "p" + System.currentTimeMillis();
        File folder = new File(StickerProvider.root(getContext()), id);
        try {
            if (!folder.mkdirs()) throw new Exception("No se pudo preparar la carpeta.");
            write(new File(folder, "name.txt"), name.getBytes("UTF-8"));
            write(new File(folder, "emoji.txt"), emoji.getBytes("UTF-8"));
            write(new File(folder, StickerProvider.TRAY), Base64.decode(tray, Base64.DEFAULT));
            for (int i = 0; i < stickers.length(); i++) {
                write(new File(folder, (i + 1) + ".webp"), Base64.decode(stickers.getString(i), Base64.DEFAULT));
            }
        } catch (Exception error) {
            erase(folder);
            call.reject("No se pudo guardar el paquete: " + error.getMessage());
            return;
        }
        Intent intent = new Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK");
        intent.putExtra("sticker_pack_id", id);
        intent.putExtra("sticker_pack_authority", getContext().getPackageName() + ".stickers");
        intent.putExtra("sticker_pack_name", name);
        // WhatsApp and WhatsApp Business both take packs; with both installed, Android asks which one.
        List<ResolveInfo> apps = getContext().getPackageManager().queryIntentActivities(intent, 0);
        if (apps.isEmpty()) {
            erase(folder);
            call.reject("WhatsApp no está instalado o es una versión antigua.");
            return;
        }
        if (apps.size() == 1) intent.setPackage(apps.get(0).activityInfo.packageName);
        startActivityForResult(call, apps.size() == 1 ? intent : Intent.createChooser(intent, "Añadir a WhatsApp"), "added");
    }

    @ActivityCallback
    private void added(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        String problem = data != null ? data.getStringExtra("validation_error") : null;
        if (problem != null) {
            call.reject("WhatsApp no aceptó el paquete: " + problem);
            return;
        }
        JSObject answer = new JSObject();
        answer.put("added", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(answer);
    }

    private static void write(File file, byte[] data) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    private static void erase(File folder) {
        File[] files = folder.listFiles();
        if (files != null) for (File file : files) file.delete();
        folder.delete();
    }
}
