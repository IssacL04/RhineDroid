package com.enc3l.rhinedroid

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.Surface
import android.view.SurfaceView
import com.google.android.filament.*
import com.google.android.filament.android.DisplayHelper
import com.google.android.filament.android.UiHelper
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import kotlin.math.*

/** Native Vulkan draws the shelf. Instance deformation runs in archive.mat, never in JS. */
class VulkanArchiveRenderer(private val context: Context, val surface: SurfaceView,
    private val send: (JSONObject) -> Unit, private val background: (Int) -> Unit) : UiHelper.RendererCallback {
    private val engine: Engine
    private val renderer: Renderer
    private val scene: Scene
    private val view: View
    private val camera: Camera
    private val colorGrading: ColorGrading
    private var paperColor = 0
    private val opaque: Material
    private val glass: Material
    private val materials = mutableListOf<MaterialInstance>()
    private val entities = mutableListOf<Int>()
    private val vertices = mutableListOf<VertexBuffer>()
    private val indices = mutableListOf<IndexBuffer>()
    private val textures = mutableListOf<Texture>()
    private val atlas: Texture
    private var atlasMipsDirty = false
    private val selectedCover: Texture
    private val ui = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
    private val display = DisplayHelper(context)
    private val handler = Handler(Looper.getMainLooper())
    private val artWorker = Executors.newSingleThreadExecutor()
    private val repository = LibraryRepository.get(context)
    private var swap: SwapChain? = null
    private var columns: List<List<String>> = emptyList()
    private var selected = ""
    private var loadedSelected = ""
    private var lane = 0
    private var row = 0
    private var filled = true
    private var cells = ShelfLayout.cells(emptyList(), 0, 0, true)
    private val motion = ShelfMotion()
    private val artwork = ArtworkSlots()
    private var artLoads = 0
    private var lastSnapshot = JSONObject()
    private var resizeFence: Fence? = null
    private var pendingWidth = 1
    private var pendingHeight = 1
    private var resizing = false
    private var resizeBegan = 0L
    private var resizeWarning = false
    private val resizeCheck = Runnable { finishResize() }
    private var settleFrames = 0
    private var night = false
    private var reduced = false
    private var hidden = false
    private var resumed = false
    @Volatile private var closed = false
    private var scheduled = false
    @Volatile private var artRevision = 0
    private var qualityScale = 1f
    private var renderScale = 1f
    private var width = 1
    private var height = 1
    private val placement = ArchiveScalar()
    private val overviewMotion = ArchiveSpring()
    private var overviewTarget = 0.0
    private var animationTime = 0.0
    private var animationSpeed = 1.0
    private var frameTime = 0L
    private var introTime: Double? = null
    private var introSpeed = 1.0
    private var inspectStart = -1.0
    private var rotation = 0f
    private var targetRotation = 0f
    private var pendingReturn = false
    private var pendingSelection: (() -> Unit)? = null
    private val cameraMotion = ArchiveCameraMotion()
    private val clearOptions = Renderer.ClearOptions().apply { clear = true; discard = true }
    private var cameraMoving = false
    private var idleEnabled = false
    private var experimentalOptics = false
    private var focusDepth = true
    private val idleGain = ArchiveSpring()
    private var lastInteraction = 0.0
    private val themeMotion = ArchiveScalar()
    private var themeValue = 0.0
    private var guideDuration=1.1
    private val guideX = ArchiveSpring()
    private val guideZ = ArchiveSpring()
    private var dirty = true
    private var lastReport = 0L
    private var fpsEpoch = 0L
    private var submitted = 0
    private var frames = 0
    private var fps = 0
    private var lastState = ""
    private var skybox: Skybox? = null
    private val frame = Choreographer.FrameCallback { time -> draw(time) }

    init {
        val version = context.packageManager.systemAvailableFeatures.firstOrNull {
            it.name == PackageManager.FEATURE_VULKAN_HARDWARE_VERSION
        }?.version ?: 0
        require(version >= 0x00401000) { "设备没有报告 Vulkan 1.1 硬件支持，本版本不会回退为软件渲染。" }
        Filament.init()
        engine = Engine.Builder().backend(Engine.Backend.VULKAN).build()
        check(engine.backend == Engine.Backend.VULKAN) { "未能建立 Vulkan 渲染后端。" }
        try {
            renderer = engine.createRenderer()
            renderer.setMaterialTimeEpoch(System.nanoTime())
            val paper = ArchivePalette.channels(0.0).map { ArchivePalette.linear(it).toDouble() }
            clearOptions.setClearColor(paper[0],paper[1],paper[2],1.0)
            renderer.clearOptions = clearOptions
            scene = engine.createScene()
            view = engine.createView().apply {
                this.scene = this@VulkanArchiveRenderer.scene
                isPostProcessingEnabled = true
                isShadowingEnabled = false
                antiAliasing = View.AntiAliasing.FXAA
                setVisibleLayers(0xff, 1)
            }
            colorGrading = ColorGrading.Builder().toneMapper(ToneMapper.Linear())
                .luminanceScaling(false).gamutMapping(false).build(engine)
            view.colorGrading = colorGrading
            camera = engine.createCamera(EntityManager.get().create())
            view.camera = camera
            opaque = material("opaque.filamat")
            glass = material("glass.filamat")
            atlas = texture(2048, 2048, 4)
            selectedCover = texture(512, 512, 10)
            createMeshes()
            updateDepthOfField()
            rebuildCells()
            theme(false)
            ui.renderCallback = this
            ui.attachTo(surface)
        } catch (error: Throwable) {
            closed = true; artWorker.shutdownNow(); handler.removeCallbacks(resizeCheck); ui.detach(); engine.destroy()
            throw error
        }
    }
    private fun material(name: String): Material {
        val bytes = context.assets.open("vulkan/$name").use { it.readBytes() }
        return Material.Builder().payload(ByteBuffer.wrap(bytes), bytes.size).build(engine)
    }
    private fun texture(w: Int, h: Int, levels: Int = 1): Texture = Texture.Builder().width(w).height(h).levels(levels)
        .usage(Texture.Usage.DEFAULT or (if (levels > 1) Texture.Usage.GEN_MIPMAPPABLE else 0))
        .sampler(Texture.Sampler.SAMPLER_2D).format(Texture.InternalFormat.SRGB8_A8).build(engine).also { textures.add(it) }
    private fun createMeshes() {
        val bytes = context.assets.open("vulkan/archive.mesh").use { it.readBytes() }
        val input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        check(input.int == 0x4b564852 && input.int == 1 && input.int == 3)
        repeat(3) {
            val kind = input.int
            val count = input.int
            check(kind in 0..2 && count in 3..65535 && count % 3 == 0)
            val data = ByteArray(count * 32); input.get(data)
            val vb = VertexBuffer.Builder().bufferCount(1).vertexCount(count)
                .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 32)
                .attribute(VertexBuffer.VertexAttribute.CUSTOM0, 0, VertexBuffer.AttributeType.FLOAT3, 12, 32)
                .attribute(VertexBuffer.VertexAttribute.UV0, 0, VertexBuffer.AttributeType.FLOAT2, 24, 32).build(engine)
            vb.setBufferAt(engine, 0, ByteBuffer.allocateDirect(data.size).order(ByteOrder.nativeOrder()).put(data).flip())
            val ib = IndexBuffer.Builder().indexCount(count).bufferType(IndexBuffer.Builder.IndexType.USHORT).build(engine)
            val index = ByteBuffer.allocateDirect(count * 2).order(ByteOrder.nativeOrder())
            repeat(count) { n -> index.putShort(n.toShort()) }; index.flip(); ib.setBuffer(engine, index)
            val material = (if (kind == 2) opaque else glass).createInstance()
            material.setParameter("kind", kind.toFloat())
            material.setParameter("rotation", 0f)
            material.setParameter("night", 0f)
            material.setParameter("optics", 0f)
            material.setParameter("focus", 1f)
            material.setParameter("focusCenter", 0f, 0f)
            material.setParameter("selectedReady", 0f)
            val sampler = TextureSampler(TextureSampler.MinFilter.LINEAR_MIPMAP_LINEAR, TextureSampler.MagFilter.LINEAR, TextureSampler.WrapMode.CLAMP_TO_EDGE)
            material.setParameter("covers", atlas, sampler)
            material.setParameter("selectedCover", selectedCover, TextureSampler(TextureSampler.MinFilter.LINEAR_MIPMAP_LINEAR,
                TextureSampler.MagFilter.LINEAR, TextureSampler.WrapMode.CLAMP_TO_EDGE))
            material.setParameter("openingGrid", ShelfLayout.INTRO_COLUMNS.toFloat(), ShelfLayout.INTRO_ROWS.toFloat())
            material.setParameter("poolGrid", ShelfLayout.COLUMNS.toFloat(), ShelfLayout.ROWS.toFloat())
            material.setParameter("clock",0f)
            material.setParameter("idle",0f)
            material.setParameter("opening",-1f)
            material.setParameter("inspection",-1f)
            material.setParameter("placement",0f)
            material.setParameter("guidance",1.3f,1.35f,.3f,1f)
            material.setParameter("guideCenter",0f,0f)
            // The dense opening shares buffers and materials; its layer is never drawn while browsing.
            for (opening in listOf(false, true)) {
                val entity = EntityManager.get().create()
                RenderableManager.Builder(1).boundingBox(Box(0f, 0f, 0f, 50f, 1010f, 50f))
                    .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vb, ib)
                    .material(0, material).instances(if (opening) ShelfLayout.INTRO_COUNT else ShelfLayout.COUNT).culling(false)
                    .castShadows(false).receiveShadows(false).build(engine, entity)
                engine.renderableManager.setLayerMask(engine.renderableManager.getInstance(entity), 0xff, if (opening) 2 else 1)
                entities.add(entity); scene.addEntity(entity)
            }
            vertices.add(vb); indices.add(ib); materials.add(material)
        }
        check(!input.hasRemaining())
    }
    private fun detail() = placement.sample(animationTime).value.toFloat().coerceIn(0f,1f)
    private fun overview() = overviewMotion.value.toFloat().coerceIn(0f,1f)
    private fun animate(targetDetail: Float = placement.target.toFloat(), targetOverview: Float = overviewTarget.toFloat(), immediate: Boolean = false) {
        if (targetDetail == 0f && !immediate && abs(rotation) > .001f) {
            pendingReturn = true; targetRotation = 0f; dirty = true; requestFrame(); return
        }
        pendingReturn = false
        if (placement.target != targetDetail.toDouble() || immediate)
            placement.to(targetDetail.toDouble(), animationTime, if (reduced || immediate) 0.0 else ArchivePose.PLACEMENT_SECONDS)
        overviewTarget = targetOverview.toDouble()
        if (reduced || immediate) overviewMotion.update(overviewTarget, 0.0, immediate = true)
        if (targetDetail == 0f) { inspectStart = -1.0; materials.forEach { it.setParameter("inspection", -1f) } }
        rebuildCells(if (reduced || immediate) 0f else ArchivePose.PLACEMENT_SECONDS.toFloat())
        lastInteraction = animationTime; dirty = true; requestFrame()
    }
    fun command(message: JSONObject) {
        when (message.getString("type")) {
            "scene-library" -> {
                val input = message.getJSONArray("columns")
                require(input.length() <= 10000)
                val known = repository.albumIds()
                var total = 0
                columns = (0 until input.length()).map { n ->
                    val ids = input.getJSONArray(n)
                    total += ids.length(); require(total <= 100000)
                    (0 until ids.length()).map { ids.getString(it).also { id -> require(id in known) } }
                }
                select(message.optString("selectedId"), true)
            }
            "scene-select" -> select(message.getString("albumId"), message.optBoolean("immediate"), message.optString("axis"), message.optInt("direction"))
            "scene-mode" -> {
                require(message.getString("mode") in listOf("hidden", "archive", "detail"))
                if (message.optBoolean("immediate")) introTime = null
                hidden = message.getString("mode") == "hidden"
                updateLayers()
                animate(if (message.getString("mode") == "detail") 1f else 0f, targetOverview = 0f, immediate = message.optBoolean("immediate"))
            }
            "scene-overview" -> animate(targetOverview = if (message.getBoolean("active")) 1f else 0f)
            "scene-array" -> {
                require(message.getString("mode") in listOf("filled", "realistic"))
                filled = message.getString("mode") != "realistic"; animate() }
            "scene-theme" -> theme(message.getString("theme") == "night", message.optBoolean("immediate"))
            "scene-speed" -> { val speed = message.getDouble("value"); require(speed.isFinite() && speed in .25..3.0); animationSpeed = speed; dirty = true; requestFrame() }
            "scene-idle" -> { idleEnabled = message.getBoolean("value"); dirty = true; requestFrame() }
            "scene-focus" -> {
                focusDepth = message.getBoolean("value")
                materials.forEach { it.setParameter("focus", if (focusDepth) 1f else 0f) }
                updateDepthOfField(); dirty = true; requestFrame(); report(true)
            }
            "scene-optics" -> {
                require(BuildConfig.EXPERIMENTAL_OPTICS) { "该效果仅在实验 RC 版本中提供" }
                experimentalOptics = message.getBoolean("value")
                view.bloomOptions = View.BloomOptions().apply {
                    enabled = experimentalOptics; strength = .075f; resolution = 256; levels = 5
                    threshold = true; lensFlare = false; quality = View.QualityLevel.LOW
                }
                updateDepthOfField()
                materials.forEach { it.setParameter("optics", if (experimentalOptics) 1f else 0f) }
                dirty = true; requestFrame(); report(true)
            }
            "scene-intro" -> {
                if (message.optBoolean("active", true)) {
                    val speed=message.optDouble("speed",1.0)
                    require(speed.isFinite() && speed in .25..3.0)
                    introSpeed=speed; introTime = message.optDouble("time", 21.92).coerceIn(21.92,27.12); hidden = false
                }
                else introTime = null
                updateLayers()
                dirty = true; requestFrame()
            }
            "scene-lighting" -> {
                val values = listOf("strength" to (0.0..2.0),"width" to (.6..2.5),"offset" to (-6.0..6.0),"fill" to (0.0..1.0))
                    .map { (key,range) -> message.getDouble(key).also { require(it.isFinite() && it in range) }.toFloat() }
                guideDuration=message.optDouble("transitionDuration",1.1).also { require(it.isFinite() && it in .4..2.4) }
                materials.forEach { it.setParameter("guidance",values[0],values[1],values[2],values[3]) }
                dirty = true; requestFrame()
            }
            "scene-reduced" -> { reduced = message.getBoolean("value"); if (reduced) animate(immediate = true) }
            "scene-drag" -> {
                val value = message.getDouble("rotation"); require(value.isFinite())
                targetRotation = value.toFloat().coerceIn(-1.1f, 1.1f)
                lastInteraction = animationTime; dirty = true; requestFrame()
            }
            "scene-pick" -> {
                val x = message.getDouble("x"); val y = message.getDouble("y")
                require(x.isFinite() && y.isFinite() && x in 0.0..1.0 && y in 0.0..1.0)
                val hit = cells.mapIndexedNotNull { index, cell ->
                    if (cell.album == null) null else {
                        val now = animationTime.toFloat()
                        val center = project(motion.sample(index, 0, now).position.toDouble(),
                            motion.sample(index, 1, now).position.toDouble() + 1.85, motion.sample(index, 2, now).position.toDouble())
                        val radius = 1.8 / currentSpan()
                        val distance = hypot((center[0] - x) * width / height, center[1] - y)
                        if (distance < radius) Triple(index, cell, distance) else null
                    }
                }.minByOrNull { it.third }
                if (hit != null) send(JSONObject().put("type", "scene-pick").put("albumId", hit.second.album)
                    .put("lane", hit.second.lane).put("row", hit.second.row + 12))
            }
            "scene-quality" -> {
                val scale = message.getDouble("scale"); val ratio = message.getDouble("pixelRatio")
                require(scale.isFinite() && scale in 50.0..200.0 && ratio.isFinite() && ratio in 1.0..3.0)
                qualityScale = (scale / 100 * min(1.0, ratio / context.resources.displayMetrics.density)).toFloat()
                resolution()
            }
            "scene-status" -> report(true)
            else -> throw IllegalArgumentException("未知的场景操作")
        }
    }
    private fun resolution() {
        if (width <= 0 || height <= 0 || closed) return
        val ratio = min(qualityScale.toDouble(), sqrt(8_294_400.0 / (width.toDouble() * height))).coerceIn(.1, 2.0).toFloat()
        renderScale = ratio
        view.dynamicResolutionOptions = View.DynamicResolutionOptions().apply {
            enabled = true; minScale = ratio; maxScale = ratio; homogeneousScaling = true
        }
        dirty = true; requestFrame()
    }
    private fun select(id: String, immediate: Boolean, axis: String = "", direction: Int = 0) {
        if (!immediate && placement.target > .5 && abs(rotation) > .001f) {
            pendingSelection = { select(id, false, axis, direction) }; targetRotation = 0f; dirty = true; requestFrame(); return
        }
        pendingSelection = null
        inspectStart = -1.0; materials.forEach { it.setParameter("inspection", -1f) }
        lastInteraction = animationTime
        val actualLane = columns.indexOfFirst { id in it }
        val actualRow = columns.getOrNull(actualLane)?.indexOf(id) ?: -1
        require(id.isEmpty() && columns.isEmpty() || actualLane >= 0) { "专辑不在当前场景中" }
        val nextLane = if (filled) ShelfMotion.occurrence(max(0, actualLane), lane, columns.size,
            if (axis == "lane") direction.coerceIn(-1, 1) else 0) else max(0, actualLane)
        val sameLane = columns.isNotEmpty() && Math.floorMod(lane, columns.size) == actualLane
        val nextRow = if (filled) ShelfMotion.occurrence(max(0, actualRow), row, columns.getOrNull(actualLane)?.size ?: 0,
            if (axis == "row" && sameLane) direction.coerceIn(-1, 1) else 0) else max(0, actualRow)
        val dx = (nextLane - lane) * 5.2f
        val dz = if (sameLane) (nextRow - row) * .62f else 0f
        selected = id; lane = nextLane; row = nextRow
        rotation = 0f; targetRotation = 0f; materials.forEach { it.setParameter("rotation", rotation) }
        rebuildCells(if (reduced || immediate) 0f else ShelfMotion.duration(dx / 5.2f, dz / .62f), dx, dz)
        RhineLog.event("album-selection", JSONObject().put("lane", actualLane).put("row", actualRow)
            .put("cachedCovers", cells.count { it.album?.let { id -> artwork.get(coverKey(id)) }?.ready == true }).put("loads", artLoads))
        dirty = true; requestFrame()
    }
    private fun uploadPose() {
        cells.forEachIndexed { i, cell -> motion.origin[i*4+3]=cell.physicalRow.toFloat(); motion.velocity[i*4+3]=cell.physicalLane.toFloat()
            val d=cell.z/.62
            val weight=.25+.75*exp(-.5*(cell.x/5.2/.55).pow(2))
            motion.acceleration[i*4+3]=((ArchivePose.shoulder(d+.5,0.0)-ArchivePose.shoulder(d-.5,0.0))*weight*.024).toFloat()
        }
        materials.forEach { material ->
            material.setParameter("origins", MaterialInstance.FloatElement.FLOAT4, motion.origin, 0, ShelfLayout.COUNT)
            material.setParameter("velocities", MaterialInstance.FloatElement.FLOAT4, motion.velocity, 0, ShelfLayout.COUNT)
            material.setParameter("accelerations", MaterialInstance.FloatElement.FLOAT4, motion.acceleration, 0, ShelfLayout.COUNT)
            material.setParameter("travel", motion.start, motion.duration)
        }
        uploadCells()
    }
    private fun uploadCells() {
        cells.forEachIndexed { i, cell ->
            val art = cell.album?.let { artwork.get(coverKey(it)) }
            motion.target[i * 4 + 3] = art?.let { (it.slot + 1).toFloat() * if (it.ready) 1f else -1f } ?: 0f
        }
        materials.forEach { it.setParameter("cells", MaterialInstance.FloatElement.FLOAT4, motion.target, 0, ShelfLayout.COUNT) }
    }
    private fun coverKey(id: String) = "$id@${repository.coverVersion(id)}"
    private data class Tile(val id: String, val slot: Int, val pixels: ByteBuffer)
    @Suppress("DEPRECATION") // Texture.setImage in Filament 1.77.2 requires the nested descriptor.
    private fun rebuildCells(seconds: Float = 0f, dx: Float = 0f, dz: Float = 0f) {
        cells = ShelfLayout.cells(columns, lane, row, filled)
        motion.retarget(cells, placement.target.toFloat(), animationTime.toFloat(), seconds, dx, dz)
        val assigned = artwork.bind(cells.mapNotNull { it.album?.let(::coverKey) })
        val missing = assigned.filterNot { it.ready }.map { it.id to it.slot }
        artLoads = missing.size
        uploadPose()
        val revision = ++artRevision
        val wanted = selected
        val selectedKey=coverKey(wanted)
        val loadSelected = selectedKey != loadedSelected
        materials.forEach { it.setParameter("selectedReady", if (loadSelected) 0f else 1f) }
        artWorker.execute {
            if (closed || revision != artRevision) return@execute
            try {
                val bytes = if (loadSelected) wanted.removePrefix("device-album-").toLongOrNull()?.let(repository::cover) else null
                val full = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                if (full != null) {
                    val bitmap = coverBitmap(full, 512, wanted); full.recycle()
                    val pixels = rgba(bitmap); bitmap.recycle()
                    handler.post {
                        if (!closed && revision == artRevision) {
                            selectedCover.setImage(engine, 0, Texture.PixelBufferDescriptor(pixels, Texture.Format.RGBA, Texture.Type.UBYTE))
                            selectedCover.generateMipmaps(engine)
                            loadedSelected = selectedKey
                            materials.forEach { it.setParameter("selectedReady", 1f) }; dirty = true; requestFrame()
                        }
                    }
                }
                var batch = mutableListOf<Tile>()
                fun postTiles() {
                    val upload = batch.toList(); batch = mutableListOf()
                    handler.post {
                        if (!closed && revision == artRevision) {
                            upload.forEach { tile ->
                                if (artwork.ready(tile.id, tile.slot)) {
                                    atlas.setImage(engine, 0, tile.slot % 16 * 128,
                                        tile.slot / 16 * 128, 128, 128, Texture.PixelBufferDescriptor(tile.pixels, Texture.Format.RGBA, Texture.Type.UBYTE))
                                    atlasMipsDirty = true
                                }
                            }
                            uploadCells(); dirty = true; requestFrame()
                        }
                    }
                }
                for ((key, slot) in missing.sortedBy { if(it.first==selectedKey)0 else 1 }) {
                    val id=key.substringBeforeLast('@')
                    if (closed || revision != artRevision) return@execute
                    val bytes = id.removePrefix("device-album-").toLongOrNull()?.let(repository::cover)
                    val source = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size, BitmapFactory.Options().apply { inSampleSize = 4 }) }
                    val bitmap = coverBitmap(source, 128, id); source?.recycle()
                    val pixels = rgba(bitmap); bitmap.recycle()
                    batch.add(Tile(key, slot, pixels))
                    if (batch.size == 4) postTiles()
                }
                if (batch.isNotEmpty()) postTiles()
            } catch (error: Exception) {
                RhineLog.error("cover-loading", error)
                handler.post { if (!closed) send(JSONObject().put("type", "scene-warning").put("error", "部分封面无法读取，保留已加载封面。")) }
            }
        }
    }
    private fun coverBitmap(source: Bitmap?, size: Int, id: String): Bitmap {
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawColor(Color.rgb(194, 195, 187))
        if (source != null) drawCover(canvas, source, 0f, 0f, size.toFloat(), paint)
        else {
            paint.color = Color.rgb(72, 85, 83); paint.textSize = size / 12f
            canvas.drawText(repository.album(id)?.optString("title")?.take(12) ?: "LOCAL COLLECTION", size / 16f, size * .53f, paint)
        }
        return bitmap
    }
    private fun drawCover(canvas: Canvas, bitmap: Bitmap, left: Float, top: Float, size: Float, paint: Paint) {
        val scale = (size - 4) / max(bitmap.width, bitmap.height)
        val w = bitmap.width * scale; val h = bitmap.height * scale
        canvas.drawBitmap(bitmap, null, android.graphics.RectF(left + (size - w) / 2, top + (size - h) / 2,
            left + (size + w) / 2, top + (size + h) / 2), paint)
    }
    private fun rgba(bitmap: Bitmap): ByteBuffer {
        val colors = IntArray(bitmap.width * bitmap.height); bitmap.getPixels(colors, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val bytes = ByteBuffer.allocateDirect(colors.size * 4)
        colors.forEach { bytes.put((it shr 16).toByte()); bytes.put((it shr 8).toByte()); bytes.put(it.toByte()); bytes.put((it ushr 24).toByte()) }
        bytes.flip(); return bytes
    }
    private fun theme(value: Boolean, immediate: Boolean = false) {
        night = value
        themeMotion.to(if (value) 1.0 else 0.0, animationTime, if (reduced || immediate || skybox == null) 0.0 else .65)
        if (skybox == null) {
            val color = ArchivePalette.channels(themeValue).map(ArchivePalette::linear)
            skybox = Skybox.Builder().color(color[0],color[1],color[2],1f).build(engine).apply {
                setLayerMask(0xff, 0xff)
            }
            scene.skybox = skybox
        }
        dirty = true; requestFrame()
    }
    private fun updateLayers() {
        view.setVisibleLayers(0xff, if (hidden) 0 else if (introTime != null) 2 else 1)
        updateDepthOfField()
    }
    private fun updateDepthOfField() {
        view.depthOfFieldOptions = View.DepthOfFieldOptions().apply {
            enabled = introTime == null && (focusDepth || experimentalOptics)
            // Compensate for the model's large units, then keep the stable effect within 1 / 2 pixels.
            cocScale = if (experimentalOptics) 32f else 12f; nativeResolution = false
            foregroundRingCount = 3; backgroundRingCount = 3; fastGatherRingCount = 2
            maxForegroundCOC = if (experimentalOptics) 4 else 1
            maxBackgroundCOC = if (experimentalOptics) 6 else 2
        }
    }
    private fun currentSpan() = cameraMotion.pose?.span?.coerceAtLeast(.1) ?: 7.33
    private fun updateCamera() {
        val target = ArchivePose.camera(width,height,detail().toDouble(),overview().toDouble(),introTime)
        val pose = cameraMotion.sample(target,animationTime,reduced)
        cameraMoving = cameraMotion.moving
        val p = pose.position; val a = pose.aim
        camera.lookAt(p[0],p[1],p[2],a[0],a[1],a[2])
        val distance = sqrt((0..2).sumOf { (p[it]-a[it]).pow(2) }).coerceAtLeast(1.0)
        val fov = 2*atan(currentSpan()/(2*distance))*180/PI
        camera.setProjection(fov,width.toDouble()/height,.1,400.0,Camera.Fov.VERTICAL)
        if (focusDepth || experimentalOptics) {
            val focus = if (introTime != null) a else doubleArrayOf(
                motion.sample(ShelfLayout.SELECTED,0,animationTime.toFloat()).position + .17*cos(rotation.toDouble()),
                motion.sample(ShelfLayout.SELECTED,1,animationTime.toFloat()).position + 1.85,
                motion.sample(ShelfLayout.SELECTED,2,animationTime.toFloat()).position - .17*sin(rotation.toDouble()))
            camera.setFocusDistance(ArchivePose.focusDistance(pose,focus).toFloat())
        }
    }
    private fun project(x: Double, y: Double, z: Double): DoubleArray {
        val point = doubleArrayOf(x, y, z, 1.0)
        val view = camera.getViewMatrix(null); val projection = camera.getProjectionMatrix(null)
        fun multiply(m: DoubleArray, p: DoubleArray) = DoubleArray(4) { r -> (0..3).sumOf { c -> m[c * 4 + r] * p[c] } }
        val clip = multiply(projection, multiply(view, point))
        return doubleArrayOf((clip[0] / clip[3] + 1) / 2, (1 - clip[1] / clip[3]) / 2)
    }
    private fun report(force: Boolean = false) {
        val phase = if (pendingReturn) "returning-center" else if (pendingSelection != null || cameraMoving || !placement.settled(animationTime) || !motion.settled(animationTime.toFloat())) {
            if (placement.target > .5) "placing" else "returning-array"
        } else if (placement.target > .5) "presented" else "archive"
        if (phase == "presented" && inspectStart < 0) {
            inspectStart = animationTime
            materials.forEach { it.setParameter("inspection", inspectStart.toFloat()) }
        }
        val state = "$phase:$selected"
        val now = System.nanoTime()
        if (!force && state == lastState && now - lastReport < 100_000_000) return
        lastState = state
        lastReport = now
        if (fpsEpoch == 0L) fpsEpoch = now
        if (now - fpsEpoch >= 1_000_000_000) { fps = (frames * 1_000_000_000.0 / (now - fpsEpoch)).roundToInt(); frames = 0; fpsEpoch = now }
        val labels = JSONArray()
        for (dx in -3..3) {
            if (columns.isEmpty()) break
            val actual = if (filled) Math.floorMod(lane + dx, columns.size) else lane + dx
            if (actual !in columns.indices) continue
            val slot = (dx + 3) * ShelfLayout.ROWS + ShelfLayout.ROWS / 2
            val time = animationTime.toFloat()
            val point = project(motion.sample(slot, 0, time).position.toDouble(),
                motion.sample(slot, 1, time).position.toDouble() + 1.85, motion.sample(slot, 2, time).position.toDouble())
            labels.put(JSONObject().put("lane", actual).put("x", point[0]).put("y", point[1]).put("count", columns[actual].size).put("row",12.0+cells[slot].physicalRow-motion.sample(slot,2,time).position/.62))
        }
        lastSnapshot = JSONObject().put("type", "scene-state").put("backend", engine.backend.name).put("phase", phase)
            .put("overview", overview().toDouble()).put("albumId", selected).put("fps", fps).put("instances", if (introTime != null) ShelfLayout.INTRO_COUNT else ShelfLayout.COUNT)
            .put("columns", labels).put("hardwareVulkanRequired", true).put("framesSubmitted", submitted).put("width", width).put("height", height).put("visibleCells", if (introTime != null) ShelfLayout.INTRO_COUNT else cells.count { it.album != null })
            .put("uniqueCells", cells.mapNotNull { it.album }.toSet().size).put("artLoads", artLoads)
            .put("experimentalOptics",experimentalOptics)
            .put("focusDepth",focusDepth)
            .put("virtualTime",animationTime).put("motionSpeed",animationSpeed).put("inspectionStart",inspectStart)
            .put("rotation",rotation).put("pendingReturn",pendingReturn).put("placement",detail()).put("cameraSpan",currentSpan()).put("introTime",introTime).put("introSpeed",introSpeed).put("idle",idleEnabled)
            .put("qualityScale", renderScale).put("renderWidth", (width * renderScale).roundToInt())
            .put("renderHeight", (height * renderScale).roundToInt())
        send(lastSnapshot)
    }
    private fun requestFrame() {
        if (!closed && resumed && !scheduled && swap != null) { scheduled = true; Choreographer.getInstance().postFrameCallback(frame) }
    }
    private fun draw(time: Long) {
        scheduled = false
        if (closed || !resumed || resizing || !ui.isReadyToRender || swap == null) return
        val realDt = if (frameTime == 0L) 0.0 else ((time-frameTime)/1e9).coerceIn(0.0,.05)
        frameTime = time
        val dt = realDt * if (introTime != null) 1.0 else animationSpeed
        animationTime += dt
        introTime = introTime?.let { min(27.12,it+realDt*introSpeed) }
        overviewMotion.update(overviewTarget,dt,6.5,reduced)
        val returning = pendingReturn || pendingSelection != null || placement.target < .5
        rotation = if (reduced) { if (returning) 0f else targetRotation } else if (returning) (rotation*exp(-dt*7)).toFloat().let { if (abs(it) < .001f) 0f else it }
            else (rotation+(targetRotation-rotation)*(1-exp(-dt*2.8))).toFloat()
        if (returning && rotation == 0f) {
            val selection = pendingSelection; pendingSelection = null
            if (selection != null) selection() else if (pendingReturn) animate(0f)
        }
        val drifting = idleEnabled && !reduced && !hidden && introTime==null && placement.target==0.0 && overviewTarget==0.0
        idleGain.update(if (drifting && animationTime-lastInteraction>2.5) 1.0 else 0.0,dt,4.0,reduced)
        themeValue = themeMotion.sample(animationTime).value.coerceIn(0.0,1.0)
        guideX.update(motion.sample(ShelfLayout.SELECTED,0,animationTime.toFloat()).position.toDouble(),dt,4.7438645/guideDuration,reduced)
        guideZ.update(motion.sample(ShelfLayout.SELECTED,2,animationTime.toFloat()).position.toDouble(),dt,4.7438645/guideDuration,reduced)
        val focusX=motion.sample(ShelfLayout.SELECTED,0,animationTime.toFloat()).position
        val focusZ=motion.sample(ShelfLayout.SELECTED,2,animationTime.toFloat()).position
        val color = ArchivePalette.channels(themeValue).map(ArchivePalette::linear)
        skybox?.setColor(color[0],color[1],color[2],1f)
        val paper = ArchivePalette.color(themeValue)
        if (paper != paperColor) {
            paperColor = paper; background(paper)
            clearOptions.setClearColor(color[0].toDouble(),color[1].toDouble(),color[2].toDouble(),1.0)
            renderer.clearOptions = clearOptions
        }
        materials.forEach {
            it.setParameter("clock",animationTime.toFloat())
            it.setParameter("rotation",rotation)
            it.setParameter("night",themeValue.toFloat())
            it.setParameter("focusCenter",focusX,focusZ)
            it.setParameter("idle",idleGain.value.toFloat())
            it.setParameter("opening",introTime?.toFloat() ?: -1f)
            it.setParameter("placement",detail())
            it.setParameter("guideCenter",guideX.value.toFloat(),guideZ.value.toFloat())
        }
        updateCamera()
        if (atlasMipsDirty) { atlas.generateMipmaps(engine); atlasMipsDirty = false }
        val visible = !hidden && (introTime != null || columns.any { it.isNotEmpty() })
        var presented = false
        if ((visible || dirty) && renderer.beginFrame(swap!!, time)) {
            renderer.render(view); renderer.endFrame(); frames++; submitted++; presented = true; settleFrames = max(0, settleFrames - 1)
        }
        dirty = !presented
        report()
        val inspectionMoving = inspectStart >= 0 && animationTime-inspectStart < 3.63
        if (dirty || !placement.settled(animationTime) || !motion.settled(animationTime.toFloat()) || cameraMoving ||
            !overviewMotion.settled(overviewTarget) || !themeMotion.settled(animationTime) || abs(rotation-targetRotation)>.001f || pendingReturn || pendingSelection!=null ||
            inspectionMoving || introTime != null || drifting || idleGain.value>.0001 || settleFrames>0) requestFrame()
    }
    fun resume() { frameTime = 0; resumed = true; dirty = true; requestFrame() }
    fun pause() { resumed = false; scheduled = false; Choreographer.getInstance().removeFrameCallback(frame) }
    override fun onNativeWindowChanged(surface: Surface) {
        swap?.let(engine::destroySwapChain)
        swap = engine.createSwapChain(surface, ui.swapChainFlags)
        this.surface.display?.let { display.attach(renderer, it) }
        dirty = true; requestFrame()
    }
    override fun onDetachedFromSurface() {
        handler.removeCallbacks(resizeCheck); resizing = false
        resizeFence?.let(engine::destroyFence); resizeFence = null
        display.detach()
        swap?.let { engine.destroySwapChain(it); engine.flushAndWait() }
        swap = null
    }
    override fun onResized(w: Int, h: Int) {
        if (closed || w <= 0 || h <= 0) return
        if (w == pendingWidth && h == pendingHeight && (resizing || w == width && h == height)) return
        pendingWidth = w; pendingHeight = h
        resizing = true; resizeWarning = false; resizeBegan = System.nanoTime()
        scheduled = false; Choreographer.getInstance().removeFrameCallback(frame)
        handler.removeCallbacks(resizeCheck)
        resizeFence?.let(engine::destroyFence)
        resizeFence = engine.createFence(); engine.flush()
        RhineLog.event("surface-resize-start", JSONObject().put("width", w).put("height", h))
        handler.post(resizeCheck)
    }
    private fun finishResize() {
        if (closed || !resizing) return
        val fence = resizeFence ?: return
        if (fence.wait(Fence.Mode.DONT_FLUSH, 0) == Fence.FenceStatus.TIMEOUT_EXPIRED) {
            if (!resizeWarning && System.nanoTime() - resizeBegan > 2_000_000_000) {
                resizeWarning = true; RhineLog.event("surface-resize-gpu-delay")
            }
            handler.postDelayed(resizeCheck, 4); return
        }
        engine.destroyFence(fence); resizeFence = null
        if (!surface.holder.surface.isValid || swap == null) { resizing = false; return }
        // Recreate after queued work completes; Vulkan then obtains the new native window extent.
        swap?.let(engine::destroySwapChain)
        swap = engine.createSwapChain(surface.holder.surface, ui.swapChainFlags)
        cameraMotion.resize(animationTime)
        width = pendingWidth; height = pendingHeight
        view.viewport = Viewport(0, 0, width, height)
        resizing = false; resolution(); updateCamera()
        settleFrames = 3; dirty = true; requestFrame(); report(true)
        RhineLog.event("surface-resize-finished", JSONObject().put("width", width).put("height", height)
            .put("milliseconds", (System.nanoTime() - resizeBegan) / 1_000_000))
    }
    fun snapshot(): JSONObject = JSONObject(lastSnapshot.toString()).put("resizing", resizing).put("skyboxLayerMask",skybox?.layerMask ?: 0).put("backgroundClear",clearOptions.clear)
        .put("surfaceWidth", surface.width).put("surfaceHeight", surface.height).put("qualityScale", qualityScale)
        .put("artLoads", artLoads)
    fun close() {
        if (closed) return
        closed = true; artRevision++; pause(); artWorker.shutdownNow(); handler.removeCallbacks(resizeCheck); ui.detach()
        entities.forEach { engine.destroyEntity(it); EntityManager.get().destroy(it) }
        materials.forEach(engine::destroyMaterialInstance)
        vertices.forEach(engine::destroyVertexBuffer); indices.forEach(engine::destroyIndexBuffer)
        textures.forEach(engine::destroyTexture)
        engine.destroyMaterial(glass); engine.destroyMaterial(opaque)
        skybox?.let(engine::destroySkybox)
        engine.destroyView(view); engine.destroyColorGrading(colorGrading); engine.destroyScene(scene)
        engine.destroyCameraComponent(camera.entity); EntityManager.get().destroy(camera.entity)
        engine.destroyRenderer(renderer); engine.destroy()
    }
}
