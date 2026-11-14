package de.hinterweller.inventur;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Inventur als Android-App: eine WebView zeigt dieselbe index.html wie im Web (aus den App-Assets).
 * Die Hülle ergänzt, was eine WebView allein nicht kann: Kamera-Berechtigung, Foto über die Kamera-App,
 * Export in „Downloads“ bzw. Teilen, Vibrieren, Bildschirm an beim Scannen und die Zurück-Taste.
 */
public class MainActivity extends ComponentActivity {

    /* NIE ändern: Die Daten der App (IndexedDB) hängen an dieser Adresse (Origin). Andere Adresse = leere App. */
    static final String HOST = WebViewAssetLoader.DEFAULT_DOMAIN; // appassets.androidplatform.net
    static final String START_URL = "https://" + HOST + "/app/index.html";
    static final String AKTION_GETEILT = "de.hinterweller.inventur.GETEILT";

    private WebView web;
    private WebViewAssetLoader lader;
    private final Handler haupt = new Handler(Looper.getMainLooper());
    private final ExecutorService hintergrund = Executors.newSingleThreadExecutor();

    // Kamera-Berechtigung: wartende Anfrage der Seite (getUserMedia) und/oder wartendes Foto
    private PermissionRequest wartendeKameraAnfrage;
    private boolean fotoWartetAufBerechtigung;
    // Läuft gerade der Berechtigungs-Dialog? Dann die WebView in onPause NICHT pausieren: sonst wird die Seite
    // „unsichtbar“, app.js beendet den wartenden Kamera-Start, verwirft die Antwort und fragt sofort erneut (Schleife).
    private boolean berechtigungLaeuft;
    private ActivityResultLauncher<String> kameraBerechtigung;

    // Foto über <input type="file" capture>
    private ValueCallback<Uri[]> dateiRueckruf;
    private Uri fotoUri;
    private File fotoDatei;
    private ActivityResultLauncher<Intent> fotoStarter;

    // Export
    private final Map<String, Export> exporte = new ConcurrentHashMap<>();
    private ActivityResultLauncher<String> speicherBerechtigung;
    private Runnable nachSpeicherBerechtigung;
    private Runnable ohneSpeicherBerechtigung;
    private int teilenZaehler;
    private BroadcastReceiver geteiltEmpfaenger;

