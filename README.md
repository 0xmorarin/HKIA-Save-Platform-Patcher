# HKIA Save Platform Patcher

A browser-local converter for **raw** Hello Kitty Island Adventure saves. Desktop Chrome/Edge is the target.

## Supported platform groups

| Group | Source PlatformType | Output PlatformType | DLC platform value |
| --- | --- | --- | --- |
| Steam | `1` | `1` | `4` |
| Nintendo Switch | `9` | `9` | `3` |
| Apple Arcade | `4`, `5`, `6`, `7` | `7` | `2` |
| PlayStation 5 | `10` | `10` | `5` |

Switch 2 Edition (`12`) is not supported. The PS5 export is **a raw payload**, not a PS5 native encrypted save container. Actual console/device re-import and game loading on PS5 and Apple Arcade remain untested. Apple output filename `Save_HeroesFate_<slot>.save` and PS5 raw export filename `save_<slot>.save` are provisional until confirmed on target devices.

## Usage

Start a local static server in the folder:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Open <http://127.0.0.1:8765/> in desktop Chrome/Edge. Drag a save onto the page or choose one; source platform, version and play time appear. Click one of the other three platform buttons to convert and download. The filename must contain a slot number using `save_<slot>.save` or `Save_HeroesFate_<slot>.save`; leading zeroes are preserved. Unknown slots, unsupported platform IDs, damaged/missing LZ4 payloads and invalid DLC data are rejected rather than guessed. Original input bytes are not mutated, and no third-party network service is used by the converter.

## Development tests

```sh
node tests/test_synthetic_backend.mjs
node tests/test_backend.mjs /path/to/steam/save_0.save /path/to/switch/save_0.save
python tests/test_browser_native_modules.py /path/to/steam/save_0.save /path/to/switch/save_0.save
```

The browser test requires Python Playwright and a local Chromium installation; it uses in-memory browser `Blob` ES modules because the CI sandbox may restrict networking. Neither fixture nor generated saves are included in this repository. The software can only verify raw-data conversion statically; no unsupported promise of cross-version save loading is made.

## Attribution

This development branch builds on [capibawa's original PR #1](https://github.com/0xmorarin/HKIA-Save-Platform-Patcher/pull/1). Keep the original PR commit `4a27b8f936218afb12c30b3b6d2bdc5264feaa8b` in Git history when integrating. The UI and compatibility updates should be a follow-on maintainer commit, not a squash of the contributor's authored change.
