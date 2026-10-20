import type { ArchiveNavigation } from "./archive-loop.ts";

export interface AlbumSelection {
  index: number;
  navigation?: ArchiveNavigation;
  /** Track/search navigation returns to the archive before selecting and reopening. */
  route?: "archive";
}

export type MusicPresentationPhase =
  | "archive" | "opening" | "detail" | "switch-hiding" | "switching"
  | "hiding" | "returning" | "selecting";

export interface MusicPresentationPorts {
  presentationReady(): boolean;
  archiveReady(): boolean;
  archiveInteractive?(): boolean;
  enterCamera(): void;
  returnCamera(): void;
  select(selection: AlbumSelection): void;
  switchDetail(selection: AlbumSelection): void;
  prepareMenu(): void;
  showMenu(): void;
  hideMenu(done: () => void): void;
  hideBrowse(done: () => void): void;
  showBrowse(): void;
  mode(mode: "archive" | "detail"): void;
}

/** Serializes the visible transition; requests may change while a shot is moving. */
export class MusicPresentation {
  phase: MusicPresentationPhase = "archive";
  pendingSelection?: AlbumSelection;
  private wantsDetail = false;
  private revision = 0;
  private browseHidden = false;
  private cameraEntered = false;

  constructor(private readonly ports: MusicPresentationPorts) {}

  get openingOrDetail() { return this.wantsDetail; }

  open() {
    this.wantsDetail = true;
    if (this.phase === "archive") {
      if (this.ports.archiveReady()) this.beginOpen();
      else {
        // Opening just after a selection must start at its settled preview
        // height, so the shared lift/camera progress has a continuous origin.
        this.phase = "selecting";
        this.ports.hideBrowse(() => {});
      }
    }
  }

  back() {
    this.wantsDetail = false;
    this.pendingSelection = undefined;
    if (this.phase === "archive") return;
    if (this.phase === "selecting") {
      // A rail movement already committed may settle, but no new detail opens.
      return;
    }
    this.beginExit();
  }

  select(selection: AlbumSelection, openAfter = this.wantsDetail) {
    this.pendingSelection = selection;
    this.wantsDetail = openAfter;
    const switchInDetail = openAfter && selection.route !== "archive";
    // Input during the 140 ms browse exit has not yet begun an extraction.
    // Keep only the latest destination and settle its rail before opening it.
    if (this.phase === "opening" && !this.cameraEntered) return;
    if (this.phase === "archive") {
      this.commitSelection();
      if (openAfter) {
        this.phase = "selecting";
        this.ports.hideBrowse(() => {});
      }
    } else if (switchInDetail && (this.phase === "detail" || this.phase === "opening")) {
      this.beginDetailSwitch();
    } else if (switchInDetail && (this.phase === "switch-hiding" || this.phase === "switching")) {
      // Keep the latest target without restarting the text exit or rail motion.
      return;
    } else if (this.phase !== "selecting") this.beginExit();
  }

  update() {
    if (this.phase === "switching") {
      if (this.pendingSelection) {
        this.commitDetailSwitch();
        return; // Read readiness only after the scene has advanced the new target.
      }
      if (this.browseHidden && this.ports.presentationReady()) {
        this.phase = "detail";
        this.ports.showMenu();
      }
      return;
    }
    if (this.phase === "opening") {
      if (this.browseHidden && this.ports.presentationReady()) {
        this.phase = "detail";
        this.ports.showMenu();
      }
      return;
    }
    if (this.phase !== "returning" && this.phase !== "selecting") return;
    // Browsing can resume during the final camera/lift easing. Automatic album
    // handoffs still wait for the fully settled archive below.
    if (this.phase === "returning" && !this.wantsDetail && this.ports.archiveInteractive?.()) {
      this.phase = "archive";
      this.ports.mode("archive");
      if (this.pendingSelection) this.commitSelection();
      this.ports.showBrowse();
      return;
    }
    if (!this.ports.archiveReady()) return;
    if (this.pendingSelection) {
      this.commitSelection();
      this.phase = "selecting";
      return; // Read the newly selected camera/rail state on the following frame.
    }
    if (this.wantsDetail) this.beginOpen();
    else {
      this.phase = "archive";
      this.ports.mode("archive");
      this.ports.showBrowse();
    }
  }

  /** Replay/library replacement invalidate callbacks from the previous album. */
  reset() {
    this.revision++;
    this.pendingSelection = undefined;
    this.wantsDetail = false;
    this.browseHidden = false;
    this.cameraEntered = false;
    this.phase = "archive";
    this.ports.mode("archive");
  }

  private beginOpen() {
    const revision = ++this.revision;
    this.phase = "opening";
    this.browseHidden = false;
    this.cameraEntered = false;
    this.ports.mode("detail");
    this.ports.prepareMenu();
    this.ports.hideBrowse(() => {
      if (revision !== this.revision) return;
      this.browseHidden = true;
      if (this.pendingSelection) {
        this.phase = "selecting";
        this.commitSelection();
        return;
      }
      // Retire the previous text before the physical extraction begins. The
      // callback also makes a reduced-motion synchronous exit deterministic.
      this.cameraEntered = true;
      this.ports.enterCamera();
    });
  }

  private beginExit() {
    if (this.phase === "hiding" || this.phase === "returning" || this.phase === "switch-hiding") return;
    const revision = ++this.revision;
    this.phase = "hiding";
    this.ports.hideMenu(() => {
      if (revision !== this.revision) return;
      this.returnToArchive();
    });
  }

  private beginDetailSwitch() {
    const revision = ++this.revision;
    this.phase = "switch-hiding";
    // An input may arrive during the very first opening's browse exit.
    if (!this.browseHidden) this.ports.hideBrowse(() => {
      if (revision === this.revision) this.browseHidden = true;
    });
    this.ports.hideMenu(() => {
      if (revision !== this.revision) return;
      if (!this.wantsDetail || this.pendingSelection?.route === "archive") {
        // Esc or a track/search reveal reuses the text exit in progress.
        // Reveals keep their target until the archive camera and rail settle.
        this.returnToArchive();
        return;
      }
      this.phase = "switching";
      if (this.pendingSelection) this.commitDetailSwitch();
    });
  }

  private commitDetailSwitch() {
    const request = this.pendingSelection!;
    this.pendingSelection = undefined;
    this.ports.switchDetail(request);
    this.ports.prepareMenu();
  }

  private returnToArchive() {
    this.phase = "returning";
    this.ports.mode("archive");
    this.ports.returnCamera();
  }

  private commitSelection() {
    const request = this.pendingSelection!;
    this.pendingSelection = undefined;
    this.ports.select(request);
  }
}
