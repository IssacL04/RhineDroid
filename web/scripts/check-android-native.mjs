import assert from 'node:assert/strict';
import { androidDemoLibrary } from '../src/android-demo-library.ts';
import { searchMusicLibrary } from '../src/music-search.ts';

const originalWindow = globalThis.window;
const messages = [];
const target = new EventTarget();
target.RhineHost = { postMessage(raw) {
  const message = JSON.parse(raw); messages.push(message);
  queueMicrotask(() => target.dispatchEvent(new CustomEvent('rhine-native', {detail:{type:'response',id:message.id,ok:true,result:message.type==='library-api'?{onlineEnabled:false}:undefined}})));
} };
globalThis.window = target;
try {
  const { AndroidMusicPlayer, nativeCommand, nativeRequest } = await import('../src/android-native.ts');
  const player = new AndroidMusicPlayer();
  assert.deepEqual(await nativeRequest('library-api',{route:'/api/config'}),{onlineEnabled:false});
  player.setSongTransitionMode('gapless'); await Promise.resolve();
  assert.equal(messages.at(-1).songTransition,'gapless');
  player.setBgmEnabled(true); await Promise.resolve();assert.equal(messages.at(-1).bgm,true);
  await player.setOutputDevice('default');assert.equal(messages.at(-1).outputDevice,'default');
  const songs = androidDemoLibrary.albums[0].tracks;
  player.setTracks(songs);
  await player.play(songs[0].id, [...songs,songs[0]]);
  assert.equal(messages.at(-1).type,'play');
  assert.equal(messages.at(-1).tracks.length,6);
  const update = state => target.dispatchEvent(new CustomEvent('rhine-native', {detail:{
    type:'player', track:songs[0],playing:true,loading:false,transport:'playing',currentIndex:0,
    currentTime:12,duration:145,volume:.7,error:null,...state,
  }}));
  update({queue:songs.map(song=>song.id)});
  assert.equal(player.state.currentTime,12);
  assert.equal(player.state.queue.length,6);
  update({currentTime:13});
  assert.equal(player.state.queue.length,6,'Progress deltas retain the established queue');
  assert.equal(player.state.currentTime,13);
  await player.toggle(); assert.equal(messages.at(-1).type,'toggle');
  player.seek(42); await Promise.resolve(); assert.equal(messages.at(-1).seconds,42);
  const count = messages.length; player.seek(NaN); assert.equal(messages.length,count);
  update({transport:'error',playing:false,error:'Missing file'});
  assert.equal(player.state.error,'Missing file');
  const beforeDispose = player.state.currentTime;
  player.dispose(); update({currentTime:99}); assert.equal(player.state.currentTime,beforeDispose);
  assert(!messages.some(message=>message.type==='stop'),'Disposing the UI keeps service playback alive');
  delete target.RhineHost;
  await assert.rejects(nativeCommand('scan'),/Android/);

  const albums = Array.from({length:1000},(_,a)=>({...androidDemoLibrary.albums[0],id:`album-${a}`,title:`Album ${a}`,
    tracks:Array.from({length:10},(_,t)=>({...songs[0],id:`track-${a}-${t}`,title:`Song ${a}-${t}`}))}));
  const start = performance.now();
  const result = searchMusicLibrary(albums,[],'Song 999-9');
  assert.equal(result.length,1); assert.equal(result[0].track.id,'track-999-9');
  assert.equal(searchMusicLibrary(albums,[],'').length,120);
  assert.equal(searchMusicLibrary(albums,[],'Song').length,120);
  console.log(`Android bridge passed: play/seek/progress/error/lifecycle; synthetic 10k search ${(performance.now()-start).toFixed(1)} ms; results bounded at 120.`);
} finally { globalThis.window = originalWindow; }
