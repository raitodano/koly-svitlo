// Застосунок «Коли світло?» для Android: віджет «є світло / немає» і сповіщення перед відключенням.
// Збирає GitHub Actions (.github/workflows/android.yml):  gradle -p android assembleRelease
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
}
