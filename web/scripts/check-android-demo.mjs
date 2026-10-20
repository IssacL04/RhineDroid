import assert from "node:assert/strict";
import test from "node:test";
import { androidDemoLibrary } from "../src/android-demo-library.ts";
import { AndroidDemoPlayer } from "../src/android-demo-player.ts";

test("bundled library has stable identities, track search data, and no real audio paths", () => {
  const library = androidDemoLibrary;
  const albumIds = new Set(library.albums.map((album) => album.id));
  const tracks = library.albums.flatMap((album) => album.tracks);
  assert.equal(albumIds.size, 12);
  assert.equal(tracks.length, 72);
  assert.equal(new Set(tracks.map((track) => track.id)).size, tracks.length);
  assert.equal(library.roots.length, 0);
  assert.equal(library.onlineEnabled, false);
  assert(library.albums.some((album) => !album.coverUrl));
  for (const album of library.albums) {
    assert(library.genres.some((genre) => genre.id === album.genreId));
    for (const track of album.tracks) {
      assert.equal(track.albumId, album.id);
      assert.equal(track.audioUrl, "");
      assert.equal(track.relativePath, "");
      assert(track.duration > 0);
    }
  }
});

test("silent playback changes UI state without creating audio or fetching anything", async () => {
  const originalAudio = globalThis.Audio;
  const originalFetch = globalThis.fetch;
  globalThis.Audio = class { constructor() { throw new Error("Unexpected audio creation"); } };
  globalThis.fetch = () => { throw new Error("Unexpected network request"); };
  try {
    const player = new AndroidDemoPlayer();
    let notifications = 0;
    const unsubscribe = player.subscribe(() => notifications++);
    const album = androidDemoLibrary.albums[0];
    await player.play("missing", album.tracks);
    assert.equal(player.state.transport, "idle");
    await player.play(album.tracks[2].id, [...album.tracks, album.tracks[2]]);
    assert.equal(player.state.currentIndex, 2);
    assert.equal(player.state.queue.length, album.tracks.length);
    assert.equal(player.state.transport, "playing");
    assert.equal(player.state.currentTime, 0);
    await player.toggle();
    assert.equal(player.state.transport, "paused");
    await player.toggle();
    assert.equal(player.state.playing, true);
    player.stop();
    assert.equal(player.state.transport, "idle");
    assert.equal(player.state.playing, false);
    const snapshot = player.state;
    snapshot.queue.pop();
    assert.equal(player.state.queue.length, album.tracks.length);
    player.setVolume(2);
    assert.equal(player.state.volume, 1);
    player.setVolume(NaN);
    assert.equal(player.state.volume, 1);
    player.setBgmEnabled(true);
    assert.equal(player.state.bgmEnabled, false);
    await assert.rejects(player.refreshOutputs(), /静音/);
    unsubscribe();
    const before = notifications;
    player.dispose();
    await player.play(album.tracks[0].id, album.tracks);
    assert.equal(notifications, before);
    assert.equal(player.state.transport, "idle");
  } finally {
    globalThis.Audio = originalAudio;
    globalThis.fetch = originalFetch;
  }
});
