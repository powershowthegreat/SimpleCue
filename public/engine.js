import { cacheGet } from "./cache.js";
export class CueEngine extends EventTarget {
  constructor(getSequence, getMedia) {
    super();
    this.getSequence = getSequence;
    this.getMedia = getMedia;
    this.index = 0;
    this.master = 0.8;
    this.muted = false;
    this.sinkId = "";
    this.url = null;
    this.generation = 0;
    this.loading = false;
    this.finished = false;
    this.finishing = false;
    this.iteration = 1;
    this.frameId = null;
    this.el = document.createElement("video");
    this.el.preload = "auto";
    this.el.playsInline = true;
    this.el.crossOrigin = "anonymous";
    this.el.className = "video-preview hidden";
    document.body.append(this.el);
    // Route processed audio through a separate output element so setSinkId still selects the device.
    this.output = document.createElement("audio");
    this.output.className = "hidden";
    this.output.dataset.simplecueOutput = "";
    document.body.append(this.output);
    this.el.addEventListener("timeupdate", () => this.tick());
    this.el.addEventListener("ended", () => {
      if (this.el.ended) this.end();
    });
    this.el.addEventListener("play", () => {
      this.emit();
      this.frame();
    });
    this.el.addEventListener("pause", () => {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
      this.emit();
    });
    this.el.addEventListener("error", () => {
      if (this.el.error)
        this.error(
          "This media cannot be played by this browser. Check the file format.",
        );
    });
  }
  get cue() {
    return this.getSequence()?.cues[this.index];
  }
  get playing() {
    return !this.el.paused && !this.el.ended;
  }
  get duration() {
    const c = this.cue;
    return c ? (c.end - c.start) / c.speed : 0;
  }
  get elapsed() {
    const c = this.cue;
    return c && c.speed > 0
      ? Math.max(0, (this.el.currentTime - c.start) / c.speed)
      : 0;
  }
  emit() {
    this.dispatchEvent(new Event("change"));
  }
  error(message) {
    this.dispatchEvent(new CustomEvent("problem", { detail: message }));
  }
  frame() {
    cancelAnimationFrame(this.frameId);
    this.frameId = null;
    if (!this.playing) return;
    this.tick();
    if (this.playing)
      this.frameId = requestAnimationFrame(() => {
        this.frameId = null;
        this.frame();
      });
  }
  tick() {
    if (
      !this.loading &&
      this.cue &&
      this.el.currentTime >= this.cue.end &&
      this.playing
    )
      this.end();
    this.dispatchEvent(new Event("time"));
  }
  async prepareAudio() {
    if (!this.audioContext) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context)
        throw new Error("This browser does not support audio gain processing.");
      this.audioContext = new Context({ latencyHint: "interactive" });
      this.source = this.audioContext.createMediaElementSource(this.el);
      this.gainNode = this.audioContext.createGain();
      this.audioDestination = this.audioContext.createMediaStreamDestination();
      this.source.connect(this.gainNode);
      this.gainNode.connect(this.audioDestination);
      this.output.srcObject = this.audioDestination.stream;
      if (this.sinkId && this.output.setSinkId)
        await this.output.setSinkId(this.sinkId);
    }
    this.apply();
    await this.audioContext.resume();
    if (this.output.paused) await this.output.play();
  }
  async play() {
    const generation = this.generation;
    await this.prepareAudio();
    if (generation === this.generation && !this.loading) await this.el.play();
  }
  apply() {
    const c = this.cue;
    if (!c) return;
    const gain = (this.master * (c.volume ?? 100)) / 100;
    if (this.gainNode) {
      this.el.volume = 1;
      this.el.muted = false;
      this.output.muted = this.muted;
      this.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
    } else {
      this.el.volume = Math.max(0, Math.min(1, gain));
      this.el.muted = this.muted;
    }
    if (c.speed === 0) {
      this.el.pause();
      this.el.playbackRate = 1;
    } else this.el.playbackRate = c.speed;
    if (this.el.currentTime < c.start || this.el.currentTime > c.end)
      this.el.currentTime = c.start;
  }
  async select(index, autoplay = false) {
    const generation = ++this.generation;
    this.finishing = false;
    this.iteration = 1;
    this.el.pause();
    const seq = this.getSequence();
    if (!seq?.cues.length) {
      this.index = 0;
      this.loading = false;
      this.emit();
      return;
    }
    this.index = Math.max(0, Math.min(index, seq.cues.length - 1));
    this.finished = false;
    this.loading = true;
    this.emit();
    const c = this.cue,
      m = this.getMedia(c.mediaId);
    if (!m) {
      this.loading = false;
      return;
    }
    try {
      const blob = await cacheGet("assets", `media:${m.id}`);
      if (generation !== this.generation) return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = blob ? URL.createObjectURL(blob) : null;
      this.el.src = this.url || m.url;
      this.el.load();
      await new Promise((resolve, reject) => {
        const clean = () => {
          this.el.removeEventListener("loadedmetadata", ready);
          this.el.removeEventListener("error", bad);
          clearTimeout(timer);
        };
        const ready = () => {
            clean();
            resolve();
          },
          bad = () => {
            clean();
            reject(
              new Error(
                "Media could not be loaded. Cache it before going offline.",
              ),
            );
          };
        const timer = setTimeout(bad, 20000);
        this.el.addEventListener("loadedmetadata", ready, { once: true });
        this.el.addEventListener("error", bad, { once: true });
      });
      if (generation !== this.generation) return;
      this.el.currentTime = c.start;
      this.loading = false;
      this.apply();
      this.emit();
      if (autoplay && c.speed > 0) await this.play();
    } catch (e) {
      if (generation === this.generation) {
        this.loading = false;
        this.error(e.message);
        this.emit();
      }
    }
  }
  async toggle() {
    if (!this.cue) return;
    if (this.cue.speed === 0) {
      this.error("Set speed above 0% to play this cue.");
      return;
    }
    if (this.loading) return;
    if (this.playing) this.el.pause();
    else
      try {
        if (!this.el.src) return await this.select(this.index, true);
        if (this.finished || this.el.currentTime >= this.cue.end - 0.005) {
          this.el.currentTime = this.cue.start;
          this.iteration = 1;
          this.finished = false;
        }
        await this.play();
      } catch (e) {
        this.error(e.message);
      }
  }
  async end() {
    if (this.finishing || this.loading || !this.cue) return;
    this.finishing = true;
    const generation = this.generation,
      cue = this.cue,
      loops = cue.loop ?? 1;
    this.el.pause();
    try {
      if (loops === "forever" || this.iteration < loops) {
        this.iteration++;
        this.el.currentTime = cue.start;
        this.finished = false;
        this.emit();
        this.dispatchEvent(new Event("time"));
        if (cue.speed > 0) await this.play();
      } else {
        const cues = this.getSequence()?.cues || [],
          next = this.index + 1;
        if (next < cues.length)
          await this.select(
            next,
            Boolean(cues[next].follow && cues[next].followFrom === cue.id),
          );
        else {
          this.finished = true;
          this.emit();
          this.dispatchEvent(new Event("time"));
        }
      }
    } catch (e) {
      if (generation === this.generation) this.error(e.message);
    } finally {
      if (generation === this.generation) this.finishing = false;
    }
  }
  seek(ratio) {
    if (this.cue && !this.loading) {
      this.el.currentTime =
        this.cue.start +
        Math.max(0, Math.min(1, ratio)) * (this.cue.end - this.cue.start);
      this.finished = false;
      this.dispatchEvent(new Event("time"));
    }
  }
  step(delta) {
    return this.select(this.index + delta, false);
  }
  reset() {
    this.iteration = 1;
    this.seek(0);
    this.emit();
  }
  stop() {
    this.el.pause();
    this.iteration = 1;
    this.seek(0);
    this.emit();
  }
  setMaster(value) {
    this.master = Math.max(0, Math.min(2, value));
    this.apply();
    this.emit();
  }
  async setDevice(id) {
    if (!this.output.setSinkId)
      throw new Error(
        "Use your system sound settings to choose an output device in this browser.",
      );
    await this.output.setSinkId(id);
    this.sinkId = id;
    this.emit();
  }
}
