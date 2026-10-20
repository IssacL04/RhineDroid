import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { androidDemoLibrary } from '../src/android-demo-library.ts';

// This test checks WebView transparency with a native bridge fixture, not Android GPU performance.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const library = { ...androidDemoLibrary, genres: androidDemoLibrary.genres.map((genre,index)=>({...genre,name:index===0?'用于检查专辑分类名称过长时布局的风格名称':genre.name})), albums: Array.from({ length: 180 }, (_, index) => {
  const album = androidDemoLibrary.albums[index % androidDemoLibrary.albums.length];
  const id = `test-album-${index}`;
  return { ...album, title:index===0?'日光留声（Letters from the Sun）':album.title, id, artist: '用于检查窄屏布局的较长艺术家名称', tracks: album.tracks.map((track, n) => ({ ...track, title:index===179 && n===0?'远处定位歌曲179':index===0 && n===0?'用于检查窄屏长歌名的歌曲 — Letters from the Sun':track.title, id: `${id}-${n}`, albumId: id })) };
}) };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 749, height: 360 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://appassets.androidplatform.net/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/native/library') return route.fulfill({ json: { ...library, permission: true } });
    const name = path === '/' ? 'index.html' : path.slice(1);
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png' };
    try {
      await route.fulfill({ body: await readFile(new URL(`../dist/${name}`, import.meta.url)), contentType: types[name.split('.').at(-1)] || 'application/octet-stream' });
    } catch { await route.fulfill({ status: 404, body: 'Missing test asset' }); }
  });
  await page.addInitScript(() => {
    const saved=JSON.parse(localStorage.getItem('rhinedroid-preferences') || '{}');
    localStorage.setItem('rhinedroid-preferences', JSON.stringify({ reduced:new URL(location.href).searchParams.get('intro')==='0', theme:'day', sound:false, bgm:false, volume:0, soundVolume:0, bgmVolume:0, focusDepth:saved.focusDepth!==false, experimentalOptics:saved.experimentalOptics===true }));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.testReport = JSON.parse(text); } } });
    const AudioContext=window.AudioContext;
    window.testContexts=[];
    window.AudioContext=class extends AudioContext { constructor(...args) { super(...args); window.testContexts.push(this); } };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (type.startsWith('webgl')) throw new Error('The Android path must not create WebGL');
      return getContext.call(this, type, ...args);
    };
    const state = { type: 'scene-state', backend: 'VULKAN', phase: 'archive', albumId: '', overview: 0, framesSubmitted: 1,
      width: 1125, height: 540, columns: [], visibleCells: 217, uniqueCells: 12, experimentalOptics:false, focusDepth:true };
    const audio={songTransition:'fade-in-out',bgm:false,bgmVolume:0,volume:0,outputDevice:'default',outputDevices:[{id:'default',name:'跟随系统输出'},{id:'usb-fixture',name:'USB 测试输出'}]};
    const player={track:null,queue:[],currentIndex:-1,playing:false,loading:false,currentTime:0,duration:0,transport:'idle'};
    window.addEventListener('rhine-native',event=>{if(event.detail.type==='player') Object.assign(player,event.detail);});
    const emit = detail => window.dispatchEvent(new CustomEvent('rhine-native', { detail }));
    window.testMessages=[];
    window.RhineHost = { postMessage(raw) {
      const message = JSON.parse(raw);
      window.testMessages.push(message);
      if (message.type === 'export-log') window.testExport = message.diagnostics;
      queueMicrotask(() => {
        if (message.type === 'scene-library') state.albumId = message.selectedId;
        if (message.type === 'scene-select') state.albumId = message.albumId;
        if (message.type === 'scene-mode') state.phase = message.mode === 'detail' ? 'presented' : 'archive';
        if (message.type === 'scene-overview') state.overview = Number(message.active);
        if (message.type === 'scene-optics') state.experimentalOptics = message.value;
        if (message.type === 'scene-focus') state.focusDepth = message.value;
        if (message.type.startsWith('scene-')) emit({ ...state });
        if(['ready','audio-settings','audio-outputs'].includes(message.type)) {
          for(const key of ['songTransition','bgm','bgmVolume','volume','outputDevice']) if(key in message)audio[key]=message[key];
          emit({...player,type:'player',volume:audio.volume,audio:{...audio}});
        }
        if (message.id) emit({ type:'response', id:message.id, result:message.type==='library-api' ? { musicBrainzContact:'',musicBrainzConfigured:false,onlineEnabled:false } : undefined });
      });
    } };
  });
  // CSS can finish before the app module on a cold WebView; the bare stage must already fill the window.
  let releaseApp;
  const appHeld=new Promise(resolve=>{releaseApp=resolve;});
  const stallApp=async route=>{await appHeld;await route.fallback();};
  await page.route('**/assets/music-app-*.js',stallApp);
  await page.goto('https://appassets.androidplatform.net/index.html?renderer=vulkan&intro=0',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#stage')).position==='absolute');
  const initialStage=await page.locator('#stage').evaluate(node=>{
    const rect=node.getBoundingClientRect();return {left:rect.left,top:rect.top,width:rect.width,height:rect.height,color:getComputedStyle(node).backgroundColor};
  });
  assert.deepEqual(initialStage,{left:0,top:0,width:749,height:360,color:'rgba(0, 0, 0, 0)'},'No quarter-screen block while the app module is still loading');
  const legacyStage=await page.locator('#stage').evaluate(node=>{
    node.classList.remove('music-app');const rect=node.getBoundingClientRect();node.classList.add('music-app');return {left:rect.left,top:rect.top};
  });
  assert.deepEqual(legacyStage,{left:374.5,top:180},'The old bare stage reproduces the bottom-right block');
  releaseApp();
  await page.unroute('**/assets/music-app-*.js',stallApp);
  await page.waitForFunction(() => window.rhineDroid?.stats()?.backend === 'VULKAN' && !document.querySelector('#music-loading'));
  async function roundedControls() {
    const corners=await page.evaluate(()=>['.theme-switch','.minimal-transport','.music-panel','#now-playing','#now-cover','#now-toggle'].flatMap(selector=>
      [...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length && getComputedStyle(node).visibility!=='hidden')
      .map(node=>({selector,radius:getComputedStyle(node).borderRadius}))));
    const expected={'.theme-switch':'8px','.minimal-transport':'8px','.music-panel':'12px','#now-playing':'12px','#now-cover':'6px','#now-toggle':'50%'};
    for(const corner of corners) assert.equal(corner.radius,expected[corner.selector],`${corner.selector} has the requested small corner or circular play button`);
    assert.equal(await page.locator('.theme-switch').evaluate(node=>getComputedStyle(node,'::before').borderRadius),'5px');
  }
  await roundedControls();
  async function inspect(label, x, y) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layers = await page.evaluate(() => {
      const result = [];
      for (let node = document.querySelector('#three-scene'); node; node = node.parentElement) {
        const style = getComputedStyle(node);
        result.push({ node: node.id || node.tagName.toLowerCase(), color: style.backgroundColor, image: style.backgroundImage });
      }
      return result;
    });
    console.log(label, layers);
    const png = await page.screenshot({ omitBackground: true, scale: 'css' });
    const hideControls = await page.addStyleTag({ content: '#stage .music-header, #stage .music-header * { visibility: hidden !important; }' });
    // Let compositor layers commit the hidden state before taking the baseline.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const background = await page.screenshot({ omitBackground: true, scale: 'css' });
    await hideControls.evaluate(element => element.remove());
    const { pixel, controls } = await page.evaluate(async ({ png, background, x, y }) => {
      async function decode(data) {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return { ctx, width: image.width, height: image.height };
      }
      const actual = await decode(png), blank = await decode(background);
      const pixel = [...actual.ctx.getImageData(Math.round(x * actual.width), Math.round(y * actual.height), 1, 1).data];
      const controls = ['.music-brand strong', '[data-action="settings"]', '#play-pause'].map(selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        const left = Math.max(0, Math.floor(box.left)), top = Math.max(0, Math.floor(box.top));
        const width = Math.min(actual.width - left, Math.ceil(box.width)), height = Math.min(actual.height - top, Math.ceil(box.height));
        let painted = 0;
        if (width > 0 && height > 0) {
          const pixels = actual.ctx.getImageData(left, top, width, height).data;
          const baseline = blank.ctx.getImageData(left, top, width, height).data;
          for (let i = 0; i < pixels.length; i += 4) {
            const delta = [0, 1, 2].map(c => Math.abs(pixels[i + c] * pixels[i + 3] / 255 - baseline[i + c] * baseline[i + 3] / 255));
            if (Math.max(...delta, Math.abs(pixels[i + 3] - baseline[i + 3])) >= 24) painted++;
          }
        }
        return { selector, painted };
      });
      return { pixel, controls };
    }, { png: png.toString('base64'), background: background.toString('base64'), x, y });
    console.log(`${label} shelf pixel RGBA=${pixel}`);
    assert(pixel[3] < 250, `${label}: native shelf area is obscured, RGBA=${pixel}`);
    console.log(label, 'painted controls', controls);
    assert(controls.every(control => control.painted >= 8), `${label}: UI controls are blank: ${JSON.stringify(controls)}`);
    assert(layers.every(layer => layer.color === 'rgba(0, 0, 0, 0)' && layer.image === 'none'),
      `Every ancestor of the native scene must be transparent: ${JSON.stringify(layers)}`);
    await writeFile(join(tmpdir(), `rhine-vulkan-composition-${label}.png`), png);

  }
  await inspect('landscape', .22, .45);
  const opaque = await page.addStyleTag({ content: 'html[data-renderer="vulkan"] #viewport { background: #e8e5e1; }' });
  await assert.rejects(inspect('opaque-control', .22, .45), /native shelf area is obscured/, 'Reintroducing the v0.3.0 background must fail the pixel check');
  await opaque.evaluate(element => element.remove());
  const blankUi = await page.addStyleTag({ content: '#stage .music-header, #stage .music-header * { visibility: hidden !important; }' });
  await assert.rejects(inspect('blank-ui-control', .22, .45), /UI controls are blank/, 'A transparent page with missing controls must fail too');
  await blankUi.evaluate(element => element.remove());
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await roundedControls();
  assert.equal(await page.locator('#album-search').evaluate(node=>getComputedStyle(node).borderRadius),'6px');
  await page.locator('.music-panel').screenshot({path:join(tmpdir(),'rhine-vulkan-search-small-corners.png'),scale:'css'});
  await page.locator('[data-action="close-panel"]').click();
  await page.locator('[data-action="settings"]').click();
  await roundedControls();
  assert.equal(await page.locator('#experimental-optics-settings').count(),0,'Stable settings omit the RC experiment');
  assert.equal(await page.evaluate(()=>window.testMessages.filter(message=>message.type==='scene-optics').length),0);
  await page.locator('.music-panel').screenshot({path:join(tmpdir(),'rhine-vulkan-settings-small-corners.png'),scale:'css'});
  await page.locator('[data-action="copy-performance"]').click();
  await page.waitForFunction(() => !!window.testReport);
  const report = await page.evaluate(() => window.testReport);
  assert.equal(report.frame.scope, 'web-ui');
  assert(report.composition.some(layer => layer.element === 'viewport' && layer.backgroundColor === 'rgba(0, 0, 0, 0)'));
  assert(!Object.hasOwn(report.render, 'drawCalls'), 'Do not publish a fixed number as a measured draw call count');
  assert(report.render.framesSubmitted > 0, 'Export the actual native counter');
  assert.equal(await page.locator('#focus-depth').isChecked(),true);
  await page.locator('#focus-depth').uncheck();
  await page.waitForFunction(()=>window.rhineDroid.stats().focusDepth===false);
  await page.locator('#focus-depth').check();
  await page.waitForFunction(()=>window.rhineDroid.stats().focusDepth===true);
  await page.locator('#sound-setting').check();
  await page.locator('[data-action="sound-preview"]').click();
  await page.waitForFunction(()=>window.testContexts.length>0);
  await page.evaluate(()=>window.rhineAndroid.suspend());
  await page.waitForFunction(()=>window.testContexts.every(context=>context.state==='suspended'));
  await page.evaluate(()=>window.rhineAndroid.resume());
  await page.waitForFunction(()=>window.testContexts.some(context=>context.state==='running'));
  await page.locator('#sound-setting').uncheck();
  await page.locator('#song-fade-setting').selectOption('gapless');
  await page.waitForFunction(() => window.testMessages.some(message=>message.type==='audio-settings' && message.songTransition==='gapless'));
  await page.locator('#bgm-setting').check();
  await page.waitForFunction(() => window.testMessages.some(message=>message.type==='audio-settings' && message.bgm===true));
  await page.locator('#native-audio-device').selectOption('usb-fixture');
  await page.waitForFunction(() => window.testMessages.some(message=>message.type==='audio-settings' && message.outputDevice==='usb-fixture'));
  await page.locator('#native-motion-speed').fill('1.5');
  await page.waitForFunction(() => window.testMessages.some(message=>message.type==='scene-speed' && message.value===1.5));
  await page.locator('#native-motion-speed').fill('1');
  await page.locator('[data-native-light="strength"]').fill('1.6');
  await page.waitForFunction(() => window.testMessages.some(message=>message.type==='scene-lighting' && message.strength===1.6));
  await page.locator('[data-action="export-log"]').click();
  await page.waitForFunction(() => !!window.testExport);
  assert.equal(await page.evaluate(() => window.testExport.render.backend), 'VULKAN');
  await page.locator('[data-action="close-panel"]').click();
  await page.locator('button[data-theme="night"]').click();
  await inspect('landscape-night', .16, .45);
  await page.setViewportSize({ width: 360, height: 749 });
  await inspect('portrait-night', .5, .35);
  await page.locator('[data-action="settings"]').click();
  await page.locator('.theme-cards button[data-theme="day"]').click();
  await page.locator('[data-action="close-panel"]').click();
  await inspect('portrait', .5, .35);
  for (const width of [320, 360, 393, 412]) {
    await page.setViewportSize({ width, height: 749 });
    const boxes = await page.evaluate(() => {
      const box = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width };
      };
      return { album:box('.album-stepper'), genre:box('.genre-stepper'), ruler:box('#album-ticks'),
        buttons:[...document.querySelectorAll('.album-stepper > button, .genre-stepper > button')].map(button => {
          const r = button.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom };
        }) };
    });
    assert(boxes.album.bottom <= boxes.genre.top, `${width}px: album and genre controls overlap`);
    for (const [label, box] of Object.entries(boxes).filter(([key]) => key !== 'buttons'))
      assert(box.left >= 0 && box.right <= width + 1, `${width}px: ${label} escapes screen: ${JSON.stringify(box)}`);
    for (const button of boxes.buttons) assert(button.right <= width && button.left >= 0, `${width}px: an arrow escapes screen`);
    assert(boxes.ruler.width > 0, 'The position ruler must remain visible for a large column');
  }
  // Exercise the animated layout path, including interrupted rotation transitions.
  await page.locator('[data-action="settings"]').click();
  await page.locator('#reduced-motion').uncheck();
  await page.locator('[data-action="close-panel"]').click();
  for (let n = 0; n < 3; n++) {
    await page.setViewportSize({ width:749, height:360 });
    await page.waitForTimeout(80);
    await page.setViewportSize({ width:360, height:749 });
    await page.waitForTimeout(80);
  }
  await page.setViewportSize({ width:749, height:360 });
  await page.waitForTimeout(500);
  await inspect('landscape-return', .22, .45);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#music-loading'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(650);
  const glyphLayout = () => page.evaluate(() => [...document.querySelectorAll('.music-title-slot')]
    .filter(node => getComputedStyle(node).visibility !== 'hidden')
    .map(node => ({ text:node.textContent, x:new DOMMatrix(getComputedStyle(node).transform).m41 })));
  const unscaled = await glyphLayout();
  assert(unscaled.length>0, "The title regression must measure visible glyphs");
  // Reproduce measuring a title inside the temporary scale used by rotation FLIP.
  const rotationScale = await page.addStyleTag({content:'.album-callout { transform:scale(1.8,.7) !important; transform-origin:0 0; }'});
  await page.setViewportSize({width:748,height:360});
  await page.waitForTimeout(80);
  await page.setViewportSize({width:749,height:360});
  await page.waitForTimeout(80);
  await rotationScale.evaluate(node => node.remove());
  await page.waitForTimeout(650);
  const restored = await glyphLayout();
  assert.equal(restored.length, unscaled.length, 'Rotation must preserve the title glyph count');
  restored.forEach((glyph,i) => assert(Math.abs(glyph.x-unscaled[i].x)<.6,
    `Rotation cached scaled glyph spacing: ${JSON.stringify({before:unscaled[i],after:glyph})}`));
  await page.getByRole('button', {name:'音乐库',exact:true}).click();
  await page.locator('[data-action="choose-folder"]').click();
  assert(await page.evaluate(()=>window.testMessages.some(message=>message.type==='choose-folder')));
  await page.locator('[data-action="close-panel"]').click();
  // Real WAAPI close frames must render before hidden=true, including rapid reversal.
  await page.locator('[data-action="settings"]').click();
  await page.locator('#reduced-motion').uncheck();
  await page.locator('[data-action="close-panel"]').click();
  await page.evaluate(track => window.dispatchEvent(new CustomEvent('rhine-native', {detail:{
    type:'player',track,queue:[track.id],currentIndex:0,playing:false,loading:false,currentTime:65,duration:200,volume:0,transport:'paused'
  }})), library.albums[0].tracks[0]);
  await page.locator('#transport-track').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').dataset.transition==='open');
  const playerThemes={};
  for(const theme of ['day','night']) {
    await page.locator(`.theme-switch button[data-theme="${theme}"]`).click();
    const expected=theme==='day'?'rgb(41, 43, 37)':'rgb(244, 246, 251)';
    await page.waitForFunction(color=>getComputedStyle(document.querySelector('#now-playing')).color===color,expected);
    await roundedControls();
    playerThemes[theme]=await page.locator('#now-playing').evaluate(node=>({base:getComputedStyle(node).backgroundColor,ink:getComputedStyle(node).color,scheme:getComputedStyle(node).colorScheme}));
    await page.locator('#now-playing').screenshot({path:join(tmpdir(),`rhine-vulkan-player-${theme}.png`),omitBackground:true,scale:'css'});
  }
  assert.notEqual(playerThemes.day.base,playerThemes.night.base,'Warm-day and dark-night players must use distinct base colors');
  assert.equal(playerThemes.day.scheme,'light');assert.equal(playerThemes.night.scheme,'dark');
  assert.equal(await page.evaluate(()=>[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).some(rule=>
    rule.selectorText?.includes('#now-seek::-webkit-slider-thumb') && rule.style.width==='10px' && rule.style.height==='10px' && rule.style.borderRadius==='50%')),true,'The progress handle is a circle');
  await page.locator('.theme-switch button[data-theme="day"]').click();
  assert.equal(await page.locator('#now-seek').evaluate(input=>input.style.getPropertyValue('--fill')), '32.5%');
  assert.equal(await page.locator('.now-collapse, #now-output, [data-action="playback-outputs"]').count(),0);
  for(const id of ['now-seek','now-volume']) {
    const style=await page.locator(`#${id}`).evaluate(input=>{
      input.focus({preventScroll:true});
      const outer=getComputedStyle(input),track=getComputedStyle(input,'::-webkit-slider-runnable-track');
      return {border:outer.borderWidth,outline:outer.outlineStyle,trackBorder:track.borderWidth,shadow:track.boxShadow};
    });
    assert.deepEqual(style,{border:'0px',outline:'none',trackBorder:'0px',shadow:'none'},'Sliders have no rectangular focus border or track outline');
  }
  const playerLayout=await page.locator('#now-playing').evaluate(root=>{
    const box=root.getBoundingClientRect(), elements=[...root.querySelectorAll('button,input')];
    return {height:box.height,width:box.width,scroll:root.scrollHeight-root.clientHeight,items:elements.map(node=>{
      const r=node.getBoundingClientRect();return {id:node.id || node.getAttribute('aria-label'),left:r.left-box.left,right:r.right-box.left,top:r.top-box.top,bottom:r.bottom-box.top};
    })};
  });
  assert(playerLayout.scroll<=1,`All compact player controls must be visible: ${JSON.stringify(playerLayout)}`);
  assert(playerLayout.items.every(box=>box.left>=0 && box.right<=playerLayout.width+1 && box.top>=0 && box.bottom<=playerLayout.height+1));

  const fixedLayers=await page.evaluate(()=>[document.documentElement,document.body,document.querySelector('#viewport'),document.querySelector('#stage')].map(node=>({id:node.id,left:node.scrollLeft,top:node.scrollTop})));
  assert(fixedLayers.every(layer=>layer.left===0 && layer.top===0), `Focus or rotation scrolled a fixed layer: ${JSON.stringify(fixedLayers)}`);
  await page.screenshot({path:join(tmpdir(),'rhine-vulkan-now-playing-glass.png'),omitBackground:true,scale:'css'});
  await page.locator('#now-playing').screenshot({path:join(tmpdir(),'rhine-vulkan-now-playing-card.png'),omitBackground:true,scale:'css'});
  const closing=await page.evaluate(()=>{
    document.querySelector('#now-playing [data-action="toggle-now-playing"]').click();
    const root=document.querySelector('#now-playing');
    for(const animation of root.getAnimations()) {animation.pause();animation.currentTime=animation.effect.getTiming().duration/2;}
    const style=getComputedStyle(root);
    return {hidden:root.hidden,inert:root.inert,phase:root.dataset.transition,opacity:Number(style.opacity),scale:new DOMMatrix(style.transform).a};
  });
  assert.equal(closing.hidden,false); assert.equal(closing.inert,true); assert.equal(closing.phase,'closing');
  assert(closing.opacity>0 && closing.opacity<1 && closing.scale<1, 'The closing panel must visibly fade and shrink');
  await page.locator('#now-playing').evaluate(root=>root.getAnimations().forEach(animation=>animation.play()));
  await page.waitForFunction(()=>document.querySelector('#now-playing').hidden);
  await page.evaluate(()=>{
    document.querySelector('#transport-track').click();
    document.querySelector('#now-playing [data-action="toggle-now-playing"]').click();
    document.querySelector('#transport-track').click();
  });
  await page.waitForFunction(()=>document.querySelector('#now-playing').dataset.transition==='open');
  assert.equal(await page.locator('#now-playing').evaluate(root=>root.hidden || root.inert),false);
  await page.locator('#now-volume').evaluate(input=>{input.value='.42';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>window.testMessages.some(message=>message.type==='volume' && message.volume===.42));
  assert.equal(await page.locator('#now-volume').evaluate(input=>input.style.getPropertyValue('--fill')),'42%');
  await page.locator('#now-seek').evaluate(input=>{input.value='100';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>window.testMessages.some(message=>message.type==='seek' && message.seconds===100));
  assert.equal(await page.locator('#now-seek').evaluate(input=>input.style.getPropertyValue('--fill')),'50%');
  await page.setViewportSize({width:360,height:749});
  await page.waitForTimeout(300);
  await page.screenshot({path:join(tmpdir(),'rhine-vulkan-now-playing-glass-portrait.png'),omitBackground:true,scale:'css'});
  await page.locator('.now-metadata').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').hidden);

  // Measure whole touch targets: their centers can be clear while their edges overlap.
  async function checkControls(label, navigation = true) {
    const boxes = await page.evaluate(navigation => {
      const selectors = '.music-brand,.music-topnav > button,.theme-switch button,.minimal-transport > button' +
        (navigation ? ',.album-stepper > button,.genre-stepper > button,#genre-name,.open-album,.music-view-toggle' : '');
      return [...document.querySelectorAll(selectors)].filter(node => node.getClientRects().length &&
        getComputedStyle(node).visibility !== 'hidden' && !node.disabled).map(node => {
        const r = node.getBoundingClientRect();
        return {id:node.id || node.dataset.action || node.getAttribute('aria-label'), left:r.left, right:r.right, top:r.top, bottom:r.bottom,
          hits:[[.15,.5],[.5,.5],[.85,.5]].every(([x,y])=>node.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))};
      });
    }, navigation);
    const {width,height} = page.viewportSize();
    for(const [i,box] of boxes.entries()) {
      assert(box.left>=0 && box.right<=width+.5 && box.top>=0 && box.bottom<=height+.5, `${label}: control outside viewport: ${JSON.stringify(box)}`);
      assert(box.hits, `${label}: a touch target is covered: ${JSON.stringify(box)}`);
      for(const other of boxes.slice(i+1)) assert(
        Math.min(box.right,other.right)-Math.max(box.left,other.left)<=.5 || Math.min(box.bottom,other.bottom)-Math.max(box.top,other.top)<=.5,
        `${label}: ${box.id} overlaps ${other.id}`);
    }
  }
  for(const [width,height] of [[480,300],[568,320],[640,360],[749,360],[915,412],[1024,600],[320,749],[360,749],[393,749],[412,915],[600,600]]) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(300);
    await page.locator('.open-album').scrollIntoViewIfNeeded();
    await checkControls(`${width}x${height}, long playing title and genre`);
  }
  await page.locator('#transport-track').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').dataset.transition==='open');
  for(const [width,height] of [[749,360],[360,749],[749,360],[320,749]]) {
    await page.setViewportSize({width,height});
    await page.waitForFunction(([w,h])=>document.querySelector('#stage').dataset.layout===(w/h<1.05?'portrait':'compact'),[width,height]);
    const starts=await page.evaluate(()=>['.music-navigation','#now-playing'].map(selector=>{
      const node=document.querySelector(selector), animation=node.getAnimations()[0];
      if(animation){animation.pause();animation.currentTime=0;}
      const r=node.getBoundingClientRect(), box={selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom};
      animation?.play();return box;
    }));
    for(const box of starts) assert(box.left>=0 && box.right<=width+.5 && box.top>=0 && box.bottom<=height+.5,
      `Rotation starts outside ${width}x${height}: ${JSON.stringify(box)}`);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#now-playing').isVisible(),true);
    await checkControls(`${width}x${height}, expanded player`,false);
    await page.locator('[data-action="settings"]').click();
    await page.locator('[data-action="close-panel"]').click();
  }
  await page.locator('.now-metadata').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').hidden);
  // Simulate the smaller WebView rectangle supplied by Android when the keyboard opens.
  await page.setViewportSize({width:360,height:749});
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await page.setViewportSize({width:360,height:380});
  await page.locator('#album-search').fill('日光');
  await page.waitForFunction(()=>document.querySelectorAll('.album-result').length>0);
  await page.locator('[data-action="close-panel"]').click();
  await page.setViewportSize({width:360,height:749});

  // A cold page plays the prologue by default. Resuming it must retain progress.
  const playsBeforeSearch=await page.evaluate(()=>window.testMessages.filter(message=>message.type==='play').length);
  for(const [query,album,kind] of [['远处定位歌曲179','test-album-179','.song-result'],['日光留声','test-album-0','.album-result']]) {
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.locator('#album-search').fill(query);
    await page.locator(`${kind}[data-album="${album}"]`).first().click();
    await page.waitForFunction(id=>window.testMessages.some(message=>message.type==='scene-select' && message.albumId===id && message.immediate===true),album);
    await page.waitForFunction(()=>document.querySelector('#stage').dataset.mode==='detail');
  }
  assert.equal(await page.evaluate(()=>window.testMessages.filter(message=>message.type==='play').length),playsBeforeSearch,'Search locates tracks without starting audio');
  await page.setViewportSize({width:749,height:360});
  await page.goto('https://appassets.androidplatform.net/index.html?renderer=vulkan');
  await page.waitForFunction(()=>document.querySelector('#stage')?.dataset.musicBoot==='running');
  assert.equal(await page.locator('.music-boot-skip').count(),0);
  await page.waitForFunction(()=>Number(document.querySelector('.music-boot-overlay').dataset.appTime)>.9);
  assert(Number(await page.locator('.music-opening-mark').evaluate(node=>getComputedStyle(node).opacity))>.9);
  assert(await page.locator('.music-opening-mark svg').evaluate(node=>node.getBoundingClientRect().width>100));
  await page.screenshot({path:join(tmpdir(),'rhine-vulkan-opening-mark.png'),scale:'css'});
  await page.waitForFunction(()=>Number(document.querySelector('.music-boot-overlay').dataset.appTime)>2.1);
  const disc=await page.locator('[data-opening="orbit-turn"]').getAttribute('transform');
  assert.match(disc,/rotate\([1-9]/,'The restored disc must visibly turn');
  assert(Number(await page.locator('.music-opening-orbit').evaluate(node=>getComputedStyle(node).opacity))>.9);
  await page.screenshot({path:join(tmpdir(),'rhine-vulkan-opening-disc.png'),scale:'css'});
  await page.waitForFunction(()=>Number(document.querySelector('.music-boot-overlay').dataset.appTime)>.2);
  const beforeResume=await page.locator('.music-boot-overlay').evaluate(root=>Number(root.dataset.appTime));
  await page.evaluate(()=>{window.rhineAndroid.suspend();window.rhineAndroid.resume();});
  await page.waitForTimeout(100);
  const afterResume=await page.locator('.music-boot-overlay').evaluate(root=>Number(root.dataset.appTime));
  assert(afterResume>=beforeResume && afterResume-beforeResume<.3, 'Resume must neither restart nor fast-forward the opening');
  await page.waitForFunction(()=>window.testMessages.some(message=>message.type==='scene-intro' && message.active!==false),undefined,{timeout:15000});
  assert.equal(await page.evaluate(()=>window.testMessages.find(message=>message.type==='scene-intro' && message.active!==false).speed),1.3);
  await page.waitForFunction(()=>document.querySelector('#stage').dataset.musicBoot==='done',undefined,{timeout:20000});
  assert.equal(await page.locator('.music-boot-overlay').evaluate(root=>root.hidden),true);
  await page.goto('https://appassets.androidplatform.net/index.html?renderer=vulkan&intro=0&optics=rc&version=0.4.8-rc');
  await page.waitForFunction(()=>!document.querySelector('#music-loading'));
  await page.locator('[data-action="settings"]').click();
  assert.equal(await page.locator('#experimental-optics').isChecked(),false,'RC optics start disabled');
  assert(await page.locator('#panel-body').textContent().then(text=>text.includes('0.4.8-rc')),'Display the APK version instead of the shared Web bundle version');
  await page.locator('#experimental-optics').check();
  await page.waitForFunction(()=>window.rhineDroid.stats().experimentalOptics===true);
  await page.locator('#focus-depth').uncheck();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('rhinedroid-preferences')).experimentalOptics),true);
  await page.reload();
  await page.waitForFunction(()=>!document.querySelector('#music-loading') && window.rhineDroid.stats().experimentalOptics===true && window.rhineDroid.stats().focusDepth===false);
  await page.locator('[data-action="settings"]').click();
  assert.equal(await page.locator('#experimental-optics').isChecked(),true,'Keep the RC setting after reload');
  assert.equal(await page.locator('#focus-depth').isChecked(),false,'Keep the focus setting after reload');
  await page.locator('#focus-depth').check();
  await page.locator('#experimental-optics').uncheck();
  await page.waitForFunction(()=>window.rhineDroid.stats().experimentalOptics===false);
  await page.locator('[data-action="export-log"]').click();
  await page.waitForFunction(()=>!!window.testExport);
  assert.equal(await page.evaluate(()=>window.testExport.version),'0.4.8-rc-startup');
  assert.equal(await page.evaluate(()=>window.testExport.render.experimentalOptics),false);
  await page.goto('https://appassets.androidplatform.net/index.html?renderer=vulkan&intro=0');
  await page.waitForFunction(()=>!document.querySelector('#music-loading'));
  await page.locator('[data-action="settings"]').click();
  assert.equal(await page.locator('#experimental-optics-settings').count(),0);
  assert.equal(await page.evaluate(()=>window.testMessages.filter(message=>message.type==='scene-optics').length),0,'Stable startup never sends RC commands');
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#three-scene canvas').count(), 0);
  console.log('Vulkan composition passed: cold startup, transparency, both themes, navigation, whole touch targets at 11 viewport sizes, bounded rotation frames, expanded-player settings access, keyboard-sized search, titles, player animations, default opening, search/track jumps without rail travel or autoplay, persistent focus toggle, RC isolation, native diagnostics, log export and negative controls. This does not exercise an Android SurfaceView.');
} finally { await browser.close(); }
