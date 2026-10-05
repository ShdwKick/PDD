# Сборка из Windows-папки с кириллицей в пути (F:\Рабэта\…): Android Gradle
# Plugin такие пути не любит. Временно подключаем проект как отдельный диск
# (subst), собираем оттуда и отключаем. Ничего не копируется.
#
#   .\build.ps1                       # debug APK  → app\build\outputs\apk\debug\
#   .\build.ps1 bundleRelease         # .aab для Google Play (нужен keystore.properties)
#   .\build.ps1 assembleRelease       # подписанный APK для установки в обход стора
#   .\build.ps1 assembleDebug -PsiteUrl=http://10.0.2.2:8798
param(
    [string]$Task = "assembleDebug",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = "Stop"

# JDK 17: свой JAVA_HOME, если он 17-й, иначе — из ~/.jdks.
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\java.exe") -or -not ((& "$env:JAVA_HOME\bin\java.exe" -version 2>&1 | Out-String) -match '"17\.')) {
    $jdk = Get-ChildItem "$env:USERPROFILE\.jdks" -Directory -ErrorAction SilentlyContinue | Where-Object Name -like "jdk-17*" | Select-Object -First 1
    if (-not $jdk) { throw "Нужен JDK 17: положите его в $env:USERPROFILE\.jdks или укажите JAVA_HOME." }
    $env:JAVA_HOME = $jdk.FullName
}

$letter = [char[]]([int][char]'P'..[int][char]'Z') | Where-Object { -not (Test-Path "$($_):\") } | Select-Object -First 1
if (-not $letter) { throw "Нет свободной буквы диска P–Z для subst." }
subst "$($letter):" $PSScriptRoot
try {
    Push-Location "$($letter):\"
    & .\gradlew.bat $Task @Rest
    if ($LASTEXITCODE -ne 0) { throw "gradlew ${Task}: код $LASTEXITCODE" }
} finally {
    Pop-Location
    subst "$($letter):" /D
}
