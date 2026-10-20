/** JSON contract shared by the local music service and the visual interface. */
export interface MusicTrack {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  trackNumber?: number;
  discNumber?: number;
  duration: number;
  format: string;
  codec?: string;
  bitsPerSample?: number;
  sampleRate?: number;
  bitrate?: number;
  numberOfChannels?: number;
  lossless?: boolean;
  browserPlayable: boolean;
  audioUrl: string;
  /** Local FFmpeg PCM route; original source remains read-only. */
  decodedAudioUrl?: string;
  localDecodable?: boolean;
  relativePath: string;
}

export interface MusicProducer {
  name: string;
  role: string;
  source: "local" | "MusicBrainz" | "QQ Music" | "manual";
  trackId?: string;
  trackTitle?: string;
  url?: string;
}

export interface MusicAlbum {
  id: string;
  title: string;
  artist: string;
  year?: number;
  discCount?: number;
  description?: string;
  descriptionSource?: {
    name: string;
    url: string;
    checkedAt?: string;
    license?: string;
  };
  localNote?: string;
  introduction?: {
    status: "unqueried" | "matched" | "not-found" | "uncertain" | "error";
    checkedAt?: string;
    error?: string;
    candidateUrl?: string;
  };
  genreId: string;
  rawGenres: string[];
  folder: string;
  coverUrl?: string;
  tracks: MusicTrack[];
  producers: MusicProducer[];
  creditsLookup?: {
    status: "unqueried" | "matched" | "partial" | "not-found" | "uncertain" | "error";
    source: "QQ Music";
    checkedAt?: string;
    matchedTracks?: number;
    totalTracks?: number;
    error?: string;
    retryAt?: string;
  };
  offline: boolean;
  online?: {
    status: "unqueried" | "matched" | "uncertain" | "not-found" | "error";
    releaseId?: string;
    releaseGroupId?: string;
    checkedAt?: string;
    sourceUrl?: string;
    error?: string;
    descriptionStatus?: "available" | "not-found" | "error";
    descriptionError?: string;
  };
}

export interface MusicGenre {
  id: string;
  name: string;
  aliases?: string[];
  albumCount?: number;
}

export interface GenreRules {
  version: 1;
  genres: MusicGenre[];
  albumOverrides: Record<string, string>;
}

export interface LibraryRoot {
  path: string;
  label?: string;
  status: "online" | "offline" | "unscanned";
  error?: string;
}

export interface MusicLibrary {
  version: 1;
  albums: MusicAlbum[];
  genres: MusicGenre[];
  roots: LibraryRoot[];
  scan: {
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  onlineEnabled: boolean;
  enrich?: {
    running: boolean;
    completed: number;
    total: number;
    error?: string;
  };
  introductions?: {
    running: boolean;
    completed: number;
    total: number;
    updated: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    retryAt?: number;
    waitingSource?: string;
    error?: string;
  };
  credits?: {
    running: boolean;
    completed: number;
    total: number;
    updated: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    trackCompleted?: number;
    trackTotal?: number;
    retryAt?: number;
    waitingSource?: string;
    error?: string;
  };
}
