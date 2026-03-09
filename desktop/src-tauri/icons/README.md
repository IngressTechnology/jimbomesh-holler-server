# App Icons

Tauri requires platform-specific icon files. Generate them from the source SVG:

```bash
# Install the Tauri icon generator
cargo install tauri-cli

# From the desktop/ directory, generate all icon sizes from the source SVG:
cd desktop
npx @tauri-apps/cli icon ../admin/assets/favicon.svg
```

This produces all required files in this directory:
- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

Alternatively, use any SVG-to-ICO/ICNS converter with the source at
`admin/assets/favicon.svg` (512x512 JimboMesh whiskey glass logo).
