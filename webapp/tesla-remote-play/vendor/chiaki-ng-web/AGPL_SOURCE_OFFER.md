# Chiaki-NG Web Edition source offer

The browser player uses `chiaki.js` and `chiaki.wasm` built from Chiaki-NG Web Edition revision `70669b47a16376768001db229e3e8c3baf3e5238`. The corresponding source bundle and its checksum manifest are in this directory.

The authenticated owner player route must expose `chiaki-ng-web-source.tar.gz` and `SOURCE-MANIFEST.json` to each person allowed to use the player. Keep the offer under the same authentication and authorization as the player. The route is intended to satisfy the source offer for this network service and the delivered browser object code under AGPLv3 sections 6 and 13.

The archive contains the pinned upstream build source, the exact `gf-complete`, Jerasure, and nanopb submodule source revisions, exact mbed TLS and Opus FetchContent source revisions, and the gf-complete prototype correction applied for the S0 build. The `assets/`, upstream GUI media/source, upstream static UI, documentation, Electron UI, test fixtures, and test key material are omitted because this feature uses a focused Streamer client. The archive includes `CORRESPONDING-SOURCE-BUILD.md` and `build-patches/gf-complete-prototype-fix.patch`.

The root AGPLv3 text, COPYING, OpenSSL linking exception, generated Emscripten runtime license, musl license, and included third-party license texts are in `licenses/`. `SOURCE-MANIFEST.json` records source and runtime artifact SHA-256 digests and all pinned source revisions. `NOTICE.txt` identifies the upstream and dependency licenses.

This offer covers the pinned upstream runtime source. The Streamer integration and its packet relay implementation must also remain available as corresponding source at the exact public Streamer revision associated with each release. The authenticated source endpoint should link to that revision or serve the matching source snapshot alongside this bundle.
