package app.netlify.todoenunoapp;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Text to speech with the phone's own voices, saved as a WAV file like the Windows app does. The
 * WebView has no speechSynthesis, so the page asks this plugin instead.
 */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin {
    private static final int MAX_TEXT = 100_000;

    private final CompletableFuture<TextToSpeech> engine = new CompletableFuture<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) engine.complete(holder[0]);
            else engine.completeExceptionally(new Exception("Este teléfono no tiene un motor de voz activo."));
        });
    }

    private TextToSpeech tts() throws Exception {
        return engine.get(10, TimeUnit.SECONDS);
    }

    @PluginMethod
    public void voices(PluginCall call) {
        worker.execute(() -> {
            try {
                JSArray list = new JSArray();
                for (Voice voice : tts().getVoices()) {
                    // Voices that need a download or a connection would fail when used.
                    if (voice.isNetworkConnectionRequired() || voice.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSObject item = new JSObject();
                    item.put("name", voice.getName());
                    item.put("lang", voice.getLocale().toLanguageTag());
                    list.put(item);
                }
                JSObject answer = new JSObject();
                answer.put("voices", list);
                call.resolve(answer);
            } catch (Exception error) {
                call.reject(error.getMessage());
            }
        });
    }

    @PluginMethod
    public void synthesize(PluginCall call) {
        String text = call.getString("text", "");
        String voiceName = call.getString("voice", "");
        float rate = call.getFloat("rate", 1f);
        if (text.trim().isEmpty()) {
            call.reject("Escribe el texto.");
            return;
        }
        if (text.length() > MAX_TEXT) {
            call.reject("El texto es demasiado largo.");
            return;
        }
        worker.execute(() -> {
            File dir = new File(getContext().getCacheDir(), "voz");
            try {
                TextToSpeech tts = tts();
                for (Voice voice : tts.getVoices()) if (voice.getName().equals(voiceName)) tts.setVoice(voice);
                tts.setSpeechRate(Math.max(0.25f, Math.min(4f, rate)));
                deleteAll(dir);
                if (!dir.mkdirs()) throw new Exception("No se pudo preparar el audio.");
                // The engine takes a limited amount of text at a time, so long texts are spoken in parts
                // and the parts joined into one file.
                List<File> parts = new ArrayList<>();
                for (String piece : split(text, TextToSpeech.getMaxSpeechInputLength() - 1)) {
                    File part = new File(dir, "parte-" + parts.size() + ".wav");
                    speakTo(tts, piece, part);
                    parts.add(part);
                }
                File result = new File(dir, "voz-" + System.currentTimeMillis() + ".wav");
                join(parts, result);
                JSObject answer = new JSObject();
                answer.put("path", result.getAbsolutePath());
                call.resolve(answer);
            } catch (Exception error) {
                call.reject("No se pudo generar la voz: " + error.getMessage());
            }
        });
    }

    private static void speakTo(TextToSpeech tts, String text, File file) throws Exception {
        CompletableFuture<Void> done = new CompletableFuture<>();
        String id = "parte-" + System.nanoTime();
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {}

            @Override
            public void onDone(String utteranceId) {
                if (id.equals(utteranceId)) done.complete(null);
            }

            @Override
            @Deprecated
            public void onError(String utteranceId) {
                if (id.equals(utteranceId)) done.completeExceptionally(new Exception("el motor de voz falló."));
            }
        });
        if (tts.synthesizeToFile(text, new Bundle(), file, id) != TextToSpeech.SUCCESS) throw new Exception("el motor de voz no aceptó el texto.");
        done.get(10, TimeUnit.MINUTES);
    }

    /** Splits the text into pieces of at most `max` characters, preferably after a sentence or a space. */
    private static List<String> split(String text, int max) {
        List<String> pieces = new ArrayList<>();
        String rest = text.trim();
        while (rest.length() > max) {
            int cut = Math.max(rest.lastIndexOf(". ", max), Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf("? ", max)));
            if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
            if (cut <= 0) cut = max;
            pieces.add(rest.substring(0, cut + 1).trim());
            rest = rest.substring(cut + 1).trim();
        }
        if (!rest.isEmpty()) pieces.add(rest);
        return pieces;
    }

    /** Joins WAV files of the same format: the first file's format, and every file's sound data. */
    private static void join(List<File> parts, File out) throws Exception {
        byte[] format = null;
        ByteArrayOutputStream sound = new ByteArrayOutputStream();
        for (File part : parts) {
            ByteBuffer wav = ByteBuffer.wrap(Files.readAllBytes(part.toPath())).order(ByteOrder.LITTLE_ENDIAN);
            wav.position(12); // after "RIFF", the size and "WAVE"
            while (wav.remaining() >= 8) {
                byte[] tag = new byte[4];
                wav.get(tag);
                int size = wav.getInt();
                byte[] body = new byte[Math.min(size, wav.remaining())];
                wav.get(body);
                if (size % 2 == 1 && wav.hasRemaining()) wav.get(); // chunks are padded to an even size
                String name = new String(tag, "US-ASCII");
                if (name.equals("fmt ") && format == null) format = body;
                else if (name.equals("data")) sound.write(body);
            }
        }
        if (format == null) throw new Exception("el motor de voz no produjo audio.");
        byte[] data = sound.toByteArray();
        ByteBuffer header = ByteBuffer.allocate(20 + format.length + 8).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes("US-ASCII")).putInt(4 + 8 + format.length + 8 + data.length).put("WAVE".getBytes("US-ASCII"));
        header.put("fmt ".getBytes("US-ASCII")).putInt(format.length).put(format);
        header.put("data".getBytes("US-ASCII")).putInt(data.length);
        try (FileOutputStream stream = new FileOutputStream(out)) {
            stream.write(header.array());
            stream.write(data);
        }
    }

    private static void deleteAll(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteAll(child);
        file.delete();
    }

    @Override
    protected void handleOnDestroy() {
        if (engine.isDone() && !engine.isCompletedExceptionally()) engine.join().shutdown();
    }
}
