package ru.burninghouse.pdd;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

/** Виджет «Огонёк» на главном экране. Сам ничего не качает — это RefreshWorker. */
public final class StreakWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        // Сразу — последнее известное, следом — свежее с сайта.
        WidgetRender.updateAll(c);
        RefreshWorker.schedule(c);
        RefreshWorker.refreshNow(c);
    }

    @Override
    public void onEnabled(Context c) {
        RefreshWorker.schedule(c);
    }

    @Override
    public void onDisabled(Context c) {
        // Последний виджет убрали с экрана — в фоне ходить незачем.
        RefreshWorker.cancel(c);
    }
}
