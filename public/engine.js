import {
  cacheGet,
  mediaNetworkEnabled,
  mediaUnavailable,
  markMediaUnavailable,
} from "./cache.js";
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
    this.fadeState = {};
    this.pauseState = null;
    this.manualPause = false;
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
    this.el.addEventListener("playing", () => {
      if (!this.pausing) this.scheduleEndFade();
    });
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
      if (this.el.error) {
        const m = this.getMedia(this.cue?.mediaId);
        if (m && mediaNetworkEnabled()) markMediaUnavailable(m);
        this.error(
          "This media cannot be played by this browser. Check the file format.",
        );
      }
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
      this.fadeInNode = this.audioContext.createGain();
      this.fadeOutNode = this.audioContext.createGain();
      this.source.connect(this.gainNode);
      this.gainNode.connect(this.fadeInNode);
      this.fadeInNode.connect(this.fadeOutNode);
      this.fadeOutNode.connect(this.audioDestination);
      this.output.srcObject = this.audioDestination.stream;
      if (this.sinkId && this.output.setSinkId)
        await this.output.setSinkId(this.sinkId);
    }
    this.apply(false);
    await this.audioContext.resume();
    if (this.output.paused) await this.output.play();
  }
  get pausing() {
    return Boolean(this.pauseState);
  }
  fadeLevel(name) {
    const state = this.fadeState[name];
    if (!state) return 1;
    const now = this.audioContext.currentTime;
    if (now <= state.start) return state.from;
    if (now >= state.end) return state.to;
    return (
      state.from +
      ((state.to - state.from) * (now - state.start)) /
        (state.end - state.start)
    );
  }
  setFade(name, from, to, duration, delay = 0) {
    if (!this.audioContext) return;
    const node = name === "in" ? this.fadeInNode : this.fadeOutNode,
      now = this.audioContext.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(from, now);
    if (delay > 0) node.gain.setValueAtTime(from, now + delay);
    if (duration > 0)
      node.gain.linearRampToValueAtTime(to, now + delay + duration);
    else node.gain.setValueAtTime(to, now + delay);
    this.fadeState[name] = {
      from,
      to,
      start: now + delay,
      end: now + delay + duration,
    };
  }
  scheduleEndFade() {
    if (!this.audioContext || !this.cue || this.pausing) return 1;
    const remaining = Math.max(
        0,
        (this.cue.end - this.el.currentTime) / (this.cue.speed || 1),
      ),
      duration = Math.min(
        this.cue.fadeOut || 0,
        (this.cue.end - this.cue.start) / (this.cue.speed || 1),
      );
    const from = duration > 0 ? Math.min(1, remaining / duration) : 1;
    this.setFade(
      "out",
      from,
      duration > 0 ? 0 : 1,
      Math.min(duration, remaining),
      Math.max(0, remaining - duration),
    );
    return from;
  }
  cancelPause() {
    const pending = this.pauseState;
    if (pending) {
      clearTimeout(pending.timer);
      this.pauseState = null;
      pending.resolve();
    }
  }
  async play() {
    const generation = this.generation,
      wasPlaying = this.playing,
      level = this.audioContext
        ? this.fadeLevel("in") * this.fadeLevel("out")
        : 0;
    this.cancelPause();
    await this.prepareAudio();
    if (generation !== this.generation || this.loading) return;
    const out = this.scheduleEndFade(),
      from = wasPlaying ? Math.min(1, level / Math.max(0.0001, out)) : 0;
    this.setFade(
      "in",
      this.cue.fadeIn > 0 ? from : 1,
      1,
      Math.min(
        this.cue.fadeIn || 0,
        Math.max(
          0,
          (this.cue.end - this.el.currentTime) / (this.cue.speed || 1),
        ),
      ),
    );
    this.manualPause = false;
    await this.el.play();
  }
  apply(reschedule = true) {
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
      if (this.playing && !this.pausing) this.pause();
    } else this.el.playbackRate = c.speed;
    if (this.el.currentTime < c.start || this.el.currentTime > c.end)
      this.el.currentTime = c.start;
    if (reschedule && this.playing && !this.pausing) this.scheduleEndFade();
  }
  finishPause(pending) {
    if (this.pauseState !== pending) return;
    clearTimeout(pending.timer);
    this.pauseState = null;
    this.el.pause();
    this.setFade("out", 0, 0, 0);
    if (pending.reset) {
      this.iteration = 1;
      this.seek(0);
    }
    this.emit();
    pending.resolve();
  }
  pause(reset = false) {
    this.manualPause = true;
    if (this.pauseState) {
      this.pauseState.reset ||= reset;
      return this.pauseState.promise;
    }
    const duration = Math.min(
      this.cue?.fadeOut || 0,
      Math.max(
        0,
        ((this.cue?.end || 0) - this.el.currentTime) /
          (this.el.playbackRate || 1),
      ),
    );
    if (!this.playing || !this.audioContext || duration <= 0) {
      this.halt(reset);
      return Promise.resolve();
    }
    const pending = { reset };
    pending.promise = new Promise((resolve) => (pending.resolve = resolve));
    this.pauseState = pending;
    this.setFade("in", this.fadeLevel("in"), this.fadeLevel("in"), 0);
    this.setFade("out", this.fadeLevel("out"), 0, duration);
    pending.timer = setTimeout(
      () => this.finishPause(pending),
      duration * 1000,
    );
    this.emit();
    return pending.promise;
  }
  halt(reset = false) {
    this.manualPause = true;
    this.cancelPause();
    this.el.pause();
    this.setFade("out", 0, 0, 0);
    if (reset) {
      this.iteration = 1;
      this.seek(0);
    }
    this.emit();
  }
  async select(index, autoplay = false) {
    const generation = ++this.generation;
    this.finishing = false;
    this.iteration = 1;
    this.halt();
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
      if (!blob && (!mediaNetworkEnabled() || mediaUnavailable(m))) {
        this.loading = false;
        this.el.removeAttribute("src");
        this.el.load();
        this.emit();
        return;
      }
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
    if (this.playing && !this.pausing) await this.pause();
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
    if (this.pauseState) {
      this.finishPause(this.pauseState);
      return;
    }
    if (this.manualPause) return;
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
      if (this.playing && !this.pausing) this.scheduleEndFade();
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
    return this.pause(true);
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