    private static final class Export {
        final File datei;
        OutputStream aus;
        boolean fertig;
        Export(File datei, OutputStream aus) { this.datei = datei; this.aus = aus; }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        kameraBerechtigung = registerForActivityResult(new ActivityResultContracts.RequestPermission(), this::kameraBerechtigungErgebnis);
        fotoStarter = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), this::fotoErgebnis);
        speicherBerechtigung = registerForActivityResult(new ActivityResultContracts.RequestPermission(), erlaubt -> {
            Runnable r = erlaubt ? nachSpeicherBerechtigung : ohneSpeicherBerechtigung;
            nachSpeicherBerechtigung = null;
            ohneSpeicherBerechtigung = null;
            if (r != null) r.run();
        });

        geteiltEmpfaenger = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String id = intent.getStringExtra("id");
                if (id != null) antworten(id, true, "geteilt");
            }
        };
        ContextCompat.registerReceiver(this, geteiltEmpfaenger, new IntentFilter(AKTION_GETEILT), ContextCompat.RECEIVER_NOT_EXPORTED);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        // Randlos zeichnen und selbst einrücken (Statusleiste, Navigationsleiste, Kamera-Aussparung, Tastatur)
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        FrameLayout wurzel = new FrameLayout(this);
        wurzel.setBackgroundColor(0xFF111820);
        ViewCompat.setOnApplyWindowInsetsListener(wurzel, (v, einsaetze) -> {
            Insets i = einsaetze.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        lader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/app/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFFEEF1F4);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false); // content://-Adressen braucht die Seite nicht (Dateiauswahl ist davon nicht betroffen)
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(false);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new ChromeClient());
        web.addJavascriptInterface(new Bruecke(), "InventurAndroid");
        wurzel.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(wurzel);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() { zurueck(); }
        });

        hintergrund.execute(this::cacheAufraeumen);
        web.loadUrl(START_URL);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null && !berechtigungLaeuft) web.onPause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        if (web != null) web.onPause(); // spätestens jetzt (auch wenn onPause es wegen des Dialogs ausgelassen hat)
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(geteiltEmpfaenger); } catch (RuntimeException e) { /* egal */ }
        for (Export e : exporte.values()) schliessen(e);
        if (web != null) {
            web.destroy();
            web = null;
        }
        hintergrund.shutdown();
        super.onDestroy();
    }

    /* ---------- Zurück-Taste: erst die App fragen (Dialog schließen usw.), sonst minimieren, nie beenden ---------- */
    private void zurueck() {
        if (web == null) { moveTaskToBack(true); return; }
        web.evaluateJavascript("(window.inventurZurueck ? window.inventurZurueck() : 'minimieren')", ergebnis -> {
            if (!"\"erledigt\"".equals(ergebnis)) moveTaskToBack(true);
        });
    }

    /* ---------- Antwort an die Seite: window.inventurNativ(id, ok, text) ---------- */
    void antworten(String id, boolean ok, String text) {
        String js = "window.inventurNativ && window.inventurNativ(" + JSONObject.quote(id) + "," + ok + ","
                + JSONObject.quote(text == null ? "" : text) + ")";
        haupt.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    /* ---------- WebView: nur die eigene Adresse, alles aus den Assets ---------- */
    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) {
                WebResourceResponse r = lader.shouldInterceptRequest(url);
                if (r != null) return r; // sonst (Pfad außerhalb /app/, http) nicht ins Netz, sondern blockieren
            }
            // Die App braucht kein Netz: fremde Adressen gar nicht erst laden
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !HOST.equals(request.getUrl().getHost());
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // WebView-Prozess abgestürzt/beendet: neu aufbauen statt die App abstürzen zu lassen
            if (web == view) {
                ((ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                web = null;
                recreate();
            }
            return true;
        }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean eigeneSeite = HOST.equals(request.getOrigin().getHost());
            boolean nurKamera = true;
            for (String r : request.getResources()) {
                if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) nurKamera = false;
            }
            if (!eigeneSeite || !nurKamera) { request.deny(); return; }
            if (hatKamera()) {
                request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                return;
            }
            if (wartendeKameraAnfrage != null) wartendeKameraAnfrage.deny();
            wartendeKameraAnfrage = request;
            berechtigungLaeuft = true;
            kameraBerechtigung.launch(Manifest.permission.CAMERA);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (wartendeKameraAnfrage == request) wartendeKameraAnfrage = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> rueckruf, FileChooserParams params) {
            if (dateiRueckruf != null) dateiRueckruf.onReceiveValue(null);
            dateiRueckruf = rueckruf;
            if (params.isCaptureEnabled()) {
                if (hatKamera()) kameraAppStarten();
                else {
                    fotoWartetAufBerechtigung = true;
                    berechtigungLaeuft = true;
                    kameraBerechtigung.launch(Manifest.permission.CAMERA);
                }
            } else {
                galerieStarten();
            }
            return true;
        }
    }

    private boolean hatKamera() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void kameraBerechtigungErgebnis(boolean erlaubt) {
        berechtigungLaeuft = false;
        PermissionRequest anfrage = wartendeKameraAnfrage;
        wartendeKameraAnfrage = null;
        if (anfrage != null) {
            if (erlaubt) anfrage.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else anfrage.deny();
        }
        if (fotoWartetAufBerechtigung) {
            fotoWartetAufBerechtigung = false;
            if (dateiRueckruf == null) return;
            if (erlaubt) kameraAppStarten();
            else {
                Toast.makeText(this, "Kamera nicht erlaubt – bitte ein Bild auswählen.", Toast.LENGTH_LONG).show();
                galerieStarten();
            }
        }
    }

    /* ---------- Foto: Kamera-App mit Zieldatei im Cache, Ergebnis an das <input type="file"> ---------- */
    private void kameraAppStarten() {
        try {
            File ordner = new File(getCacheDir(), "fotos");
            if (!ordner.isDirectory() && !ordner.mkdirs()) throw new IOException("Ordner fehlt");
            fotoDatei = new File(ordner, "foto_" + System.currentTimeMillis() + ".jpg");
            fotoUri = FileProvider.getUriForFile(this, getPackageName() + ".dateien", fotoDatei);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, fotoUri);
            i.setClipData(ClipData.newRawUri("foto", fotoUri));
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            fotoStarter.launch(i);
        } catch (IOException | ActivityNotFoundException | IllegalArgumentException e) {
            fotoDatei = null;
            fotoUri = null;
            galerieStarten();
        }
    }

    private void galerieStarten() {
        try {
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("image/*");
            fotoDatei = null;
            fotoUri = null;
            fotoStarter.launch(i);
        } catch (ActivityNotFoundException e) {
            dateiZurueck(null);
        }
    }

    private void fotoErgebnis(ActivityResult ergebnis) {
        Uri[] werte = null;
        if (ergebnis.getResultCode() == RESULT_OK) {
            if (fotoDatei != null) {
                if (fotoDatei.length() > 0) werte = new Uri[]{fotoUri};
            } else if (ergebnis.getData() != null && ergebnis.getData().getData() != null) {
                werte = new Uri[]{ergebnis.getData().getData()};
            }
        }
        if (werte == null && fotoDatei != null) //noinspection ResultOfMethodCallIgnored
            fotoDatei.delete();
        fotoDatei = null;
        fotoUri = null;
        dateiZurueck(werte);
    }

    private void dateiZurueck(Uri[] werte) {
        ValueCallback<Uri[]> r = dateiRueckruf;
        dateiRueckruf = null;
        if (r != null) r.onReceiveValue(werte);
    }

    /* ---------- Brücke für app.js (läuft im JavaBridge-Thread) ---------- */
    private final class Bruecke {
        @JavascriptInterface
        public String exportBeginnen(String name) {
            try {
                String sicher = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
                if (sicher.isEmpty() || sicher.startsWith(".")) sicher = "inventur" + sicher;
                if (!sicher.toLowerCase(Locale.ROOT).endsWith(".zip")) sicher += ".zip";
                if (sicher.length() > 120) sicher = sicher.substring(sicher.length() - 120);
                String token = UUID.randomUUID().toString();
                File ordner = new File(new File(getCacheDir(), "export"), token);
                if (!ordner.mkdirs()) return "";
                File datei = new File(ordner, sicher);
                exporte.put(token, new Export(datei, new FileOutputStream(datei)));
                return token;
            } catch (IOException | RuntimeException e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean exportTeil(String token, String base64) {
            Export e = exporte.get(token);
            if (e == null || e.aus == null) return false;
            try {
                e.aus.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException x) {
                schliessen(e);
                exporte.remove(token);
                loeschen(e.datei.getParentFile());
                return false;
            }
        }

        @JavascriptInterface
        public boolean exportAbschliessen(String token, double groesse) {
            Export e = exporte.get(token);
            if (e == null || e.aus == null) return false;
            boolean ok = schliessen(e) && e.datei.length() == (long) groesse && groesse > 0;
            if (ok) e.fertig = true;
            else {
                exporte.remove(token);
                loeschen(e.datei.getParentFile());
            }
            return ok;
        }

        @JavascriptInterface
        public void exportSpeichern(String token, String id) {
            Export e = exporte.get(token);
            if (e == null || !e.fertig) { antworten(id, false, "Export-Datei fehlt"); return; }
            haupt.post(() -> inDownloadsSpeichern(e.datei, id));
        }

        @JavascriptInterface
        public void exportTeilen(String token, String id) {
            Export e = exporte.get(token);
            if (e == null || !e.fertig) { antworten(id, false, "Export-Datei fehlt"); return; }
            haupt.post(() -> teilen(e.datei, id));
        }

        @JavascriptInterface
        public void vibrieren(int ms) {
            try {
                Vibrator v;
                if (Build.VERSION.SDK_INT >= 31) {
                    VibratorManager m = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    v = m == null ? null : m.getDefaultVibrator();
                } else {
                    v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                }
                if (v != null && v.hasVibrator()) {
                    v.vibrate(VibrationEffect.createOneShot(Math.max(1, Math.min(ms, 1000)), VibrationEffect.DEFAULT_AMPLITUDE));
                }
            } catch (RuntimeException e) { /* Vibrieren ist nur Zugabe */ }
        }

        @JavascriptInterface
        public void wachHalten(boolean an) {
            haupt.post(() -> {
                if (an) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void minimieren() {
            haupt.post(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void appEinstellungen() {
            haupt.post(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
                } catch (ActivityNotFoundException e) { /* egal */ }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (PackageManager.NameNotFoundException e) {
                return "";
            }
        }
    }

    /* ---------- Export: in „Downloads“ speichern ---------- */
    private void inDownloadsSpeichern(File datei, String id) {
        if (Build.VERSION.SDK_INT < 29
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            nachSpeicherBerechtigung = () -> inDownloadsSpeichern(datei, id);
            ohneSpeicherBerechtigung = () -> antworten(id, false, "Speicher-Berechtigung nicht erteilt");
            speicherBerechtigung.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            return;
        }
        hintergrund.execute(() -> {
            try {
                String name = Build.VERSION.SDK_INT >= 29 ? perMediaStore(datei) : direktSpeichern(datei);
                antworten(id, true, name);
            } catch (IOException | RuntimeException e) {
                antworten(id, false, "Speicher voll oder nicht beschreibbar");
            }
        });
    }

    @androidx.annotation.RequiresApi(29)
    private String perMediaStore(File datei) throws IOException {
        ContentResolver cr = getContentResolver();
        ContentValues werte = new ContentValues();
        werte.put(MediaStore.MediaColumns.DISPLAY_NAME, datei.getName());
        werte.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
        werte.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        werte.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri ziel = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, werte);
        if (ziel == null) throw new IOException("Eintrag in Downloads nicht möglich");
        try {
            long kopiert;
            try (InputStream ein = new FileInputStream(datei); OutputStream aus = cr.openOutputStream(ziel, "w")) {
                if (aus == null) throw new IOException("Downloads nicht beschreibbar");
                kopiert = kopieren(ein, aus);
            }
            if (kopiert != datei.length()) throw new IOException("unvollständig");
            werte.clear();
            werte.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(ziel, werte, null, null);
        } catch (IOException | RuntimeException e) {
            try { cr.delete(ziel, null, null); } catch (RuntimeException x) { /* egal */ }
            throw e;
        }
        String name = datei.getName();
        try (Cursor c = cr.query(ziel, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
        }
        return name;
    }

    /** Android 8/9: direkt in den öffentlichen Ordner „Download“ schreiben (mit WRITE_EXTERNAL_STORAGE). */
    @SuppressWarnings("deprecation")
    private String direktSpeichern(File datei) throws IOException {
        File ordner = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!ordner.isDirectory() && !ordner.mkdirs()) throw new IOException("Ordner Download fehlt");
        String name = datei.getName();
        String basis = name.substring(0, name.length() - 4);
        File ziel = new File(ordner, name);
        for (int n = 1; ziel.exists(); n++) ziel = new File(ordner, basis + " (" + n + ").zip");
        long kopiert;
        try (InputStream ein = new FileInputStream(datei); OutputStream aus = new FileOutputStream(ziel)) {
            kopiert = kopieren(ein, aus);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            ziel.delete();
            throw e;
        }
        if (kopiert != datei.length()) {
            //noinspection ResultOfMethodCallIgnored
            ziel.delete();
            throw new IOException("unvollständig");
        }
        MediaScannerConnection.scanFile(this, new String[]{ziel.getAbsolutePath()}, new String[]{"application/zip"}, null);
        return ziel.getName();
    }

    /* ---------- Export: Teilen-Dialog. Erfolg wird gemeldet, sobald dort eine App gewählt wurde. ---------- */
    private void teilen(File datei, String id) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".dateien", datei);
            Intent senden = new Intent(Intent.ACTION_SEND);
            senden.setType("application/zip");
            senden.putExtra(Intent.EXTRA_STREAM, uri);
            senden.putExtra(Intent.EXTRA_SUBJECT, datei.getName());
            senden.setClipData(ClipData.newRawUri(datei.getName(), uri));
            senden.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent rueck = new Intent(AKTION_GETEILT).setPackage(getPackageName()).putExtra("id", id);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(this, ++teilenZaehler, rueck, flags);
            startActivity(Intent.createChooser(senden, "Export senden", pi.getIntentSender()));
        } catch (ActivityNotFoundException | IllegalArgumentException e) {
            antworten(id, false, "Keine App zum Teilen gefunden");
        }
    }

    /* ---------- Hilfen ---------- */
    private static long kopieren(InputStream ein, OutputStream aus) throws IOException {
        byte[] puffer = new byte[64 * 1024];
        long summe = 0;
        int n;
        while ((n = ein.read(puffer)) > 0) {
            aus.write(puffer, 0, n);
            summe += n;
        }
        aus.flush();
        return summe;
    }

    private static boolean schliessen(Export e) {
        if (e.aus == null) return true;
        try {
            e.aus.close();
            return true;
        } catch (IOException x) {
            return false;
        } finally {
            e.aus = null;
        }
    }

    private static void loeschen(File f) {
        if (f == null) return;
        File[] kinder = f.listFiles();
        if (kinder != null) for (File k : kinder) loeschen(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Alte Fotos (> 1 Tag) und Export-Dateien (> 3 Tage) aus dem Cache entfernen. */
    private void cacheAufraeumen() {
        long jetzt = System.currentTimeMillis();
        aufraeumen(new File(getCacheDir(), "fotos"), jetzt - 24L * 3600 * 1000);
        aufraeumen(new File(getCacheDir(), "export"), jetzt - 3L * 24 * 3600 * 1000);
    }

    private static void aufraeumen(File ordner, long aelterAls) {
        File[] liste = ordner.listFiles();
        if (liste == null) return;
        for (File f : liste) if (f.lastModified() < aelterAls) loeschen(f);
    }
}
