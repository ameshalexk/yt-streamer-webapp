#!/usr/bin/env python3
"""Package the pinned Chiaki-NG Web Edition runtime and its source offer."""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import tarfile
from pathlib import Path


REVISION = "70669b47a16376768001db229e3e8c3baf3e5238"
EMSCRIPTEN_COMMIT = "708dcbcc9ee23bc7d2dad44fc90db377e38b771c"
SUBMODULES = {
    "third-party/gf-complete": "fa54a4670a5705c84abf6c24b92b0cd479625478",
    "third-party/jerasure": "505ccb4bc69eee8d7ea40a6089a056b99671134f",
    "third-party/nanopb": "e9e6eb5b4b57c69afe6161094e3996e322701e87",
}
FETCH_CONTENT = {
    "mbedtls": "8b3f26a5ac38d4fdccbc5c5366229f3e01dafcc0",
    "opus": "ddbe48383984d56acd9e1ab6a090c54ca6b735a6",
}
PATCH = b"""diff --git a/src/gf_cpu.c b/src/gf_cpu.c
index f65131f..3200355 100644
--- a/src/gf_cpu.c
+++ b/src/gf_cpu.c
@@ -171,10 +171,9 @@ void gf_cpu_identify(void)
\x20
 #else // defined(__arm__) || defined(__aarch64__)
\x20
-int gf_cpu_identify(void)
+void gf_cpu_identify(void)
 {
     gf_cpu_identified = 1;
-    return 0;
 }
\x20
 #endif
"""


