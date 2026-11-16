package app.netlify.todoenunoapp;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.Arrays;
import java.util.List;

/**
 * Sticker packs made in the app, read by WhatsApp. Same paths and columns as WhatsApp's own sample
 * (github.com/WhatsApp/stickers); WhatsApp may ask at any time, so everything comes from the files that
 * StickersPlugin wrote: one folder per pack in files/stickers, with name.txt, emoji.txt, tray.png and
 * the stickers numbered 1.webp, 2.webp…
 */
public class StickerProvider extends ContentProvider {
    static final String PUBLISHER = "TodoEnUno";
    static final String TRAY = "tray.png";

    static File root(android.content.Context context) {
        return new File(context.getFilesDir(), "stickers");
    }

    private File root() {
        return root(getContext());
    }

    /** A pack folder, or null for a name that is not one: the identifier comes from WhatsApp's URI. */
    private File pack(String id) {
        if (id == null || !id.matches("p\\d+")) return null;
        File folder = new File(root(), id);
        return new File(folder, "name.txt").isFile() ? folder : null;
    }

    private static String read(File file) {
        // Small text files; java.nio.file.Files needs Android 8 and the app runs from Android 7.
        try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
            byte[] data = new byte[(int) file.length()];
            int read = 0;
            while (read < data.length) {
                int n = in.read(data, read, data.length - read);
                if (n < 0) break;
                read += n;
            }
            return new String(data, 0, read, "UTF-8").trim();
        } catch (Exception error) {
            return "";
        }
    }

    static List<File> stickers(File pack) {
        File[] files = pack.listFiles((dir, name) -> name.matches("\\d+\\.webp"));
        if (files == null) return Arrays.asList();
        Arrays.sort(files, (a, b) -> Integer.compare(number(a), number(b)));
        return Arrays.asList(files);
    }

    private static int number(File file) {
        return Integer.parseInt(file.getName().replace(".webp", ""));
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private String authority() {
        return getContext().getPackageName() + ".stickers";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        List<String> path = uri.getPathSegments();
        if (path.isEmpty()) throw new IllegalArgumentException("Unknown URI: " + uri);
        switch (path.get(0)) {
            case "metadata": {
                MatrixCursor cursor = new MatrixCursor(new String[] {
                    "sticker_pack_identifier", "sticker_pack_name", "sticker_pack_publisher", "sticker_pack_icon",
                    "android_play_store_link", "ios_app_download_link", "sticker_pack_publisher_email",
                    "sticker_pack_publisher_website", "sticker_pack_privacy_policy_website",
                    "sticker_pack_license_agreement_website", "image_data_version",
                    "whatsapp_will_not_cache_stickers", "animated_sticker_pack",
                });
                File[] folders = path.size() > 1 ? new File[] { pack(path.get(1)) } : root().listFiles();
                if (folders != null) {
                    for (File folder : folders) {
                        if (folder == null || pack(folder.getName()) == null) continue;
                        cursor.addRow(new Object[] {
                            folder.getName(), read(new File(folder, "name.txt")), PUBLISHER, TRAY,
                            "", "", "", "", "", "", "1", 0, 0,
                        });
                    }
                }
                return cursor;
            }
            case "stickers": {
                MatrixCursor cursor = new MatrixCursor(new String[] { "sticker_file_name", "sticker_emoji", "sticker_accessibility_text" });
                File folder = path.size() > 1 ? pack(path.get(1)) : null;
                if (folder != null) {
                    String emoji = read(new File(folder, "emoji.txt"));
                    for (File sticker : stickers(folder)) cursor.addRow(new Object[] { sticker.getName(), emoji, null });
                }
                return cursor;
            }
            default:
                throw new IllegalArgumentException("Unknown URI: " + uri);
        }
    }

    @Override
    public AssetFileDescriptor openAssetFile(Uri uri, String mode) throws FileNotFoundException {
        List<String> path = uri.getPathSegments();
        if (path.size() != 3 || !"stickers_asset".equals(path.get(0))) throw new FileNotFoundException(uri.toString());
        File folder = pack(path.get(1));
        String name = path.get(2);
        // Only the pack's own files: no other name reaches the file system.
        if (folder == null || !(TRAY.equals(name) || name.matches("\\d+\\.webp"))) throw new FileNotFoundException(uri.toString());
        File file = new File(folder, name);
        if (!file.isFile()) throw new FileNotFoundException(uri.toString());
        ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        return new AssetFileDescriptor(descriptor, 0, AssetFileDescriptor.UNKNOWN_LENGTH);
    }

    @Override
    public String getType(Uri uri) {
        List<String> path = uri.getPathSegments();
        if (path.isEmpty()) throw new IllegalArgumentException("Unknown URI: " + uri);
        switch (path.get(0)) {
            case "metadata":
                return (path.size() > 1 ? "vnd.android.cursor.item/vnd." : "vnd.android.cursor.dir/vnd.") + authority() + ".metadata";
            case "stickers":
                return "vnd.android.cursor.dir/vnd." + authority() + ".stickers";
            case "stickers_asset":
                return TRAY.equals(uri.getLastPathSegment()) ? "image/png" : "image/webp";
            default:
                throw new IllegalArgumentException("Unknown URI: " + uri);
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Not supported");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Not supported");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Not supported");
    }
}
