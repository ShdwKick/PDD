package ru.burninghouse.pdd;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Что знает виджет: ключ (выдан сайтом на странице /widget, только чтение
 * огонька) и последний ответ /api/widget — чтобы без сети показывать
 * последнее известное, а не пустоту.
 */
final class WidgetStore {
    private static final String PREFS = "widget";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_DATA = "data";

    private WidgetStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String token(Context c) {
        return prefs(c).getString(KEY_TOKEN, null);
    }

    /** Новый ключ — старые данные чужие (мог быть другой аккаунт), стираем. */
    static void setToken(Context c, String token) {
        prefs(c).edit().putString(KEY_TOKEN, token).remove(KEY_DATA).apply();
    }

    /** Ключ отозван на сайте — но только если это всё ещё он: пока шёл
     * запрос, могли подключить новый. */
    static void clearIfToken(Context c, String token) {
        if (token.equals(token(c))) prefs(c).edit().remove(KEY_TOKEN).remove(KEY_DATA).apply();
    }

    static JSONObject data(Context c) {
        String raw = prefs(c).getString(KEY_DATA, null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    static void setData(Context c, String json) {
        prefs(c).edit().putString(KEY_DATA, json).apply();
    }
}
