# «Когда на права?» для Android

Сайт pdd.burninghouse.ru во весь экран (Trusted Web Activity — обновляется вместе
с сайтом, пересобирать приложение под каждую правку сайта не нужно) плюс
нативный виджет «Огонёк» на главный экран: серия дней и норма на сегодня.

## Как устроено

- **Приложение** — `LauncherActivity` из androidbrowserhelper открывает
  `https://pdd.burninghouse.ru/?app=android` в Chrome без адресной строки.
  Без адресной строки — только если сайт подтверждает приложение файлом
  `/.well-known/assetlinks.json` (server.js, переменные `ANDROID_PACKAGE`,
  `ANDROID_CERT_SHA256`). Не подтвердил — откроется с адресной строкой.
- **Виджет** — `StreakWidget` + `RefreshWorker`: раз в 15 минут (чаще Android не
  даёт) `GET /api/widget` с заголовком `Authorization: Widget <ключ>`.
- **Ключ виджета** — только чтение огонька, не вход в аккаунт. Выдаёт сайт на
  странице «Виджет на экран» (`/widget`, видна в меню аккаунта внутри
  приложения): `POST /api/widget/token` → `intent://connect?token=…` →
  `ConnectActivity` сохраняет ключ и предлагает поставить виджет. На сервере —
  только хеш, до 5 ключей на человека; «Отключить все мои виджеты» там же.

## Сборка

Нужны JDK 17 и Android SDK (platform 35, build-tools 35). Путь к SDK — в
`local.properties` (`sdk.dir=C\:\\Users\\…\\AppData\\Local\\Android\\Sdk`).

На Windows из папки с кириллицей в пути (`F:\Рабэта\…`) Android Gradle Plugin
собирать отказывается — собирайте через `build.ps1`: он временно подключает
проект отдельным диском (`subst`), JDK 17 берёт из `~/.jdks`, если `JAVA_HOME` другой.

```bash
powershell -File build.ps1                                          # app/build/outputs/apk/debug/
powershell -File build.ps1 assembleDebug -PsiteUrl=http://10.0.2.2:8798   # против локального node dev.mjs из эмулятора
powershell -File build.ps1 assembleRelease                          # подписанный APK для установки в обход стора
powershell -File build.ps1 bundleRelease                            # .aab для Google Play
```

Из папки без кириллицы — просто `./gradlew assembleDebug` и т. д.

## Подпись

Ключ загрузки (upload key) и пароли — в `keystore.properties` рядом с этим
файлом, в git не попадает:

```properties
storeFile=C:/Users/<вы>/.android-keys/pdd-upload.jks
storePassword=…
keyAlias=pdd-upload
keyPassword=…
```

Потеряли ключ загрузки — его можно сбросить через поддержку Play Console
(при Play App Signing сам ключ подписи хранит Google). Но лучше не терять:
сделайте копию .jks и паролей вне этого компьютера.

## Выкладка в Google Play

1. Play Console → «Создать приложение», пакет `ru.burninghouse.pdd`.
2. Загрузить `app-release.aab` (внутреннее тестирование → рабочая версия).
3. Play Console → «Целостность приложения» → «Подпись приложения»: скопировать
   SHA-256 сертификата **подписи приложения** (не загрузки).
4. На сервере в `ANDROID_CERT_SHA256` — этот SHA-256, через запятую с SHA-256
   ключа загрузки (чтобы и APK в обход стора открывался без адресной строки).
   Проверка: `https://pdd.burninghouse.ru/.well-known/assetlinks.json`.
5. Карточка: иконка 512×512 (`assets/icons/icon-512.png`), скриншоты,
   политика конфиденциальности, «Безопасность данных» (аккаунт BurningHouse,
   прогресс подготовки; рекламы и передачи третьим лицам нет), возрастной рейтинг.
