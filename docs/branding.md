# Branding: the CrewAtlas logo and name

**The code license and the brand rights are separate.** The [PolyForm Noncommercial License 1.0.0](../LICENSE) covers the source code of this repository. It does **not** cover the CrewAtlas name, the logo and the other brand images listed below.

## Assets

| File | Use |
|---|---|
| `assets/brand/crewatlas-logo.svg`, `.png` | Logo badge (teal rounded square, transparent corners). README, social preview, any background. |
| `assets/icon.png` | Full-bleed app icon: legacy launcher icons and the login screen. |
| `assets/icon_fg.png` | Adaptive icon foreground (transparent). |
| `assets/icon_mono.png` | Adaptive icon monochrome layer for Android 13+ themed icons. |
| `assets/brand/social-preview.png` | GitHub social preview, 1280 x 640. Upload it in the repository settings, it is not picked up automatically. |
| `assets/brand/*.svg`, `generate_svgs.py` | Vector sources and the script that draws them. |

Palette: teal `#00897B` (also the app theme seed), deep teal `#00574F` for the route lines, coral `#FF7043` for the meeting point, white. The Android launcher resources under `android/app/src/main/res/` (`ic_launcher*`) are generated from these files.

Regenerate:

```bash
python3 assets/brand/generate_svgs.py                      # SVG sources
rsvg-convert -w 1024 -h 1024 assets/brand/crewatlas-logo.svg -o assets/brand/crewatlas-logo.png
dart run flutter_launcher_icons                            # Android launcher icons from pubspec.yaml
```

## Rights and terms

- The name "CrewAtlas" and the logo are not licensed under PolyForm. No trademark or other brand license is granted by this repository (the PolyForm text itself says that it implies no licenses beyond those it lists). All rights are reserved by the copyright holder named in [NOTICE](../NOTICE), to the extent such rights exist.
- If you redistribute or fork the software, replace the name, the logo and the launcher icons with your own, and do not suggest that your version is the official one or endorsed by the author.
- This does not restrict what the law allows without permission, for example fair use and referring to the project by name.
- Permission for any other use of the brand: contact the author through the GitHub profile in the README.

## Origin of the logo

The current logo was drawn as SVG from basic geometric shapes (a circle, three curves, dots) with the help of an AI assistant. It contains no third-party artwork, stock icons, fonts or photographs, and no people. Because AI-assisted material may have limited or no copyright protection in some jurisdictions, no exclusive copyright is claimed beyond what the law grants. The previous icon (an illustration of people) and its source images are not part of the published repository.
