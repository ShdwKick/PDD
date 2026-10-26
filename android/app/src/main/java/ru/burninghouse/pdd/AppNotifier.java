package ru.burninghouse.pdd;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Уведомления через приложение (а не Web Push в Chrome): сервер копит толчки
 * друзей и «огонёк гаснет» (app_notes), а мы забираем новые по ключу виджета
 * при каждом обновлении RefreshWorker и показываем от своего имени.
 */
final class AppNotifier {
    private static final String CHANNEL = "pdd";
    private static final int TIMEOUT_MS = 15_000;

    private AppNotifier() {}

    /** Сообщить серверу, что включены, и забрать новое. IOException — нет сети, попробуем в следующий раз. */
    static void run(Context c, String token) throws Exception {
        if (!WidgetStore.notifyOn(c)) return;
        if (!WidgetStore.notifySynced(c)) {
            JSONObject r = call(token, "POST", "/api/widget/notify", "{\"enabled\":true}");
            if (r == null) return; // ключ отозван — разберётся основное обновление виджета
            WidgetStore.setNotifyCursor(c, r.getLong("last")); // заодно «сервер знает»
        }
        JSONObject r = call(token, "GET", "/api/widget/notes?after=" + WidgetStore.notifyCursor(c), null);
        if (r == null) return;
        if (!r.optBoolean("notify")) {
            // Выключили на сайте («Выключить» в плане) — перестаём забирать.
            WidgetStore.setNotify(c, false);
            return;
        }
        JSONArray notes = r.getJSONArray("notes");
        for (int i = 0; i < notes.length(); i++) show(c, notes.getJSONObject(i));
        WidgetStore.setNotifyCursor(c, r.getLong("last"));
    }

    private static JSONObject call(String token, String method, String path, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(BuildConfig.SITE_URL + path).openConnection();
        try {
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestMethod(method);
            conn.setRequestProperty("Authorization", "Widget " + token);
            conn.setRequestProperty("Accept", "application/json");
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = conn.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_UNAUTHORIZED) return null;
            if (code != HttpURLConnection.HTTP_OK) throw new IOException(path + ": HTTP " + code);
            return new JSONObject(RefreshWorker.read(conn.getInputStream()));
        } finally {
            conn.disconnect();
        }
    }

    private static void show(Context c, JSONObject note) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, c.getString(R.string.notify_channel), NotificationManager.IMPORTANCE_DEFAULT));
            b = new Notification.Builder(c, CHANNEL);
        } else {
            b = new Notification.Builder(c);
        }
        // Открываем только свой сайт — адрес пришёл с сервера, но проверить не лишне.
        String url = note.optString("url");
        if (!url.startsWith(BuildConfig.SITE_URL + "/")) url = BuildConfig.SITE_URL + "/";
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(url), c, PddLauncherActivity.class);
        String tag = note.optString("tag", "pdd");
        PendingIntent pi = PendingIntent.getActivity(c, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(note.optString("title"))
                .setContentText(note.optString("body"))
                .setStyle(new Notification.BigTextStyle().bigText(note.optString("body")))
                .setContentIntent(pi)
                .setAutoCancel(true);
        // Тот же tag (новый толчок, новое напоминание) заменяет прежнее, а не копится.
        nm.notify(tag, 0, b.build());
    }
}
