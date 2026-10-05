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

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Как выглядят виджеты. Данные у всех одни — последний ответ /api/widget
 * (WidgetStore). Огонёк — как на сайте (assets/app.js flameSvg): горит —
 * норма дня выполнена, цвет по рубежам серии (motivation.js MILESTONES);
 * тлеет — серия есть, норма сегодня ещё нет; погас — серии нет.
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
    /** Точки недели — как .w-dots на сайте: норма, заморозка, начато, пусто. */
    private static final int DOT_DONE = 0xFF30D158, DOT_FROZEN = 0xFF8FDCFF, DOT_PART = 0xFF22603A, DOT_NONE = 0xFF1D2A3D;
    private static final int[] DOTS = {R.id.d0, R.id.d1, R.id.d2, R.id.d3, R.id.d4, R.id.d5, R.id.d6};
    private static final int[] LETTERS = {R.id.l0, R.id.l1, R.id.l2, R.id.l3, R.id.l4, R.id.l5, R.id.l6};
    private static final int[] ANSWERS = {R.id.a0, R.id.a1, R.id.a2, R.id.a3};
    private static final int CAR_WIDTH_PX = 480;
    private static final String CONNECT_PATH = "/widget?app=android";

    private WidgetRender() {}

    /** Все виды виджетов — для перерисовки и для «есть ли хоть один на экране». */
    private static final Class<?>[] KINDS = {StreakWidget.class, MiniWidget.class, WeekWidget.class, CarWidget.class, QuestionWidget.class};

    static boolean anyOnScreen(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (Class<?> k : KINDS) if (m.getAppWidgetIds(new ComponentName(c, k)).length > 0) return true;
        return false;
    }

    static void updateAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        State s = State.load(c);
        for (Class<?> k : KINDS) {
            int[] ids = m.getAppWidgetIds(new ComponentName(c, k));
            if (ids.length == 0) continue;
            RemoteViews v = build(c, k, s);
            for (int id : ids) m.updateAppWidget(id, v);
        }
    }

    private static RemoteViews build(Context c, Class<?> kind, State s) {
        if (kind == MiniWidget.class) return mini(c, s);
        if (kind == WeekWidget.class) return week(c, s);
        if (kind == CarWidget.class) return car(c, s);
        if (kind == QuestionWidget.class) return question(c, s);
        return streak(c, s);
    }

    /* ---------- виды ---------- */

    private static RemoteViews streak(Context c, State s) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_streak);
        flame(v, s);
        v.setOnClickPendingIntent(R.id.root, open(c, s.connected ? "/?app=android" : CONNECT_PATH));
        v.setTextViewText(R.id.days, s.daysText());
        v.setTextViewText(R.id.label, s.label(c));
        boolean ready = s.data != null;
        v.setViewVisibility(R.id.progress, ready ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.today, ready ? View.VISIBLE : View.GONE);
        if (ready) {
            v.setProgressBar(R.id.progress, s.target, Math.min(s.count, s.target), false);
            v.setTextViewText(R.id.today, s.todayText(c));
        }
        return v;
    }

    private static RemoteViews mini(Context c, State s) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_mini);
        flame(v, s);
        v.setOnClickPendingIntent(R.id.root, open(c, s.connected ? "/?app=android" : CONNECT_PATH));
        v.setTextViewText(R.id.days, s.daysText());
        return v;
    }

    private static RemoteViews week(Context c, State s) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_week);
        flame(v, s);
        v.setOnClickPendingIntent(R.id.root, open(c, s.connected ? "/?app=android" : CONNECT_PATH));
        v.setTextViewText(R.id.days, s.daysText());
        v.setTextViewText(R.id.label, s.data == null ? s.label(c) : s.todayText(c));
        JSONArray week = s.data == null ? null : s.data.optJSONArray("week");
        int done = 0;
        for (int i = 0; i < 7; i++) {
            JSONObject d = week == null ? null : week.optJSONObject(i);
            String state = d == null ? "future" : d.optString("state", "none");
            // Данные со вчера — сегодняшний день ещё не начат, что бы ни пришло.
            if (d != null && d.optString("day").equals(s.today) && s.stale) state = "none";
            if (d != null && s.stale && d.optString("day").compareTo(s.today) > 0) state = "future";
            int color = state.equals("done") ? DOT_DONE : state.equals("frozen") ? DOT_FROZEN : state.equals("partial") ? DOT_PART : DOT_NONE;
            if (state.equals("done") || state.equals("frozen")) done++;
            v.setInt(DOTS[i], "setColorFilter", color);
            v.setInt(DOTS[i], "setImageAlpha", state.equals("future") ? 90 : 255);
            boolean isToday = d != null && d.optString("day").equals(s.today);
            v.setTextColor(LETTERS[i], isToday ? 0xFFE8EEF6 : 0xFF8FA3BD);
        }
        v.setTextViewText(R.id.week_total, s.data == null ? "" : c.getString(R.string.widget_week_total, done));
        return v;
    }

    private static RemoteViews car(Context c, State s) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_car);
        flame(v, s);
        v.setOnClickPendingIntent(R.id.root, open(c, s.connected ? "/garazh?app=android" : CONNECT_PATH));
        v.setTextViewText(R.id.days, s.daysText());
        v.setTextViewText(R.id.label, s.data == null ? s.label(c) : s.todayText(c));
        JSONObject car = s.data == null ? null : s.data.optJSONObject("car");
        v.setImageViewBitmap(R.id.car, CarPainter.draw(car, CAR_WIDTH_PX));
        return v;
    }

    private static RemoteViews question(Context c, State s) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_question);
        flame(v, s);
        v.setTextViewText(R.id.days, s.daysText());
        JSONObject q = s.data == null ? null : s.data.optJSONObject("question");
        // Вопрос со вчера (не было сети) не предлагаем — он уже не «дня».
        if (q == null || s.stale) {
            v.setTextViewText(R.id.qtext, s.connected ? c.getString(R.string.widget_loading) : c.getString(R.string.widget_connect));
            for (int id : ANSWERS) v.setViewVisibility(id, View.GONE);
            v.setViewVisibility(R.id.qnote, View.GONE);
            v.setOnClickPendingIntent(R.id.root, open(c, s.connected ? "/?app=android" : CONNECT_PATH));
            return v;
        }
        String qid = q.optString("id");
        v.setTextViewText(R.id.qtext, q.optString("text"));
        JSONArray answers = q.optJSONArray("answers");
        int right = q.optInt("correct", -1);
        // Ответ: с сервера (ответил где угодно) или только что в виджете — ещё до обновления.
        JSONObject fromServer = q.optJSONObject("answered");
        int chosen = fromServer != null ? fromServer.optInt("chosen", -1) : WidgetStore.localAnswer(c, qid);
        boolean answered = chosen >= 0;
        String explain = "/question/" + Uri.encode(qid) + "?app=android";
        for (int i = 0; i < ANSWERS.length; i++) {
            String a = answers == null ? null : answers.optString(i, null);
            if (a == null) { v.setViewVisibility(ANSWERS[i], View.GONE); continue; }
            v.setViewVisibility(ANSWERS[i], View.VISIBLE);
            String mark = !answered ? (i + 1) + ". " : i == right ? "✓ " : i == chosen ? "✗ " : "";
            v.setTextViewText(ANSWERS[i], mark + a);
            int bg = !answered ? R.drawable.widget_answer
                    : i == right ? R.drawable.widget_answer_ok : i == chosen ? R.drawable.widget_answer_bad : R.drawable.widget_answer;
            v.setInt(ANSWERS[i], "setBackgroundResource", bg);
            v.setTextColor(ANSWERS[i], answered && i != right && i != chosen ? 0xFF8FA3BD : 0xFFE8EEF6);
            // До ответа — ответить (AnswerActivity запомнит и не даст второй раз); после — только пояснение.
            v.setOnClickPendingIntent(ANSWERS[i], answered ? open(c, explain) : answer(c, qid, i));
        }
        v.setViewVisibility(R.id.qnote, answered ? View.VISIBLE : View.GONE);
        if (answered) v.setTextViewText(R.id.qnote, c.getString(chosen == right ? R.string.widget_q_right : R.string.widget_q_wrong));
        v.setOnClickPendingIntent(R.id.root, open(c, explain));
        return v;
    }

    /** Нажатие на вариант «вопроса дня» — через AnswerActivity. */
    private static PendingIntent answer(Context c, String qid, int i) {
        Intent intent = new Intent(c, AnswerActivity.class)
                .putExtra(AnswerActivity.EXTRA_QUESTION, qid)
                .putExtra(AnswerActivity.EXTRA_ANSWER, i)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, ("answer:" + qid + ":" + i).hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* ---------- общее ---------- */

    /** Огонёк: в каждом макете три слоя с одинаковыми id (flame_outer/inner/coal). */
    private static void flame(RemoteViews v, State s) {
        String state = s.done ? "lit" : s.current > 0 ? "ember" : "out";
        boolean lit = state.equals("lit");
        int[] colors = TIERS[tier(s.current)];
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
    static String daysInRow(int n) {
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

    /** Что показываем — разобранный один раз ответ /api/widget. */
    private static final class State {
        boolean connected;
        JSONObject data;
        int current, target = 20, count;
        boolean done, stale;
        String today;

        static State load(Context c) {
            State s = new State();
            s.today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            s.connected = WidgetStore.token(c) != null;
            s.data = s.connected ? WidgetStore.data(c) : null;
            if (s.data == null) return s;
            s.current = s.data.optInt("current");
            s.target = Math.max(1, s.data.optInt("target", 20));
            s.count = s.data.optInt("todayCount");
            s.done = s.data.optBoolean("todayDone");
            // Данные со вчера (ночью не было сети) — сегодня ещё ничего не решено.
            s.stale = !s.today.equals(s.data.optString("today"));
            if (s.stale) { s.count = 0; s.done = false; }
            return s;
        }

        String daysText() {
            return !connected ? "—" : data == null ? "…" : String.valueOf(current);
        }

        String label(Context c) {
            return !connected ? c.getString(R.string.widget_connect) : data == null ? c.getString(R.string.widget_loading) : daysInRow(current);
        }

        String todayText(Context c) {
            return done ? c.getString(R.string.widget_done) : c.getString(R.string.widget_today, count, target);
        }
    }
}
