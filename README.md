HLS Finder & Downloader (Chrome Extension)
=========================================

Features
- Detects HLS `.m3u8` URLs in the active tab (via `webRequest`).
- Shows the URLs in the extension popup.
- Downloads the stream into a single `.ts` file.
- Optional: converts locally to `.mp4` using ffmpeg.wasm (beta; slow for long videos).
- HLS fMP4 (EXT-X-MAP) support: concatenates init+segments and attempts MP4 remux.
- Progress bar for download and conversion.
- Also detects direct MP4/WebM and DASH manifests (.mpd) with MP4 download (beta; clear, non-DRM streams only; SegmentList/SegmentTemplate with SegmentTimeline).

Limitations
- Playlists encrypted with `#EXT-X-KEY` are not supported yet.
- Some sites may block downloads via CORS/anti-bot.
- MP4 conversion requires bundling ffmpeg.wasm binaries inside the extension (see below) and can be very slow.
- DASH: basic support for clear streams without DRM; common cases are handled (SegmentList and SegmentTemplate with SegmentTimeline). DRM (Widevine/CENC) is not supported.

Install in Chrome (Developer mode)
1. Open `chrome://extensions` and enable "Developer mode" (top-right).
2. Click "Load unpacked" and select this project's `extension/` folder.
3. Open a page with a video (HLS) and play it: the extension icon will show the URLs found.

MP4 conversion (ffmpeg.wasm)
To enable the "Download MP4 (beta)" button, add the ffmpeg.wasm files at:

```
extension/vendor/ffmpeg/esm/
  (copy the entire contents of `node_modules/@ffmpeg/ffmpeg/dist/esm/`,
   including `index.js`, `worker.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`, etc.)
```

These files come from the `@ffmpeg/ffmpeg` package.
- Repo: https://github.com/ffmpegwasm/ffmpeg.wasm
- NPM: `npm install @ffmpeg/ffmpeg`

Copy the files from `node_modules/@ffmpeg/ffmpeg/dist/esm/*` into the folder above. MV3 does not allow remote code, so the files must be part of the extension.

Usage
- Open the page with the video.
- Click the extension icon to see the list of intercepted `.m3u8` URLs.
- "Copy URL": copies the playlist URL.
- "Download TS": downloads and concatenates segments into a single `.ts` file.
- "Download MP4 (beta)": downloads segments and converts locally to `.mp4` with ffmpeg.wasm.
- If the playlist is a master, choose the resolution from the menu; the preference is remembered per domain.

Technical notes
- Manifest V3 with a service worker in `src/background.js` and an offscreen document `src/offscreen.html`.
- Minimal HLS parsing: picks the variant with the highest `BANDWIDTH` when the playlist is a master, then downloads segments from the media playlist.
- No current support for `EXT-X-KEY` (AES-128/SAMPLE-AES). If present, an error is shown.

**Privacy**
- Data: processes media URLs locally; no analytics, no tracking, no external servers.
- Storage: session cache and optional quality preference only.
- Policy: see `PRIVACY_POLICY.md`.

**Licenses & Legal**
- Project license: MIT (see `LICENSE.md`).
- ffmpeg.wasm wrapper: `@ffmpeg/ffmpeg` is MIT-licensed.
- FFmpeg core (WebAssembly): the prebuilt binary bundled under `extension/vendor/ffmpeg/esm/` is a build of FFmpeg configured with GPL options and `libx264` enabled. This means redistribution of the extension must comply with GPL requirements for that binary. In particular:
  - Include GPL license text and notices for FFmpeg/x264 in your distribution.
  - Provide or offer the Complete Corresponding Source (CCS) for the specific binaries you distribute. You can obtain source from upstream projects listed below; if you redistribute this extension, keep an accessible offer (e.g., via your repo issues) to provide the CCS for at least three years.
- Patents/codecs: H.264/AAC and other codecs may be subject to patents in some jurisdictions. Ensure you have the right to use these codecs.
- Usage: This tool is for personal/use-with-permission only. Do not use it to violate terms of service, infringe copyrights, or bypass DRM/technical protection measures.

Sources and notices for third‑party components are summarized in `THIRD_PARTY_NOTICES.md`.

Included license texts
- `licenses/GPL-2.0.txt` (official GNU GPL v2 text)
- `licenses/LGPL-2.1.txt` (official GNU LGPL v2.1 text)
- `licenses/x264-COPYING.txt` (x264 COPYING; GPL v2)
