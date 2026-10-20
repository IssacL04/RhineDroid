import { escapeHtml } from "./html";
import { createTitleReels, type TitleGlyph } from "./music-title-reels";

/** Treat a trailing English translation as a subtitle, preserving the tagged title. */
export function albumTitleParts(title: string) {
  const match = title.trim().match(/^(.+?)[（(]([^（）()]+)[）)]\s*$/u);
  if (
    match &&
    /\p{Script=Han}/u.test(match[1]) &&
    /[a-z]/i.test(match[2]) &&
    !/\p{Script=Han}/u.test(match[2])
  ) {
    return { main: match[1].trim(), translation: match[2].trim() };
  }
  return { main: title, translation: "" };
}

export function albumTitleMarkup(title: string) {
  const { main, translation } = albumTitleParts(title);
  return `<span class="music-title-main">${escapeHtml(main)}</span>${translation ? `<span class="music-title-translation">${escapeHtml(translation)}</span>` : ""}`;
}

type Candidate = {
  root: HTMLSpanElement;
  main: HTMLSpanElement;
  translation: HTMLSpanElement;
  size: number;
};
type TitleLayout = { size: number; height: number; glyphs: TitleGlyph[] };

function sameLayout(a: TitleLayout | undefined, b: TitleLayout) {
  return (
    !!a &&
    a.size === b.size &&
    a.height === b.height &&
    a.glyphs.length === b.glyphs.length &&
    a.glyphs.every((glyph, index) => {
      const next = b.glyphs[index];
      return (
        glyph.key === next.key &&
        glyph.text === next.text &&
        glyph.x === next.x &&
        glyph.y === next.y &&
        glyph.width === next.width &&
        glyph.height === next.height &&
        glyph.font === next.font &&
        glyph.letterSpacing === next.letterSpacing
      );
    })
  );
}

