import type { MusicAlbum, MusicGenre, MusicTrack } from './music-types';

export interface MusicSearchResult {
  kind: 'album' | 'track';
  album: MusicAlbum;
  track?: MusicTrack;
}

/** Shared by the player and local film renderer; exact IDs survive selection. */
export function searchMusicLibrary(albums: MusicAlbum[], genres: MusicGenre[], input: string, genreId = ''): MusicSearchResult[] {
  const query = input.trim().toLocaleLowerCase();
  const names = new Map(genres.map(genre => [genre.id, genre.name]));
  const results: MusicSearchResult[] = [];
  search: for (const album of albums) {
    if (genreId && album.genreId !== genreId) continue;
    if (!query || `${album.title} ${album.artist} ${names.get(album.genreId) || '未分类'}`.toLocaleLowerCase().includes(query)) {
      results.push({ kind: 'album', album });
      if (results.length >= 120) break;
    }
    if (!query) continue;
    for (const track of album.tracks) {
      if (`${track.title} ${track.artist}`.toLocaleLowerCase().includes(query)) {
        results.push({ kind: 'track', album, track });
        if (results.length >= 120) break search;
      }
    }
  }
  return results;
}
