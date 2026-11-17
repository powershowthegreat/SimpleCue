# SimpleCue

A/V cue player with a plain HTML/JavaScript frontend, compiled Tailwind CSS, Inter, an Express backend, and optional Upstash Redis. Includes a compact editor, track-level production players, media management, IndexedDB offline caching, adjustable panel sizes, accent colors, and light/dark themes.

## Run locally

Requires Node.js 22.9+ (Node 24 works).

```sh
npm ci
cp .env.example .env
npm run build
npm run dev
```

Open http://localhost:3000 and sign in with **admin / admin**. If `.env` is already configured, keep it instead of copying the example. This workspace’s supplied Upstash credentials are in the ignored `.env` only.

- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to use Redis. If both are empty, development uses `data/database.json`.
- Account usernames and plaintext passwords are managed in `config/users.json`, as requested. Sessions use an HTTP-only cookie and expire after seven days. Restart/redeploy after changing accounts.
- Set `UPSTASH_BLOB_TOKEN` to use Upstash Blob for media locally and on serverless hosting. Media uploads go directly from the browser to Upstash, with multipart transfer for large files (up to 500 MB). The token stays server-side.
- Without a Blob token, local development can still use the disk upload fallback in `data/uploads`. Serverless deployments require Upstash Blob for uploads.
- `npm run dev` watches backend code. After changing frontend source, run `npm run build` and refresh the page to update compiled Tailwind CSS.

## Deploy to Vercel

Import this repository into a Vercel project. `vercel.json` specifies the build command, public output, Node serverless entry point at `api/index.js`, and API rewrites. It does not start a listening server on Vercel.

1. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the Vercel project’s environment settings. Use the supplied values privately; they are never included in the frontend.
2. Set `UPSTASH_BLOB_TOKEN` to the token from your Upstash Blob bucket. Both public and private buckets are supported. Allow your site’s origin in the bucket CORS settings for direct uploads, waveform decoding, and Web Audio playback. The browser must be allowed to send the signed PUT headers and read `ETag`.
3. Deploy. Build command: `npm run build`. Output directory: `public`. Framework preset: Other (configured in `vercel.json`).
4. Sign in as **admin / admin**. Edit `config/users.json` and redeploy to change accounts.

Uploaded media and M3U files use Upstash Blob; workspace metadata, preferences, sessions, and an immediately readable M3U copy use Upstash Redis. No Vercel database or storage service is required; Vercel can remain the application host.

Authenticated upload requests only authorize/sign transfers and register completed files. Media bytes go directly to Upstash storage. The Upstash SDK checks signed completion receipts, object size, and ownership. Registration is idempotent. If Redis briefly fails after an upload, the object is kept and `/api/media/upstash-complete` can finish registration using its signed object metadata.

Media records retain a stable `/api/media/:id/file` URL. The backend redirects it to a fresh, short-lived Upstash read URL, so private-bucket URLs never expire inside saved sequences. The storage URL supports range reads for seeking. Downloads, IndexedDB caches, and waveforms use the same route.

Redis stores metadata, preferences, expiring sessions, and the workspace copy of complete extended-M3U documents; saves also write the M3U file to `simplecue/sequences/` in Upstash Blob. Serverless instances never depend on durable local disk. Local mode also writes edited/imported M3U documents to `data/sequences`. Use different `REDIS_PREFIX` values to separate installations.

To move existing local or legacy uploads to Upstash, run:

```sh
node --env-file-if-exists=.env scripts/migrate-media.mjs
```

The migration copies and verifies each media object before changing its media record, and mirrors existing M3U files into Upstash Blob. It keeps media IDs, filenames, sequence references, and the local original files. Already migrated files are skipped, so rerunning is safe. The generated demo audio remains a static application asset.

## Playback and editing

