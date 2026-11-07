plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Ключ підпису береться зі змінних середовища (секрети GitHub Actions); без них — debug-ключ.
val ksFile: String? = System.getenv("KS_FILE")

android {
    namespace = "ua.kolysvitlo"
    compileSdk = 35

    defaultConfig {
        applicationId = "ua.kolysvitlo"
        minSdk = 26
        targetSdk = 35
        versionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "dev"
    }

    signingConfigs {
        if (ksFile != null) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("KS_PASS")
                keyAlias = System.getenv("KS_ALIAS")
                keyPassword = System.getenv("KS_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.work:work-runtime:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // справжній org.json замість заглушки android.jar
}
