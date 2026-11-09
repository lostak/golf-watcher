plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.lostak.teewatch"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.lostak.teewatch"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("TEEWATCH_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("TEEWATCH_VERSION_NAME") ?: "1.0"
    }
    // The signing key is never in this public repo: the build (in a private repo) passes its keystore in through
    // these variables. Without them, release builds are left unsigned and debug builds use the local debug key.
    val ks = System.getenv("TEEWATCH_KEYSTORE")
    signingConfigs {
        if (ks != null) create("upload") {
            storeFile = file(ks)
            storePassword = System.getenv("TEEWATCH_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("TEEWATCH_KEY_ALIAS") ?: "teewatch"
            keyPassword = System.getenv("TEEWATCH_KEY_PASSWORD") ?: System.getenv("TEEWATCH_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            if (ks != null) signingConfig = signingConfigs.getByName("upload")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
