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

    /* ---------- ответ на «вопрос дня», данный в виджете ----------
       Сервер узнает об ответе, только когда сайт его сохранит, а виджет
       обновится и того позже. Чтобы в это время не ответили второй раз, ответ
       помним здесь, с днём: завтра вопрос новый, запись сама теряет силу. */
    private static final String KEY_ANSWER_DAY = "answer_day";
    private static final String KEY_ANSWER_Q = "answer_q";
    private static final String KEY_ANSWER_I = "answer_i";

    static String today() {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(new java.util.Date());
    }

    static void setLocalAnswer(Context c, String questionId, int answer) {
        prefs(c).edit().putString(KEY_ANSWER_DAY, today()).putString(KEY_ANSWER_Q, questionId).putInt(KEY_ANSWER_I, answer).apply();
    }

    /** Ответ на этот вопрос сегодня в виджете, или -1. */
    static int localAnswer(Context c, String questionId) {
        SharedPreferences p = prefs(c);
        return today().equals(p.getString(KEY_ANSWER_DAY, null)) && questionId.equals(p.getString(KEY_ANSWER_Q, null))
                ? p.getInt(KEY_ANSWER_I, -1) : -1;
    }

    /** Ответил ли сегодня — в виджете или (по данным сервера) где угодно. */
    static boolean answeredToday(Context c, String questionId) {
        if (localAnswer(c, questionId) >= 0) return true;
        JSONObject d = data(c);
        JSONObject q = d == null ? null : d.optJSONObject("question");
        return q != null && questionId.equals(q.optString("id")) && today().equals(d.optString("today")) && q.optJSONObject("answered") != null;
    }
}
