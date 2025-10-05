Privacy Policy — HLS Finder & Downloader
=======================================

Last updated: 2025-10-05

Summary
-------
- This extension does not collect, transmit, or sell personal data.
- All detection, download, and optional conversion happen locally in your browser.
- No analytics, no tracking, no calls to third‑party servers beyond the media sites you visit.

What the extension does
-----------------------
- Detects media URLs in the active tab (HLS `.m3u8`, DASH `.mpd`, and direct MP4/WebM) using `webRequest` and a content script that observes `fetch`/XHR.
- Shows detected URLs in the popup and lets you download streams as `.ts` or convert to `.mp4` locally via `ffmpeg.wasm` (WebAssembly) in an offscreen document.
- All processing is on‑device; the extension does not proxy or relay your traffic.

Data processed
--------------
- Media URLs: `.m3u8`, `.mpd`, and direct media file URLs from the active tab.
- Initiator origin (e.g., page origin) for referrer context.
- Job metadata: ephemeral IDs, progress values, filenames you choose for downloads.
- Preference: optional per‑domain quality selection stored in `chrome.storage.local`.

Storage and retention
---------------------
- Session data: detected URLs are kept in memory and in `chrome.storage.session` (cleared when the browser session ends or tabs close).
- Preferences: quality preferences are stored in `chrome.storage.local` until you remove the extension or clear site/extension data.
- No other persistent data is stored.

Data transfers
--------------
- The extension does not send data to any external server under the developer’s control.
- Network activity is limited to: the media pages you visit and the media segment requests required to download/convert content you initiate.

Permissions (purpose)
---------------------
- `webRequest`: detect media requests to list candidate streams.
- `downloads`: save files you explicitly download.
- `storage`: remember UI preferences and session state.
- `offscreen`: run long‑lived jobs (download/convert) without blocking the UI.
- `scripting`: inject a minimal detector to observe page `fetch`/XHR.
- `host_permissions: <all_urls>`: find media across sites (you can restrict this before publishing).

User controls
-------------
- You can remove the extension at any time from `chrome://extensions`.
- Clear stored preferences/session data via browser data clearing tools or by removing/reinstalling the extension.
- You control when downloads/conversions start and which files are saved.

Security and content responsibility
-----------------------------------
- Do not use this tool to violate site terms, copyrights, or bypass DRM/technical protections.
- The extension does not handle DRM‑protected streams.

Changes to this policy
----------------------
- Material changes will be reflected in this file. Version history is available via the repository’s commit history.

Contact
-------
- For privacy questions or requests, please open an issue in this repository.

