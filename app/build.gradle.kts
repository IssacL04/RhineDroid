plugins { id("com.android.application") }

android {
    namespace = "com.enc3l.rhinedroid"
    compileSdk { version = release(37) }
    defaultConfig {
        applicationId = "com.enc3l.rhinedroid"
        minSdk = 26
        targetSdk = 37
        versionCode = 14
        versionName = "0.4.8"
        buildConfigField("boolean", "EXPERIMENTAL_OPTICS", "false")
    }
    buildTypes {
        create("rc") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".rc"
            matchingFallbacks += "debug"
            buildConfigField("boolean", "EXPERIMENTAL_OPTICS", "true")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].assets.directories.add(layout.buildDirectory.dir("generated/webAssets").get().asFile.absolutePath)
}

androidComponents {
    onVariants(selector().withBuildType("rc")) { variant ->
        variant.outputs.forEach { output ->
            output.versionName.set("0.4.8-rc")
            output.versionCode.set(4)
        }
    }
}

val buildWeb by tasks.registering(Exec::class) {
    workingDir(rootProject.file("web"))
    commandLine("npm", "run", "build:android")
    inputs.dir(rootProject.file("web/src"))
    inputs.dir(rootProject.file("web/public"))
    inputs.dir(rootProject.file("web/content"))
    inputs.files(rootProject.file("web/index.html"), rootProject.file("web/vite.config.ts"),
        rootProject.file("web/package.json"), rootProject.file("web/package-lock.json"))
    outputs.dir(rootProject.file("web/dist"))
}
val syncWebAssets by tasks.registering(Sync::class) {
    dependsOn(buildWeb)
    from(rootProject.file("web/dist"))
    from(rootProject.file("LICENSE")) { into("licenses") }
    from(rootProject.file("NOTICE.md")) { into("licenses") }
    into(layout.buildDirectory.dir("generated/webAssets"))
}
val buildVulkanAssets by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "scripts/build-vulkan-assets.mjs")
    inputs.files(rootProject.file("scripts/build-vulkan-assets.mjs"), rootProject.file("app/src/main/materials/archive.mat"), rootProject.file("web/src/decryption.ts"), rootProject.file("app/src/main/java/com/enc3l/rhinedroid/ShelfLayout.kt"),
        rootProject.file("web/public/assets/music-case-v040.glb"))
    inputs.files(fileTree("src/main/assets/vulkan") { include("*.mat", "*.filamat") })
    outputs.file(rootProject.file("app/src/main/assets/vulkan/archive.mesh"))
}
tasks.named("preBuild") { dependsOn(syncWebAssets, buildVulkanAssets) }

dependencies {
    implementation("androidx.activity:activity:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.media3:media3-exoplayer:1.11.0")
    implementation("androidx.media3:media3-session:1.11.0")
    implementation("com.google.android.filament:filament-android:1.77.2")
    testImplementation("junit:junit:4.13.2")
}
