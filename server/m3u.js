const line = (v) => String(v || "").replace(/[\r\n]/g, " ");
export function serialize(sequence, media = {}) {
  const { cues, ...meta } = sequence;
  const lines = [
    "#EXTM3U",
    `#PLAYLIST:${line(sequence.name)}`,
    `#SIMPLECUE:${JSON.stringify(meta)}`,
  ];
  for (const cue of cues) {
    const item = media[cue.mediaId];
    lines.push(
      `#EXTINF:${item?.duration || -1},${line(item?.name || cue.name || "Missing media")}`,
      `#CUE:${JSON.stringify(cue)}`,
      line(item?.filename || cue.name || cue.mediaId),
    );
  }
  return lines.join("\n") + "\n";
}
export function parse(text, media = {}) {
  if (!text.trim().startsWith("#EXTM3U"))
    throw new Error("Expected an extended M3U file beginning with #EXTM3U.");
  let meta = {},
    cue = {},
    title = "";
  const cues = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith("#SIMPLECUE:")) meta = JSON.parse(l.slice(11));
    else if (l.startsWith("#PLAYLIST:")) title = l.slice(10);
    else if (l.startsWith("#CUE:")) cue = JSON.parse(l.slice(5));
    else if (l && !l.startsWith("#")) {
      const item =
        media[cue.mediaId] ||
        Object.values(media).find(
          (m) =>
            m.filename === l ||
            m.name === l ||
            m.url === l ||
            m.filename === l.split("/").pop(),
        );
      if (!item)
        throw new Error(`Upload the missing media before importing: ${l}`);
      cues.push({ ...cue, mediaId: item.id });
      cue = {};
    }
  }
  // Only an explicit link to this exact source cue can enable automatic playback.
  cues.forEach((c, i) => {
    c.follow = Boolean(i > 0 && c.follow && c.followFrom === cues[i - 1].id);
    c.followFrom = c.follow ? c.followFrom : null;
  });
  return { ...meta, name: meta.name || title || "Imported sequence", cues };
}
export function validateSequence(input, media) {
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 150
  )
    throw new Error("Sequence name must be 1–150 characters.");
  if (!Array.isArray(input.cues) || input.cues.length > 500)
    throw new Error("A sequence can contain up to 500 cues.");
  const ids = new Set();
  const source = input.cues.map((c) => ({
    ...c,
    id: c.id || crypto.randomUUID(),
  }));
  return {
    name: input.name.trim(),
    description: String(input.description || "").slice(0, 1000),
    cues: source.map((c, index) => {
      const m = media[c.mediaId];
      if (!m) throw new Error("A cue refers to missing media.");
      const num = (v, d) => (v == null ? d : Number(v));
      const volume = num(c.volume, 100),
        speed = num(c.speed, 1),
        start = num(c.start, 0),
        end = num(c.end, m.duration);
      if (
        ![volume, speed, start, end].every(Number.isFinite) ||
        volume < 0 ||
        volume > 200 ||
        speed < 0 ||
        speed > 4 ||
        start < 0 ||
        end <= start ||
        end > m.duration + 0.1
      )
        throw new Error("Check cue gain, speed, and trim times.");
      if (c.id && ids.has(c.id)) throw new Error("Duplicate cue ID.");
      const id = c.id || crypto.randomUUID();
      ids.add(id);
      const loop = c.loop === "forever" ? "forever" : num(c.loop, 1);
      if (
        loop !== "forever" &&
        (!Number.isInteger(loop) || loop < 1 || loop > 10000)
      )
        throw new Error("Loop count must be 1–10,000 total plays or forever.");
      const previous = source[index - 1]?.id;
      const from =
        c.followFrom === undefined && c.follow ? previous : c.followFrom;
      const linked = Boolean(c.follow && previous && from === previous);
      return {
        id,
        mediaId: m.id,
        name: m.name,
        volume,
        speed,
        loop,
        start,
        end,
        follow: linked,
        followFrom: linked ? previous : null,
      };
    }),
  };
}
