package ru.burninghouse.pdd;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Забирает огонёк с сайта (GET /api/widget по ключу виджета) и перерисовывает
 * виджеты. Раз в 15 минут — чаще Android фоновую работу не пускает; плюс
 * сразу после подключения и когда виджет поставили на экран.
 */
public final class RefreshWorker extends Worker {
    private static final String TAG = "PddWidget";
    private static final String PERIODIC = "pdd-widget-periodic";
    private static final String NOW = "pdd-widget-now";
    private static final long PERIOD_MINUTES = 15;
    private static final int TIMEOUT_MS = 15_000;
    private static final int MAX_BODY = 16 * 1024;

    public RefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    static void schedule(Context c) {
        PeriodicWorkRequest r = new PeriodicWorkRequest.Builder(RefreshWorker.class, PERIOD_MINUTES, TimeUnit.MINUTES)
                .setConstraints(online()).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, r);
    }

    static void refreshNow(Context c) {
        OneTimeWorkRequest r = new OneTimeWorkRequest.Builder(RefreshWorker.class).setConstraints(online()).build();
        WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, r);
    }

    static void cancel(Context c) {
        WorkManager.getInstance(c).cancelUniqueWork(PERIODIC);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        String token = WidgetStore.token(c);
        if (token == null) {
            WidgetRender.updateAll(c);
            return Result.success();
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(BuildConfig.SITE_URL + "/api/widget").openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestProperty("Authorization", "Widget " + token);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_OK) {
                String body = read(conn.getInputStream());
                new JSONObject(body); // кривой ответ не сохраняем — бросит
                WidgetStore.setData(c, body);
                return Result.success();
            }
            if (code == HttpURLConnection.HTTP_UNAUTHORIZED) {
                // Виджеты отключили на сайте — виджет попросит подключить заново.
                WidgetStore.clearIfToken(c, token);
                return Result.success();
            }
            Log.w(TAG, "/api/widget: HTTP " + code);
            return Result.retry();
        } catch (Exception e) {
            // Нет сети, сайт недоступен — покажем последнее известное, попробуем позже.
            Log.w(TAG, "Огонёк не обновился", e);
            return Result.retry();
        } finally {
            if (conn != null) conn.disconnect();
            WidgetRender.updateAll(c);
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BODY) throw new IOException("ответ /api/widget слишком большой");
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
