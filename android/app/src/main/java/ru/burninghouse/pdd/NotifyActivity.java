package ru.burninghouse.pdd;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

import java.util.regex.Pattern;

/**
 * Включение уведомлений через приложение: кнопка «Включить» на сайте внутри
 * приложения открывает pddwidget://notify?token=… (ключ тот же, что у
 * виджета). Спрашиваем разрешение Android — только для нашего приложения, без
 * уведомлений Chrome, — и дальше RefreshWorker сам забирает их с сервера.
 * pddwidget://check — забрать новые прямо сейчас (кнопка «Проверить»).
 */
public final class NotifyActivity extends Activity {
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final int REQUEST = 1;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri data = getIntent().getData();
        if (data != null && "check".equals(data.getHost())) {
            // «Проверить» на сайте: тестовое уже на сервере — забрать сразу, не ждать ~15 минут.
            RefreshWorker.refreshNow(this);
            finish();
            return;
        }
        String token = data == null ? null : data.getQueryParameter("token");
        if (token == null || !TOKEN.matcher(token).matches()) {
            Toast.makeText(this, R.string.notify_bad, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        WidgetStore.setToken(this, token);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQUEST);
            return;
        }
        done();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        done();
    }

    private void done() {
        boolean allowed = getSystemService(NotificationManager.class).areNotificationsEnabled();
        WidgetStore.setNotify(this, allowed);
        RefreshWorker.schedule(this);
        RefreshWorker.refreshNow(this);
        if (allowed) {
            Toast.makeText(this, R.string.notify_ok, Toast.LENGTH_LONG).show();
        } else {
            Toast.makeText(this, R.string.notify_denied, Toast.LENGTH_LONG).show();
            // Отказали раньше «навсегда» — окно Android больше не появится, только настройки.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            }
        }
        finish();
    }
}