- Add media using the `+` beside a library file or drag it into the sequence. Drag any track by its header to reorder it. Drag panel dividers to resize the sidebar and master output; drag media-table column edges to resize columns. Player output defaults to 15% of workspace width.
- Each track has play/pause, reset, stop, a waveform, and elapsed/total timing. The waveform always shows the full original file, with darkened trimmed regions, In/Out markers, and full-file/crop timing labels. Click or drag the waveform to seek within the allowed interval; a focused waveform also supports Left/Right (5 seconds) and Home/End.
- All timing displays use `MM:SS.cc`. In/Out fields use `MM:SS:cc` (minutes:seconds:hundredths), such as `00:01:25` for 1.25 seconds. Press Enter or leave the field to apply; Escape cancels an edit. Right-click a waveform and choose **Set crop In here** or **Set crop Out here** to use that absolute source-file position. Choices that would cross the current trim boundaries are disabled. Progress and In/Out are absolute source-file positions: a 1–4 second crop resets to `00:01.00` and ends at `00:04.00`. Sequence totals account for trim length and speed.
- Gain and speed have 0–200% sliders. Speed has a labeled 100% midpoint for normal playback. Cue and master gain above 100% amplify audio through Web Audio; master gain multiplies cue gain. Click either percentage to enter a number. Speed 100% is normal; 0% pauses the cue. M3U imports also preserve existing rates above 1×.
- On completion, the next cue becomes active and waits. Open **Config** on the current cue and turn **Linkage: to next** on to start its specific next cue automatically. Links store the exact source cue ID; reordering cannot transfer a link to a different preceding cue. Next/previous shortcuts select a cue without starting it.
- In **Config**, set **Loop** to Off, **N times**, or **Forever**. N is the total number of plays, including the first. Each repeat uses the current In/Out range. Linkage runs after the final counted play; forever keeps the cue active until stopped or another cue is selected. Active settings appear next to Config (for example, `loop 3x | autoplay next`) and persist in M3U files and offline caches. Use the Duplicate/Delete buttons beside each cue’s cache button.
- Enter a bold **Cue word** beside the file type in Editor; Player displays it beside the same track. Clicking a track selects it without starting playback.
- **Fade in** and **Fade out** in Config are independent durations in seconds. Playback fades in on play/resume. The end of each trimmed play fades out; pause and stop also fade to silence before taking effect. Stop then resets to the In point. Durations are limited to available playback time.
- The production Player opens the editor’s active sequence. Its output panel lists browser-detected output devices. Entering Player requests output-device access if needed; on browsers that require microphone permission to expose device labels, the permission stream is stopped immediately. Device names and routing depend on browser support and HTTPS/localhost. Connected Bluetooth outputs appear when exposed by the browser; otherwise use system audio settings.
- Defaults: Space = play/pause, Right = next, Left = previous, R = reset. Ctrl+S / Cmd+S saves to the server when online, or to the local outbox when offline, and refreshes the active sequence’s local copy when cached; it commits the currently edited crop/gain/speed value, or submits an open configuration form. Change these in workspace settings. Shortcuts are suspended while typing, editing a dialog, or using a waveform/divider.
- Waveforms are decoded from the media’s actual audio. Video preview appears in its active track. Browser codec support determines which files can play; unsupported/very large waveform decodes show a clear fallback.

## Files and offline use

Sequence downloads are standard extended M3U with `#EXTINF` entries. SimpleCue additionally writes `#SIMPLECUE` JSON metadata and `#CUE` JSON per-track settings, including cue words, cuts, speed, gain (the compatible `volume` field), loop counts, fades, and exact follow links. Upload referenced media before importing an M3U. Third-party players may ignore custom settings.

Cache a file, an entire sequence, or selected Media rows using IndexedDB. Caching a sequence includes its M3U and all its media. Uncaching a sequence retains media needed by another cached sequence. Cached sequences can be edited offline, including cue words, trims, gain, speed, fades, links, looping, track order, and sequence details. Edits are written immediately to IndexedDB and a durable per-account outbox; they sync after connectivity returns. New sequences can also be built offline using cached media. The Online/Offline badge beside sync status reports connectivity. Settings → **Offline mode** explicitly holds all queued edits on this device, even if the network is available. Turn it off to resume syncing. Closing/reloading does not discard pending edits, and server snapshots are merged with local drafts before display.

File names can be edited inline in Media. The original extension is retained, and media IDs and storage object paths never change. Existing playlist references are regenerated; prior filenames remain aliases for older M3U imports. Offline renames are queued too. Uploading or deleting media bytes requires a connection.

Missing/unavailable media is not repeatedly fetched on redraw, and uncached media is never requested in offline mode. Permanent sync errors are retained locally and shown in sync details rather than retried on every edit. A service worker caches the application shell after its first online visit so the last signed-in workspace can be reloaded offline. Browser quotas and clearing site data affect this device’s cache.

## Verify

```sh
npm run build
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

API/store/M3U tests use isolated temporary local databases. Browser tests cover editable sliders, waveform seeking, compact layouts, centered dialogs, accent and dark themes, panel resizing, track dragging, device labels, FLAC uploads, HTML gateway errors, explicit follow behavior, counted/forever loops, measured gain amplification, Ctrl/Cmd+S cache refresh, offline reload/playback, and mobile overflow. Tests never change the configured Redis database.

Six original synthesized WAV samples and three example sequences are installed once on first use. They can be edited/deleted. Samples are generated by `scripts/build.mjs`; no third-party recordings are included.

Implementation references: [Tailwind CLI](https://tailwindcss.com/docs/installation/tailwind-cli), [Upstash REST API](https://upstash.com/docs/redis/features/restapi), [Upstash Blob uploads](https://upstash.com/docs/blob/uploads/upload-handler), [browser output routing](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId).
