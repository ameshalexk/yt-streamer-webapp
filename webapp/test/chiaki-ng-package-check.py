#!/usr/bin/env python3
"""Check pinned Chiaki runtime package checksums and source-offer contents."""

import hashlib
import json
import tarfile
import unittest
from pathlib import Path


PACKAGE = Path(__file__).parents[1] / "tesla-remote-play/vendor/chiaki-ng-web"


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


class ChiakiPackageCheck(unittest.TestCase):
    def test_manifest_matches_runtime_artifacts_and_source_bundle(self) -> None:
        manifest = json.loads((PACKAGE / "SOURCE-MANIFEST.json").read_text())
        self.assertEqual(manifest["revision"], "70669b47a16376768001db229e3e8c3baf3e5238")
        for name, facts in manifest["artifacts"].items():
            artifact = PACKAGE / name
            self.assertEqual(artifact.stat().st_size, facts["bytes"])
            self.assertEqual(digest(artifact), facts["sha256"])
        source = PACKAGE / manifest["source_bundle"]["file"]
        self.assertEqual(digest(source), manifest["source_bundle"]["sha256"])

    def test_source_bundle_has_build_sources_and_excludes_upstream_media(self) -> None:
        with tarfile.open(PACKAGE / "chiaki-ng-web-source.tar.gz", "r:gz") as archive:
            names = set(archive.getnames())
        for required in (
            "chiaki-ng-web/CMakeLists.txt",
            "chiaki-ng-web/wasm/CMakeLists.txt",
            "chiaki-ng-web/wasm/src/chiaki_wasm.c",
            "chiaki-ng-web/wasm/proxy/server.mjs",
            "chiaki-ng-web/third-party/gf-complete/src/gf_cpu.c",
            "chiaki-ng-web/external/mbedtls/CMakeLists.txt",
            "chiaki-ng-web/external/opus/CMakeLists.txt",
            "chiaki-ng-web/external/opus/package_version",
            "chiaki-ng-web/build-patches/gf-complete-prototype-fix.patch",
            "chiaki-ng-web/CORRESPONDING-SOURCE-BUILD.md",
        ):
            self.assertIn(required, names)
        self.assertFalse(any(name.startswith("chiaki-ng-web/assets/") for name in names))
        self.assertFalse(any(name.startswith("chiaki-ng-web/wasm/www/") for name in names))
        self.assertFalse(any(name.lower().endswith((".key", ".pem", ".sqlite", ".db")) for name in names))

    def test_license_and_offer_material_exists(self) -> None:
        for name in (
            "AGPL_SOURCE_OFFER.md",
            "NOTICE.txt",
            "licenses/AGPL-3.0-only.txt",
            "licenses/AGPL-3.0-only-OpenSSL-exception.txt",
            "licenses/gf-complete-License.txt",
            "licenses/jerasure-License.txt",
            "licenses/nanopb-License.txt",
            "licenses/mbedtls-LICENSE.txt",
            "licenses/opus-COPYING.txt",
            "licenses/Emscripten-LICENSE.txt",
            "licenses/musl-COPYRIGHT.txt",
        ):
            self.assertTrue((PACKAGE / name).is_file(), name)


if __name__ == "__main__":
    unittest.main()
