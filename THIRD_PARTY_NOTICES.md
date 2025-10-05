Third-Party Notices
===================

This project bundles third-party software inside `extension/vendor/ffmpeg/esm/` to enable optional local MP4 conversion. Below are the attributions, licenses, and source links.

ffmpeg.wasm
------------
- Package: `@ffmpeg/ffmpeg` (wrapper and ESM glue used by the extension)
- License: MIT
- Source: https://github.com/ffmpegwasm/ffmpeg.wasm

Notes: The wrapper provides a JavaScript API to a WebAssembly build of FFmpeg. The wrapper itself is MIT-licensed.

FFmpeg (WebAssembly core)
-------------------------
- Project: FFmpeg
- License: Primarily LGPL 2.1+, but certain configurations (including with `--enable-gpl` or linking GPL libraries like x264) are GPL. The prebuilt core included here is configured with GPL options and is thus covered by the GPL.
- Source: https://github.com/FFmpeg/FFmpeg
- License details: https://ffmpeg.org/legal.html
 - License text included: see `licenses/GPL-2.0.txt` and `licenses/LGPL-2.1.txt`.

x264
-----
- Project: x264 (H.264/AVC encoder)
- License: GPL 2.0 or later
- Source: https://code.videolan.org/videolan/x264
 - License text included: see `licenses/x264-COPYING.txt` (GPL v2).

Build configuration (as embedded in the wasm binary)
----------------------------------------------------
The included FFmpeg WebAssembly binary contains an embedded configuration line such as:

  --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm --disable-stripping \
  --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect --disable-autodetect \
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
  --extra-cflags='-I/opt/include -O3 -msimd128' --extra-cxxflags='-I/opt/include -O3 -msimd128' \
  --disable-pthreads --disable-w32threads --disable-os2threads \
  --enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx --enable-libmp3lame \
  --enable-libtheora --enable-libvorbis --enable-libopus --enable-zlib --enable-libwebp \
  --enable-libfreetype --enable-libfribidi --enable-libass --enable-libzimg

This indicates GPL-enabled features (e.g., `--enable-gpl`, `--enable-libx264`). As a result, the distributed FFmpeg core falls under the GPL.

Complete Corresponding Source (CCS)
-----------------------------------
If you redistribute this extension with the FFmpeg wasm core, you must comply with the GPL’s source requirements for that binary. You can:

- Obtain source code from upstream projects:
  - FFmpeg: https://github.com/FFmpeg/FFmpeg
  - x264: https://code.videolan.org/videolan/x264
  - ffmpeg.wasm build scripts and integration: https://github.com/ffmpegwasm/ffmpeg.wasm
- Or rebuild the wasm core using the ffmpeg.wasm toolchain to produce identical or equivalent binaries.

Offer to provide source: The maintainers of this project will provide the Complete Corresponding Source for the included FFmpeg/x264 components upon request for at least three (3) years from your copy’s distribution date. Please open an issue in this repository with your request.

Patents and usage
------------------
- Some codecs (e.g., H.264, AAC) may be covered by patents in certain jurisdictions. Ensure you have the right to use these codecs.
- This tool is intended for lawful, authorized use only. Do not use it to violate terms of service, infringe copyrights, or bypass DRM/technical protection measures.
