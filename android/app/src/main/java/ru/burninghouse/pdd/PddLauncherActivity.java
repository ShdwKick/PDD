package ru.burninghouse.pdd;

import android.content.Intent;
import android.content.pm.PackageManager;

import androidx.browser.customtabs.CustomTabsService;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/**
 * Приложение — сайт в Trusted Web Activity. Обычный LauncherActivity берёт
 * браузер по умолчанию, а у некоторых это Яндекс Браузер: сайт в нём
 * открывается, но подписка на уведомления падает (AbortError — у него нет
 * push-службы). Поэтому сначала ищем Chrome, нет его — как обычно.
 */
public class PddLauncherActivity extends LauncherActivity {
    /** Браузеры, в которых работают TWA и Web Push — по порядку предпочтения. */
    private static final String[] PREFERRED = {
        "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
    };

    @Override
    protected TwaLauncher createTwaLauncher() {
        String provider = preferredProvider();
        return provider == null ? super.createTwaLauncher() : new TwaLauncher(this, provider);
    }

    private String preferredProvider() {
        PackageManager pm = getPackageManager();
        for (String pkg : PREFERRED) {
            Intent probe = new Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION).setPackage(pkg);
            if (pm.resolveService(probe, 0) != null) return pkg;
        }
        return null;
    }
}
