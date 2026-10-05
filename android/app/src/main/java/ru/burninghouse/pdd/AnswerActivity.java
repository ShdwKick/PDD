package ru.burninghouse.pdd;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * Нажали вариант в «вопросе дня». Окна нет: запомнить ответ — виджет сразу
 * отмечает его и больше не даёт ответить (WidgetRender.question), — открыть
 * сайт, где ответ засчитается с пояснением, и попросить свежие данные чуть
 * позже, когда сайт ответ уже сохранит.
 */
public final class AnswerActivity extends Activity {
    static final String EXTRA_QUESTION = "question";
    static final String EXTRA_ANSWER = "answer";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String qid = getIntent().getStringExtra(EXTRA_QUESTION);
        int answer = getIntent().getIntExtra(EXTRA_ANSWER, -1);
        if (qid != null && answer >= 0 && !WidgetStore.answeredToday(this, qid)) {
            WidgetStore.setLocalAnswer(this, qid, answer);
            WidgetRender.updateAll(this);
            open("/question/" + Uri.encode(qid) + "?a=" + answer + "&app=android");
            RefreshWorker.refreshSoon(this);
        } else if (qid != null) {
            // Уже ответил (повторное нажатие до перерисовки) — просто показать вопрос с пояснением.
            open("/question/" + Uri.encode(qid) + "?app=android");
        }
        finish();
    }

    private void open(String path) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.SITE_URL + path), this, LauncherActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
    }
}
