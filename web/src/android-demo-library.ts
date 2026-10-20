import type { MusicAlbum, MusicLibrary } from "./music-types";

const collections = [
  { id: "ambient", name: "氛围音乐", artist: "ORBIT STUDIO", titles: ["日光留声", "远岸来信", "夜间航线", "透明的回声"] },
  { id: "electronic", name: "电子音乐", artist: "SIGNAL LAB", titles: ["低轨信号", "潮汐频率", "蓝色时刻", "城市的另一面"] },
  { id: "instrumental", name: "器乐", artist: "FIELD NOTES", titles: ["风经过山谷", "雨后的房间", "群星之间", "The Quiet Hours / 静默时刻"] },
] as const;
const tracks = ["序章 · Arrival", "微光", "沿着海岸线", "Between the Lines", "回声与留白", "终章 · Home"];

export const androidDemoLibrary: MusicLibrary = {
  version: 1,
  albums: collections.flatMap((collection, group) => collection.titles.map((title, index): MusicAlbum => {
    const number = group * 4 + index;
    const id = `android-album-${String(number + 1).padStart(2, "0")}`;
    return {
      id, title, artist: collection.artist, year: 2026 - index,
      genreId: collection.id, rawGenres: [collection.name],
      folder: "随包界面演示 · 无实际音频文件", offline: false,
      coverUrl: number === 10 ? undefined : `/demo-covers/android-${number + 1}.svg`,
      description: `${title}是一张为 RhineDroid 横屏界面准备的虚构专辑。以光线、空间与时间为线索，展示专辑封面、曲目列表和档案信息之间的关系。\n\n此版本可以离线浏览、搜索和切换主题。选择曲目后，播放区域会显示对应的界面状态；所有播放操作均为静音演示，不会访问设备音乐或网络服务。`,
      tracks: tracks.map((name, track) => ({
        id: `${id}-track-${track + 1}`, albumId: id,
        title: index === 3 && track === 3 ? "穿越漫长夜色，直到第一束光抵达 — Across the Long Night" : name,
        artist: collection.artist, trackNumber: track + 1, discNumber: 1,
        duration: 145 + track * 23 + number * 3,
        format: "DEMO", browserPlayable: false, audioUrl: "", relativePath: "",
      })),
      producers: [{ name: collection.artist, role: "视觉与曲目信息演示", source: "manual" }],
    };
  })),
  genres: collections.map(({ id, name }) => ({ id, name, albumCount: 4 })),
  roots: [], scan: { running: false }, onlineEnabled: false,
};
