import type { MusicAlbum, MusicGenre } from "./music-types";
export const demoGenres: MusicGenre[] = [
  { id: "ambient", name: "氛围音乐" },
  { id: "instrumental", name: "器乐" },
];
/** Visual samples only. Never inserted into the user's actual music index. */
export const demoAlbums: MusicAlbum[] = [
  {
    id: "demo-sun",
    title: "日光留声",
    artist: "RHINE · 演示封面",
    genreId: "ambient",
    year: 2026,
    coverUrl: "/demo-covers/square.png",
    rawGenres: ["Ambient"],
    folder: "演示专辑 · 方形封面",
    tracks: [],
    producers: [],
    offline: false,
  },
  {
    id: "demo-night",
    title: "夜间航线",
    artist: "RHINE · 演示封面",
    genreId: "ambient",
    year: 2026,
    coverUrl: "/demo-covers/portrait.png",
    rawGenres: ["Ambient"],
    folder: "演示专辑 · 竖版封面",
    tracks: [],
    producers: [],
    offline: false,
  },
  {
    id: "demo-mountain",
    title: "远山来信",
    artist: "RHINE · 演示封面",
    genreId: "instrumental",
    year: 2026,
    coverUrl: "/demo-covers/landscape.png",
    rawGenres: ["Instrumental"],
    folder: "演示专辑 · 横版封面",
    tracks: [],
    producers: [],
    offline: false,
  },
];
