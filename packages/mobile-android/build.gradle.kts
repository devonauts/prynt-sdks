import com.vanniktech.maven.publish.SonatypeHost

plugins {
    id("com.android.library") version "8.5.0"
    id("org.jetbrains.kotlin.android") version "1.9.24"
    id("com.vanniktech.maven.publish") version "0.29.0"
}

group = "com.pryntid"
version = "1.0.0"

android {
    namespace = "dev.prynt"
    compileSdk = 34
    defaultConfig {
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Play Integrity is OPTIONAL — the SDK loads it reflectively and degrades gracefully if
    // absent. Add it to enable hardware-backed attestation:
    // implementation("com.google.android.play:integrity:1.4.0")
}

// Publish to Maven Central (Sonatype Central Portal) with source + javadoc jars, GPG-signed.
// CI passes credentials via ORG_GRADLE_PROJECT_* env vars (see .github/workflows/release.yml).
mavenPublishing {
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = true)
    // Maven Central requires signatures; local builds and dry-runs have no key and skip signing.
    if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
    coordinates("com.pryntid", "prynt-android", version.toString())
    pom {
        name.set("Prynt Android SDK")
        description.set("Stable device identity + integrity signals, verified server-side.")
        url.set("https://pryntid.com")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/licenses/MIT")
            }
        }
        developers {
            developer { name.set("Prynt"); email.set("support@pryntid.com"); url.set("https://pryntid.com") }
        }
        scm {
            url.set("https://github.com/devonauts/prynt-sdks/tree/main/packages/mobile-android")
            connection.set("scm:git:https://github.com/devonauts/prynt-sdks.git")
            developerConnection.set("scm:git:ssh://git@github.com/devonauts/prynt-sdks.git")
        }
    }
}
