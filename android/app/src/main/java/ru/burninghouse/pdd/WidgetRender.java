package ru.burninghouse.pdd;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Как выглядит виджет. Огонёк — как на сайте (assets/app.js flameSvg):
 * горит — норма дня выполнена, цвет по рубежам серии (motivation.js
 * MILESTONES); тлеет — серия есть, норма сегодня ещё нет; погас — серии нет.
 */
final class WidgetRender {
    /** Рубежи серии — как MILESTONES в assets/motivation.js. */
    private static final int[] MILESTONES = {3, 7, 14, 30, 50, 100};
    /** Цвета горящего огонька по рубежам {снаружи, внутри} — как FLAME_TIERS в assets/app.js. */
    private static final int[][] TIERS = {
            {0xFFFF6A1A, 0xFFFFD60A},
            {0xFFFF6A1A, 0xFFFFD60A},
            {0xFFFF5A1A, 0xFFFFE45C},
            {0xFFFF5A1A, 0xFF8FDCFF},
            {0xFF2F8CFF, 0xFFD6F6FF},
            {0xFF1F9BFF, 0xFFE6FBFF},
            {0xFFB43CFF, 0xFFFFE1F7},
    };
    private static final int DIM = 0xFF2A3646;

    private WidgetRender() {}

    static void updateAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, StreakWidget.class));
        if (ids.length == 0) return;
        RemoteViews v = build(c);
        for (int id : ids) m.updateAppWidget(id, v);
    }

    static RemoteViews build(Context c) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_streak);
        if (WidgetStore.token(c) == null) {
            flame(v, "out", 0);
            v.setTextViewText(R.id.days, "—");
            v.setTextViewText(R.id.label, c.getString(R.string.widget_connect));
            v.setViewVisibility(R.id.progress, View.GONE);
            v.setViewVisibility(R.id.today, View.GONE);
            v.setOnClickPendingIntent(R.id.root, open(c, "/widget?app=android"));
            return v;
        }
        v.setOnClickPendingIntent(R.id.root, open(c, "/?app=android"));
        JSONObject d = WidgetStore.data(c);
        if (d == null) {
            flame(v, "out", 0);
            v.setTextViewText(R.id.days, "…");
            v.setTextViewText(R.id.label, c.getString(R.string.widget_loading));
            v.setViewVisibility(R.id.progress, View.GONE);
            v.setViewVisibility(R.id.today, View.GONE);
            return v;
        }

        int current = d.optInt("current");
        int target = Math.max(1, d.optInt("target", 20));
        int count = d.optInt("todayCount");
        boolean done = d.optBoolean("todayDone");
        // Данные со вчера (ночью не было сети) — сегодня ещё ничего не решено.
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        if (!today.equals(d.optString("today"))) {
            count = 0;
            done = false;
        }

        flame(v, done ? "lit" : current > 0 ? "ember" : "out", current);
        v.setTextViewText(R.id.days, String.valueOf(current));
        v.setTextViewText(R.id.label, daysInRow(current));
        v.setViewVisibility(R.id.progress, View.VISIBLE);
        v.setProgressBar(R.id.progress, target, Math.min(count, target), false);
        v.setViewVisibility(R.id.today, View.VISIBLE);
        v.setTextViewText(R.id.today, done
                ? c.getString(R.string.widget_done)
                : c.getString(R.string.widget_today, count, target));
        return v;
    }

    private static void flame(RemoteViews v, String state, int current) {
        boolean lit = state.equals("lit");
        int[] colors = TIERS[tier(current)];
        v.setInt(R.id.flame_outer, "setColorFilter", lit ? colors[0] : DIM);
        v.setInt(R.id.flame_inner, "setColorFilter", colors[1]);
        v.setViewVisibility(R.id.flame_inner, lit ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.flame_coal, state.equals("ember") ? View.VISIBLE : View.GONE);
    }

    private static int tier(int current) {
        int t = 0;
        for (int at : MILESTONES) if (current >= at) t++;
        return t;
    }

    /** «1 день подряд», «3 дня подряд», «5 дней подряд». */
    private static String daysInRow(int n) {
        int m10 = n % 10, m100 = n % 100;
        String w = m10 == 1 && m100 != 11 ? "день"
                : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "дня" : "дней";
        return w + " подряд";
    }

    /** Открыть приложение (сайт в TWA) на нужной странице. */
    private static PendingIntent open(Context c, String path) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.SITE_URL + path), c, LauncherActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, path.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
