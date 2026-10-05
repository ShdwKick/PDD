package ru.burninghouse.pdd;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

/**
 * Общее у всех виджетов: данные одни (/api/widget, RefreshWorker), рисует
 * WidgetRender. Сами виджеты ничего не качают.
 */
public abstract class BaseWidget extends AppWidgetProvider {
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
        // Убрали последний виджет этого вида — фон гасим, только если других видов на экране тоже нет.
        if (!WidgetRender.anyOnScreen(c)) RefreshWorker.cancel(c);
    }
}