def run(*args: str, cwd: Path) -> bytes:
    return subprocess.check_output(args, cwd=cwd)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def add_git_archive(archive: tarfile.TarFile, repository: Path, revision: str, prefix: str) -> None:
    data = run("git", "archive", "--format=tar", revision, cwd=repository)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as source:
        for member in source.getmembers():
            relative = member.name
            if prefix == "chiaki-ng-web" and (
                relative.startswith(("assets/", "docs/", "gui/", "wasm/www/", "wasm/electron/", "wasm/proxy/certs/", "scripts/holepunch/"))
            ):
                continue
            if relative.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".icns", ".ico", ".pdf")):
                continue
            if any(part in {"tests", "test", "testdata", "data_files"} for part in Path(relative).parts):
                continue
            if relative.lower().endswith((".key", ".pem", ".sqlite", ".db")):
                continue
            member.name = f"{prefix}/{member.name}"
            archive.addfile(member, source.extractfile(member) if member.isfile() else None)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--build-output", required=True, type=Path)
    parser.add_argument("--dependencies", required=True, type=Path)
    parser.add_argument("--emscripten-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    checkout = args.checkout.resolve()
    output = args.output.resolve()
    build_output = args.build_output.resolve()
    dependencies = args.dependencies.resolve()
    emscripten_root = args.emscripten_root.resolve()
    if run("git", "rev-parse", "HEAD", cwd=checkout).decode().strip() != REVISION:
        raise SystemExit(f"Expected pinned Chiaki revision {REVISION}")
    for submodule, revision in SUBMODULES.items():
        actual = run("git", "rev-parse", "HEAD", cwd=checkout / submodule).decode().strip()
        if actual != revision:
            raise SystemExit(f"Unexpected {submodule} revision {actual}")
    for name in ("chiaki.js", "chiaki.wasm"):
        if not (build_output / name).is_file():
            raise SystemExit(f"Missing built output {build_output / name}")
    for dependency, revision in FETCH_CONTENT.items():
        actual = run("git", "rev-parse", "HEAD", cwd=dependencies / f"{dependency}-src").decode().strip()
        if actual != revision:
            raise SystemExit(f"Unexpected {dependency} dependency revision {actual}")
    emscripten_revision = run("git", "rev-parse", "HEAD", cwd=emscripten_root).decode().strip()
    if emscripten_revision != EMSCRIPTEN_COMMIT:
        raise SystemExit(f"Unexpected Emscripten source revision {emscripten_revision}")

    output.mkdir(parents=True, exist_ok=True)
    for name in ("chiaki.js", "chiaki.wasm"):
        shutil.copyfile(build_output / name, output / name)

    source_bundle = output / "chiaki-ng-web-source.tar.gz"
    with tarfile.open(source_bundle, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        add_git_archive(archive, checkout, REVISION, "chiaki-ng-web")
        for submodule, revision in SUBMODULES.items():
            add_git_archive(archive, checkout / submodule, revision, f"chiaki-ng-web/{submodule}")
        for dependency, revision in FETCH_CONTENT.items():
            add_git_archive(archive, dependencies / f"{dependency}-src", revision, f"chiaki-ng-web/external/{dependency}")
        opus_version = b'PACKAGE_VERSION="1.5.2"\n'
        opus_version_info = tarfile.TarInfo("chiaki-ng-web/external/opus/package_version")
        opus_version_info.size = len(opus_version)
        opus_version_info.mtime = 0
        archive.addfile(opus_version_info, io.BytesIO(opus_version))
        patch_info = tarfile.TarInfo("chiaki-ng-web/build-patches/gf-complete-prototype-fix.patch")
        patch_info.size = len(PATCH)
        patch_info.mtime = 0
        archive.addfile(patch_info, io.BytesIO(PATCH))
        recipe = (
            "# Corresponding source build notes\n\n"
            f"Chiaki-NG Web Edition revision: {REVISION}\n"
            "The three submodules are included at the exact gitlink revisions recorded in SOURCE-MANIFEST.json.\n"
            "Apply build-patches/gf-complete-prototype-fix.patch from the extracted source root before building.\n"
            "Use the pinned source's wasm/CMakeLists.txt with Emscripten 4.0.23, CMake 4.4.3 (Unix Makefiles), "
            "Python 3.11 with protobuf 4.25.3, and native protoc 25.3. Build target chiaki-wasm.\n"
            "The exact mbedtls and opus FetchContent sources are included under external/. Configure with "
            "FETCHCONTENT_SOURCE_DIR_MBEDTLS and FETCHCONTENT_SOURCE_DIR_OPUS pointing to those extracted paths.\n"
            "The opus/package_version file records v1.5.2 because source archives do not carry Git metadata.\n"
            "The build invocation used CHIAKI_ENABLE_WASM=ON, PYTHON_EXECUTABLE, PROTOC, "
            "and CMAKE_BUILD_TYPE=Release.\n"
            "Node.js 26.9.0 serves the resulting wasm/chiaki.js and wasm/chiaki.wasm.\n"
        ).encode()
        recipe_info = tarfile.TarInfo("chiaki-ng-web/CORRESPONDING-SOURCE-BUILD.md")
        recipe_info.size = len(recipe)
        recipe_info.mtime = 0
        archive.addfile(recipe_info, io.BytesIO(recipe))

    licenses = output / "licenses"
    licenses.mkdir(exist_ok=True)
    for relative, target in (
        ("LICENSE", "AGPL-3.0-only.txt"),
        ("COPYING", "COPYING.txt"),
        ("LICENSES/AGPL-3.0-only-OpenSSL.txt", "AGPL-3.0-only-OpenSSL-exception.txt"),
        ("third-party/gf-complete/License.txt", "gf-complete-License.txt"),
        ("third-party/jerasure/License.txt", "jerasure-License.txt"),
        ("third-party/nanopb/LICENSE.txt", "nanopb-License.txt"),
    ):
        shutil.copyfile(checkout / relative, licenses / target)
    shutil.copyfile(dependencies / "mbedtls-src/LICENSE", licenses / "mbedtls-LICENSE.txt")
    opus_license = dependencies / "opus-src/COPYING"
    shutil.copyfile(opus_license, licenses / "opus-COPYING.txt")
    shutil.copyfile(emscripten_root / "LICENSE", licenses / "Emscripten-LICENSE.txt")
    shutil.copyfile(emscripten_root / "system/lib/libc/musl/COPYRIGHT", licenses / "musl-COPYRIGHT.txt")

    manifest = {
        "upstream": "https://github.com/CSystem77/Chiaki-NG-Web",
        "revision": REVISION,
        "submodules": SUBMODULES,
        "fetch_content": FETCH_CONTENT,
        "artifacts": {},
        "source_bundle": {
            "file": source_bundle.name,
            "sha256": sha256(source_bundle),
            "includes": "Pinned upstream source needed for the WASM client and proxy, exact source submodules and FetchContent dependencies, and the applied gf-complete prototype fix. Unrelated GUI art, docs, UI assets, test fixtures, and test key material are omitted.",
        },
        "build": {
            "emscripten": "4.0.23",
            "emscripten_commit": EMSCRIPTEN_COMMIT,
            "cmake": "4.4.3",
            "python": "3.11",
            "protobuf": "4.25.3",
            "protoc": "25.3",
            "node": "26.9.0",
            "target": "chiaki-wasm",
        },
    }
    for name in ("chiaki.js", "chiaki.wasm"):
        manifest["artifacts"][name] = {
            "sha256": sha256(output / name),
            "bytes": (output / name).stat().st_size,
        }
    (output / "SOURCE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "NOTICE.txt").write_text(
        "Chiaki-NG Web Edition browser runtime\n"
        f"Upstream revision {REVISION}\n\n"
        "The chiaki.js and chiaki.wasm files are built from AGPL-3.0-only software. "
        "Corresponding source, build notes, source patch, and dependency license texts are provided here.\n"
        "The build uses Emscripten's generated JavaScript runtime and musl libc. Third-party components "
        "include gf-complete, Jerasure, nanopb, mbed TLS, and Opus. "
        "Their license texts and the OpenSSL linking exception are in licenses/.\n"
        "The authenticated source route must serve chiaki-ng-web-source.tar.gz and SOURCE-MANIFEST.json "
        "to every user who can access this player, as the AGPL network source offer.\n"
    )


if __name__ == "__main__":
    main()