/** Native wrapping is measured in isolation; the visible glyph pool is write-only. */
export function setupMusicTitleLayout(root: HTMLElement) {
  const title = root.querySelector<HTMLElement>("#selection-title")!;
  const callout = root.querySelector<HTMLElement>(".album-callout")!;
  const navigation = root.querySelector<HTMLElement>(".music-navigation")!;
  const spacer = document.createElement("span");
  spacer.className = "music-title-layout";
  spacer.setAttribute("aria-hidden", "true");
  const visual = document.createElement("span");
  visual.className = "music-title-rolling";
  visual.setAttribute("aria-hidden", "true");
  title.replaceChildren(spacer, visual);
  const reels = createTitleReels(visual, spacer);
  // An h1 sibling shares every responsive title rule, but never inherits the
  // fitted --album-title-size of the visible title or contributes to flex flow.
  const probe = document.createElement("h1");
  probe.className = "music-title-probe";
  probe.setAttribute("aria-hidden", "true");
  probe.inert = true;
  callout.append(probe);
  const candidates: Candidate[] = [];
  const cache = new Map<string, TitleLayout>();
  const segmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : undefined;
  const canvas = document.createElement("canvas").getContext("2d")!;
  let text = "",
    displayed = "",
    enabled = false,
    animateNext = false;
  let scheduled = 0,
    destroyed = false,
    bottomGap = -1,
    fontsVersion = 0;
  let appliedKey = "";
  let appliedViewport = "";
  let appliedLayout: TitleLayout | undefined;

  const ensureCandidate = (index: number) => {
    let candidate = candidates[index];
    if (candidate) return candidate;
    const element = document.createElement("span");
    element.className = "music-title-candidate";
    const main = document.createElement("span");
    main.className = "music-title-main";
    const translation = document.createElement("span");
    translation.className = "music-title-translation";
    element.append(main, translation);
    probe.append(element);
    candidate = { root: element, main, translation, size: 0 };
    candidates.push(candidate);
    return candidate;
  };

  const stageCandidate = (index: number, size: number) => {
    const candidate = ensureCandidate(index);
    const parts = albumTitleParts(text);
    if (candidate.main.textContent !== parts.main)
      candidate.main.textContent = parts.main;
    if (candidate.translation.textContent !== parts.translation)
      candidate.translation.textContent = parts.translation;
    candidate.translation.hidden = !parts.translation;
    if (candidate.size !== size) {
      candidate.size = size;
      candidate.root.style.fontSize = `${size}px`;
    }
    candidate.root.style.display = "block";
    return candidate;
  };

  const fits = (candidate: Candidate, budget: number, lineRatio: number) =>
    candidate.root.offsetHeight <= budget + 1 &&
    candidate.main.offsetHeight <=
      candidate.size * lineRatio * 2 + 1;

  const snapshot = (
    candidate: Candidate,
    budget: number,
    overflow: boolean,
  ): TitleLayout => {
    const glyphs: TitleGlyph[] = [];
    let y = 0;
    for (const kind of ["main", "translation"] as const) {
      const element = candidate[kind];
      if (element.hidden || !element.firstChild?.textContent) continue;
      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const elementRect = element.getBoundingClientRect();
      // Range rectangles include the parent's rotation FLIP scale; reels use local CSS coordinates.
      const scaleX = elementRect.width / (Number.parseFloat(style.width) || element.offsetWidth || 1);
      const scaleY = elementRect.height / (Number.parseFloat(style.height) || element.offsetHeight || 1);
      const node = element.firstChild;
      const source = node.textContent!;
      let offset = 0;
      const segments = segmenter
        ? [...segmenter.segment(source)].map((part) => ({
            text: part.segment,
            index: part.index,
          }))
        : [...source].map((character) => {
            const index = offset;
            offset += character.length;
            return { text: character, index };
          });
      const range = document.createRange();
      const lines: TitleGlyph[][] = [];
      let firstTop: number | undefined;
      // One read pass over native grapheme boxes; the reel renderer consumes
      // these positions directly and never measures another glyph subtree.
      for (const segment of segments) {
        range.setStart(node, segment.index);
        range.setEnd(node, segment.index + segment.text.length);
        const rect = range.getBoundingClientRect();
        firstTop ??= rect.top;
        const line = Math.max(
          0,
          Math.round((rect.top - firstTop) / scaleY / lineHeight),
        );
        const row = (lines[line] ||= []);
        if (!rect.width) continue;
        row.push({
          key: `${kind}:${line}:${row.length}`,
          text: segment.text,
          kind,
          x: (rect.left - elementRect.left) / scaleX,
          y: 0,
          width: rect.width / scaleX,
          height: lineHeight,
          font,
          letterSpacing: style.letterSpacing,
        });
      }
      const visible = overflow ? lines.slice(0, 2) : lines;
      if (kind === "translation") y += Number.parseFloat(style.marginTop) || 0;
      visible.forEach((row, line) => {
        // A clamped tag retains native wrapping, replacing only the last face
        // that would overflow with an ellipsis. The full name stays accessible.
        if (lines.length > visible.length && line === visible.length - 1) {
          canvas.font = font;
          const spacing = Number.parseFloat(style.letterSpacing) || 0;
          const width = canvas.measureText("…").width + spacing;
          while (
            row.length &&
            row.at(-1)!.x + row.at(-1)!.width + width > elementRect.width / scaleX
          )
            row.pop();
          const x = row.length ? row.at(-1)!.x + row.at(-1)!.width : 0;
          row.push({
            key: `${kind}:${line}:${row.length}`,
            text: "…",
            kind,
            x,
            y: 0,
            width,
            height: lineHeight,
            font,
            letterSpacing: style.letterSpacing,
          });
        }
        for (const glyph of row) {
          glyph.y = y + line * lineHeight;
          glyphs.push(glyph);
        }
      });
      y += visible.length * lineHeight;
    }
    return { size: candidate.size, height: Math.min(y, budget), glyphs };
  };

  const measure = (
    width: number,
    budget: number,
    base: number,
    lineRatio: number,
  ) => {
    if (probe.style.width !== `${width}px`) probe.style.width = `${width}px`;
    // Extra probes from a previous long tag stay dormant for ordinary titles.
    for (const candidate of candidates) candidate.root.style.display = "none";
    const first = stageCandidate(0, base);
    if (fits(first, budget, lineRatio)) return snapshot(first, budget, false);
    const min = Math.min(base, innerWidth <= 700 ? 18 : 20);
    const coarse = Array.from({ length: 8 }, (_, index) =>
      stageCandidate(index + 1, base - ((base - min) * (index + 1)) / 8),
    );
    // Writes are complete before any fit read. These probes are in a contained
    // layer, instead of resizing the live h1/entire character pool seven times.
    const fitIndex = coarse.findIndex((candidate) =>
      fits(candidate, budget, lineRatio),
    );
    if (fitIndex < 0) return snapshot(coarse.at(-1)!, budget, true);
    const low = coarse[fitIndex].size;
    const high = fitIndex ? coarse[fitIndex - 1].size : base;
    const fine = Array.from({ length: 16 }, (_, index) =>
      stageCandidate(index + 1, high - ((high - low) * (index + 1)) / 16),
    );
    const selected =
      fine.find((candidate) => fits(candidate, budget, lineRatio)) ||
      fine.at(-1)!;
    return snapshot(selected, budget, false);
  };

  const layout = () => {
    scheduled = 0;
    if (destroyed) return;
    if (!text) {
      reels.render([], 0, enabled && animateNext);
      displayed = "";
      appliedKey = "";
      appliedViewport = "";
      appliedLayout = undefined;
      animateNext = false;
      return;
    }
    const width = title.clientWidth;
    if (!width) return;
    const nextBottomGap =
      root.clientHeight - navigation.offsetTop +
      28;
    if (bottomGap !== nextBottomGap) {
      bottomGap = nextBottomGap;
      root.style.setProperty("--callout-bottom", `${bottomGap}px`);
    }
    const calloutStyle = getComputedStyle(callout);
    const titleStyle = getComputedStyle(title);
    const outside = [...callout.children].reduce((sum, element) => {
      if (element === title || element === probe) return sum;
      const style = getComputedStyle(element);
      if (style.display === "none") return sum;
      return (
        sum +
        (element as HTMLElement).offsetHeight +
        Number.parseFloat(style.marginTop) +
        Number.parseFloat(style.marginBottom)
      );
    }, 0);
    const budget = Math.max(
      28,
      callout.clientHeight -
        outside -
        Number.parseFloat(calloutStyle.paddingTop) -
        Number.parseFloat(calloutStyle.paddingBottom) -
        Number.parseFloat(titleStyle.marginTop) -
        Number.parseFloat(titleStyle.marginBottom),
    );
    const style = getComputedStyle(probe);
    const base = Number.parseFloat(style.fontSize);
    const lineRatio = Number.parseFloat(style.lineHeight) / base;
    const viewport = JSON.stringify([
      width,
      base,
      lineRatio,
      style.fontFamily,
      style.fontWeight,
      style.fontStyle,
      style.letterSpacing,
      innerWidth,
      innerHeight,
      root.dataset.layout,
      fontsVersion,
    ]);
    const key = JSON.stringify([text, budget, viewport]);
    if (key === appliedKey) return;
    let result = cache.get(key);
    if (!result) {
      result = measure(width, budget, base, lineRatio);
      cache.set(key, result);
      if (cache.size > 96) cache.delete(cache.keys().next().value!);
    }
    // Metadata may finish wrapping one frame after selection. If its revised
    // budget yields identical glyph geometry, keep the current reel animation.
    if (displayed === text && sameLayout(appliedLayout, result)) {
      appliedKey = key;
      appliedViewport = viewport;
      animateNext = false;
      return;
    }
    // Resizes/font loads reposition existing text without replaying a title;
    // actual selection changes keep the original per-character roll.
    const animated =
      enabled &&
      ((animateNext && displayed !== text) ||
        (displayed === text && viewport === appliedViewport && reels.moving));
    title.style.setProperty("--album-title-size", `${result.size}px`);
    reels.render(result.glyphs, result.height, animated);
    displayed = text;
    animateNext = false;
    appliedKey = key;
    appliedLayout = result;
    appliedViewport = viewport;
  };
  const schedule = () => {
    if (!destroyed && !scheduled) scheduled = requestAnimationFrame(layout);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(navigation);
  for (const id of ["selection-artist", "selection-meta"])
    resize.observe(root.querySelector<HTMLElement>(`#${id}`)!);
  const changes = new MutationObserver(schedule);
  changes.observe(root, { attributes: true, attributeFilter: ["data-layout"] });
  const fontsChanged = () => {
    fontsVersion++;
    cache.clear();
    schedule();
  };
  document.fonts.addEventListener("loadingdone", fontsChanged);
  void document.fonts.ready.then(fontsChanged);
  return {
    update(next: string, animated: boolean) {
      enabled = animated;
      if (next === text) {
        if (!enabled) reels.finish();
        return;
      }
      text = next;
      animateNext = animated && !!displayed;
      title.title = next;
      title.setAttribute("aria-label", next);
      schedule();
    },
    finish() {
      enabled = false;
      animateNext = false;
      reels.finish();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(scheduled);
      resize.disconnect();
      changes.disconnect();
      document.fonts.removeEventListener("loadingdone", fontsChanged);
      reels.destroy();
      probe.remove();
      cache.clear();
      title.innerHTML = albumTitleMarkup(text);
    },
  };
}
