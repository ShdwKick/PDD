package ru.burninghouse.pdd;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import java.util.regex.Pattern;

/**
 * Принимает ключ виджета с сайта: кнопка «Подключить виджет» на /widget
 * открывает pddwidget://connect?token=… Окна у этой activity нет — сохранить
 * ключ, обновить виджет и вернуть человека в приложение.
 */
public final class ConnectActivity extends Activity {
    /** Как выдаёт сервер: 32 байта в base64url (lib/store.js createWidgetToken). */
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri data = getIntent().getData();
        String token = data == null ? null : data.getQueryParameter("token");
        if (token == null || !TOKEN.matcher(token).matches()) {
            Toast.makeText(this, R.string.connect_bad, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        WidgetStore.setToken(this, token);
        RefreshWorker.schedule(this);
        RefreshWorker.refreshNow(this);
        WidgetRender.updateAll(this);

        AppWidgetManager m = AppWidgetManager.getInstance(this);
        ComponentName widget = new ComponentName(this, StreakWidget.class);
        boolean onScreen = m.getAppWidgetIds(widget).length > 0;
        if (!onScreen && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && m.isRequestPinAppWidgetSupported()) {
            // Лаунчер сам предложит поставить виджет — без поиска в списке виджетов.
            m.requestPinAppWidget(widget, null, null);
        } else {
            Toast.makeText(this, onScreen ? R.string.connect_ok : R.string.connect_ok_add, Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
