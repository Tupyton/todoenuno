package app.netlify.todoenunoapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins are registered before the page loads.
        registerPlugin(DownloaderPlugin.class);
        registerPlugin(SpeechPlugin.class);
        registerPlugin(ComponentsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
