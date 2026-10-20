import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/native-archive-scene.ts', import.meta.url), 'utf8');
const introSpeed=Number((await readFile(new URL('../src/music-boot-timing.ts',import.meta.url),'utf8')).match(/MUSIC_BOOT_SCENE_SPEED = ([\d.]+)/)[1]);
const tree = ts.createSourceFile('native-archive-scene.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const klass = tree.statements.find(node => ts.isClassDeclaration(node));
const code = ts.transpileModule(klass.getText(tree).replace('export class', 'class'), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const messages = [], records = Array.from({length:10000}, (_,i)=>({id:`device-album-${i}`}));
const archiveColumns = ['设备音乐'];
const target = new EventTarget(), container = new EventTarget();
Object.assign(container, {dataset:{},style:{},clientWidth:800,clientHeight:400,setAttribute(){},setPointerCapture(){},
  getBoundingClientRect:()=>({left:0,top:0,width:800,height:400})});
let serial = 0;
const raf = new Map();
const speedListeners=new Set();
const NativeArchiveScene = new Function('window','nativeCommand','records','archiveColumns','columnFiles','fileLocation',
  'decryptionFrame','DECRYPTION_END','swipeDirection','requestAnimationFrame','cancelAnimationFrame','getMusicMotionSpeed','onMusicMotionSpeedChange','DECRYPTION_START','MUSIC_BOOT_SCENE_SPEED',
  `${code}; return NativeArchiveScene`)(target, async (type,data)=>messages.push({type,...data}), records,
    archiveColumns,()=>records.map((_,i)=>i),()=>({lane:0,row:12}),time=>({time}),40,
    (x,y)=>Math.abs(x)>36?{axis:'lane',direction:1}:null,
    callback=>{const id=++serial;raf.set(id,callback);return id;},id=>raf.delete(id),()=>1,fn=>{speedListeners.add(fn);return()=>speedListeners.delete(fn);},34.12,introSpeed);
const emit = detail=>target.dispatchEvent(new CustomEvent('rhine-native',{detail}));
const state = (extra={})=>emit({type:'scene-state',backend:'VULKAN',phase:'archive',albumId:records[0].id,
  overview:0,framesSubmitted:1,width:800,height:400,columns:[],...extra});
const scene = new NativeArchiveScene(container);
await scene.load(undefined,9999);
assert.equal(messages.at(-1).columns[0].length,10000);
assert.equal(messages.at(-1).selectedId,'device-album-9999');
let prepared = false;
const preparing = scene.prepareMusicRenderer().then(()=>{prepared=true;});
state({framesSubmitted:0}); await Promise.resolve(); await Promise.resolve();
assert.equal(prepared,false,'Backend initialization alone is not a submitted Vulkan frame');
state(); await preparing;
assert.equal(JSON.parse(container.dataset.startupPreparation).backend,'VULKAN');
const before = messages.length;
for(let n=0;n<20;n++)scene.resize();
assert.equal(messages.length,before,'Surface callbacks already report rotation; DOM resize must not duplicate native work');
for(let frame=0;frame<600;frame++)scene.update(frame/60);
assert.equal(messages.length,before,'UI frames never upload instance matrices or issue draw commands');
scene.setMode('detail');
assert.equal(scene.musicPresentationReady,false);
state({phase:'presented',albumId:records[9999].id});
assert.equal(scene.musicPresentationReady,true);
state({phase:'placing',albumId:records[9999].id,inspectionStart:1,virtualTime:6,motionSpeed:1});
assert(scene.decryptionFrame.time>40,'Rotating an already inspected album must retain its clear text');
state({phase:'placing',albumId:records[9999].id,inspectionStart:-1,virtualTime:6});
assert.equal(scene.decryptionFrame.time,-1,'An uninspected album still waits for placement');
scene.switchMusicAlbum(42);
assert.equal(scene.musicPresentationReady,false,'Switching albums invalidates the previous presentation');
state({phase:'presented',albumId:records[9999].id});
assert.equal(scene.musicPresentationReady,false,'A stale album cannot open the next album menu');
state({phase:'presented',albumId:records[42].id});
assert.equal(scene.musicPresentationReady,true);
scene.select(43, {axis:'row',direction:1});
assert.deepEqual(messages.at(-1), {type:'scene-select',albumId:records[43].id,axis:'row',direction:1}, 'Keep last-to-first navigation travelling in the requested direction');
scene.select(42, {axis:'row',direction:-1});
assert.equal(messages.at(-1).direction,-1);
scene.select(9999,undefined,true);
assert.deepEqual(messages.at(-1),{type:'scene-select',albumId:records[9999].id,immediate:true},'Search jumps never animate the intervening row or column');
scene.setFocusDepth(false);
assert.deepEqual(messages.at(-1),{type:'scene-focus',value:false});
state({focusDepth:false});assert.equal(scene.getStats().focusDepth,false);
scene.setFocusDepth(true);
scene.setMode('archive');
state({columns:[{lane:0,x:.1,y:.5,count:10000},{lane:0,x:.5,y:.5,count:10000}]});
assert.equal(scene.getOverviewColumns().length,1);
assert.equal(scene.getOverviewColumns()[0].x,400);
let picked;
scene.onSelect=(index,cell)=>{picked={index,cell};};
emit({type:'scene-pick',albumId:records[8].id,lane:0,row:20});
assert.equal(picked.index,8);
scene.setQuality({scale:80,pixelRatio:1});
assert.deepEqual(messages.at(-1),{type:'scene-quality',scale:80,pixelRatio:1});
state({framesSubmitted:17});
assert.equal(scene.getStats().framesSubmitted,17,'Diagnostics read the native frame counter');
assert.equal(scene.getStats().drawCalls,undefined,'Never report a fixed draw-call count as a measurement');
scene.setReduced(true); assert.equal(messages.at(-1).type,'scene-reduced');
for(const listener of speedListeners) listener(2);
assert.deepEqual(messages.at(-1),{type:'scene-speed',value:2});
const introBefore=messages.length;
for(let n=0;n<180;n++)scene.update(n/60,{musicIntro:true,time:21.92+n/60});
assert.equal(messages.length,introBefore+1,'The native opening starts with one command, not per-frame uploads');
assert.equal(messages.at(-1).speed,introSpeed,'The Vulkan and UI opening clocks use the same speed');
scene.update(4);
assert.deepEqual(messages.at(-1),{type:'scene-intro',active:false});
scene.setIdleMotion(true);assert.equal(messages.at(-1).type,'scene-idle');
assert.equal(scene.getStats().experimentalOptics,false);
scene.setExperimentalOptics(true);
assert.deepEqual(messages.at(-1),{type:'scene-optics',value:true});
state({experimentalOptics:true});
assert.equal(scene.getStats().experimentalOptics,true,'Diagnostics report the native effect state');
scene.setExperimentalOptics(false);
assert.deepEqual(messages.at(-1),{type:'scene-optics',value:false});
scene.dispose();
const count=messages.length;scene.setMode('archive');
assert.equal(messages.length,count,'Disposal removes every native event and command producer');
const invalid=new NativeArchiveScene(container);
emit({type:'scene-state',backend:'OPENGL'});
await assert.rejects(invalid.prepareMusicRenderer(),/Vulkan/);
invalid.dispose();
console.log('Native Vulkan adapter passed: 10k IDs, submitted-frame readiness, no per-frame bridge work, stale selection, overview, settings, backend rejection and disposal. GPU execution requires a device.');

const appSource=await readFile(new URL('../src/music-app.ts',import.meta.url),'utf8');
const appTree=ts.createSourceFile('music-app.ts',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const factory=appTree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createArchiveScene');
const factoryCode=ts.transpileModule(factory.getText(appTree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
class NativeOnly {}
const nativeFactory=new Function('nativeVulkan','NativeArchiveScene',`${factoryCode}; return createArchiveScene`)(true,NativeOnly);
assert(await nativeFactory(container) instanceof NativeOnly,'The APK factory constructs only the native adapter; the WebGL dynamic import must remain unexecuted');

const shader=await readFile(new URL('../../app/src/main/materials/archive.mat',import.meta.url),'utf8');
const helperNames=['ease5','introRowOffset','introEntryZ','selectionBand','bell','shoulder','strength','packet','openingField','clearWindow','topRibbon','acrylicOpacity','focusWeight'];
const helpers=helperNames.map(name=>{
  const match=shader.match(new RegExp(`float ${name}\\(([^)]*)\\)\\s*\\{([^}]+)\\}`));
  assert(match,`The production GPU helper ${name} must exist`);
  return `function ${name}(${match[1].replaceAll('float ','')}) {${match[2].replaceAll('float ','let ')}}`;
}).join('\n');
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const gpu=new Function('mod','floor','abs','clamp','smoothstep','mix','exp','max','sin','sqrt',`${helpers};return {${helperNames.join(',')}};`)(
  (a,b)=>a%b,Math.floor,Math.abs,clamp,smoothstep,(a,b,t)=>a+(b-a)*t,Math.exp,Math.max,Math.sin,Math.sqrt);
for(const [columns,rows] of [[7,31],[9,49]]) {
  let total=0;
  for(let lane=0;lane<columns;lane++) {
    const active=Array.from({length:rows},(_,row)=>gpu.selectionBand(lane*rows+row,rows,0));
    assert.deepEqual(active.flatMap((value,row)=>value?[row-Math.floor(rows/2)]:[]),[-1,0,1]);
    total+=active.reduce((a,b)=>a+b,0);
  }
  assert.equal(total,3*columns,'Each column lights exactly the selected row and its two neighbors');
}
const rowSource=await readFile(new URL('../src/music-row-lighting.ts',import.meta.url),'utf8');
const rowTree=ts.createSourceFile('row.ts',rowSource,ts.ScriptTarget.Latest,true);
const rowFunction=rowTree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='introRowOffset');
const rowCode=ts.transpileModule(rowFunction.getText(rowTree).replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const referenceRow=new Function(`${rowCode};return introRowOffset`)();
for(let n=0;n<=624;n++) {
  const time=21.92+n/120,center=gpu.introRowOffset(time);
  assert(Math.abs(center-referenceRow(time))<1e-9,'The opening light follows the original outbound and return path');
  const weight=Array.from({length:441},(_,index)=>gpu.selectionBand(index,49,center)).reduce((a,b)=>a+b,0);
  assert(Math.abs(weight-27)<1e-8,'Moving edges crossfade without changing the three-row light weight');
}
assert.equal(gpu.introEntryZ(21.92),-23);assert(Math.abs(gpu.introEntryZ(22.67))<1e-12);
assert.equal(gpu.introRowOffset(27.12),0,'The opening light lands on the browsing selection');
const tiltTerms=shader.match(/mat2 tilt=mat2\(([^;]+)\);/)[1];
const tilt=new Function('slope','cos','sin',`return [${tiltTerms}]`)(Math.PI/2,Math.cos,Math.sin);
assert(Math.abs(tilt[0])<1e-12 && Math.abs(tilt[1]-1)<1e-12,'Positive X tilt carries the Y axis toward positive Z, matching the reference model');
console.log('Vulkan selection band passed: 3×7 browsing spines, 3×9 opening spines, continuous original sweep/return and 23-unit array entrance.');
assert.equal(gpu.clearWindow(.17,1.85),1);
assert.equal(gpu.clearWindow(-2.05,1.85),0,'The binding stays outside the clear insert');
for(const [x,y] of [[-1.65,1.85],[2.05,1.85],[.17,.20],[.17,3.50]]) {
  assert.equal(gpu.clearWindow(x,y),0,'Each side of the acrylic frame is frosted');
}
for(const lid of [0,1]) {
  assert(gpu.acrylicOpacity(1,0,0,lid)<=.02,'The center stays clear above and below the printed insert');
  assert(gpu.acrylicOpacity(0,0,0,lid)>=.26,'The perimeter has visible material thickness');
  assert(gpu.acrylicOpacity(0,1,0,lid)>gpu.acrylicOpacity(0,0,0,lid),'The binding has more body than the lid');
}
assert.equal(gpu.topRibbon(-2.225,3.525),1);
assert(gpu.topRibbon(2.225,3.525)>.22,'The spine light reaches the far end of the upper rim');
assert(gpu.topRibbon(-1,3.525)>gpu.topRibbon(2,3.525),'Light attenuates as it travels away from the binding');
assert(gpu.topRibbon(.17,1.85)<1e-12,'The top light never washes over the artwork center');
assert(gpu.topRibbon(.17,3.4)<gpu.topRibbon(.17,3.5),'The highlight remains a narrow upper strip');
console.log('Vulkan acrylic layers passed: clear center, four satin borders, thicker binding and a continuous attenuated top-rim light.');
for(let lane=-1;lane<=1;lane++)for(let row=-1;row<=1;row++)assert.equal(gpu.focusWeight(lane,row),1,'Protect the selected album and its eight nearest neighbors');
assert.equal(gpu.focusWeight(0,3),1);
let previous=1;
for(let row=0;row<=24;row+=.05) {
  const weight=gpu.focusWeight(0,row);
  assert(weight>=0 && weight<=previous+1e-12,'Defocus grows smoothly with distance');
  assert(Math.abs(weight-gpu.focusWeight(0,-row))<1e-12,'Both sides use the same focus falloff');
  previous=weight;
}
assert.equal(gpu.focusWeight(0,15),0);
assert(gpu.focusWeight(2,0)<gpu.focusWeight(1,0),'Distant columns also soften');
assert(1.25*(1-gpu.focusWeight(0,15))<=1.25,'Keep additional mip blur mild');
console.log('Vulkan focus passed: protected 3×3 neighborhood, smooth symmetric distance falloff and bounded blur.');
const inset=Number(shader.match(/clamp\(uv, ([\d.]+), [\d.]+\)/)[1]);
for(let level=0;level<4;level++) {
  const size=128/2**level;
  assert(inset*size-.5>=0 && (1-inset)*size-.5<=size-1,'Every mip footprint stays inside its own cover tile');
}
