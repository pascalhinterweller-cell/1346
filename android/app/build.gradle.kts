// Android-App „Inventur“: schlanke WebView-Hülle um dieselbe index.html wie im Web (gebaut von ../../build.py).
import javax.inject.Inject

plugins {
    id("com.android.application")
}

val repo: File = rootDir.parentFile

// Version kommt aus src/index.html: <meta name="inventur-version" content="v7"> -> versionCode 7, versionName "7"
val appVersion: Int = Regex("""<meta name="inventur-version" content="v(\d+)">""")
    .find(File(repo, "src/index.html").readText())
    ?.groupValues?.get(1)?.toInt()
    ?: throw GradleException("Versionsnummer (v…) in src/index.html nicht gefunden")

// Signierung (nur Release): Pfad und Passwort kommen aus Umgebungsvariablen, nie aus dem Repo.
val keystorePfad: String? = System.getenv("INVENTUR_KEYSTORE")?.takeIf { it.isNotBlank() }
val keystorePasswort: String? = System.getenv("INVENTUR_KEYSTORE_PASSWORT")
val schluesselAlias: String = System.getenv("INVENTUR_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "inventur"
val keyPasswort: String? = System.getenv("INVENTUR_KEY_PASSWORT")?.takeIf { it.isNotBlank() } ?: keystorePasswort

android {
    namespace = "de.hinterweller.inventur"
    compileSdk = 36

    defaultConfig {
        // NIE ändern: Nur mit gleicher applicationId (und gleichem Schlüssel) lassen sich Updates installieren
        // und die gespeicherten Daten bleiben erhalten.
        applicationId = "de.hinterweller.inventur"
        minSdk = 26 // Android 8.0
        targetSdk = 36
        versionCode = appVersion
        versionName = appVersion.toString()
    }

    signingConfigs {
        if (keystorePfad != null) {
            create("release") {
                storeFile = file(keystorePfad)
                storePassword = keystorePasswort
                keyAlias = schluesselAlias
                keyPassword = keyPasswort
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePfad != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // Ziel-SDK und Abhängigkeiten werden bewusst festgehalten
        disable += setOf("OldTargetApi", "GradleDependency", "AndroidGradlePluginVersion", "NewerVersionAvailable")
    }
}

dependencies {
    implementation("androidx.activity:activity:1.12.4")
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.webkit:webkit:1.14.0")
}

/* index.html für die App mit build.py erzeugen (dieselbe Datei wie im Web, nur ohne sw.js). */
abstract class WebInhaltErzeugen : DefaultTask() {
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val quelle: DirectoryProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val skript: RegularFileProperty
    @get:OutputDirectory abstract val ziel: DirectoryProperty
    @get:Inject abstract val ausfuehren: ExecOperations

    @TaskAction
    fun erzeugen() {
        val ordner = ziel.get().asFile
        ordner.deleteRecursively()
        ausfuehren.exec { commandLine("python3", skript.get().asFile.absolutePath, "--android", ordner.absolutePath) }
    }
}

/* App-Symbol aus src/icons übernehmen (Vordergrund des adaptiven Symbols). */
abstract class SymbolKopieren : DefaultTask() {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val bild: RegularFileProperty
    @get:OutputDirectory abstract val ziel: DirectoryProperty

    @TaskAction
    fun kopieren() {
        val ordner = ziel.get().asFile
        ordner.deleteRecursively()
        val drawable = File(ordner, "drawable-nodpi").apply { mkdirs() }
        bild.get().asFile.copyTo(File(drawable, "ic_vordergrund.png"), overwrite = true)
    }
}

val webInhalt = tasks.register<WebInhaltErzeugen>("webInhaltErzeugen") {
    quelle.set(File(repo, "src"))
    skript.set(File(repo, "build.py"))
    ziel.set(layout.buildDirectory.dir("generated/inventur/assets"))
}
val symbol = tasks.register<SymbolKopieren>("symbolKopieren") {
    bild.set(File(repo, "src/icons/icon-maskable-512.png"))
    ziel.set(layout.buildDirectory.dir("generated/inventur/res"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(webInhalt, WebInhaltErzeugen::ziel)
        variant.sources.res?.addGeneratedSourceDirectory(symbol, SymbolKopieren::ziel)
    }
}
