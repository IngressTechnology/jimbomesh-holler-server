# Admin UI Customization

## Quick Start

1. Edit `theme.css` to override brand colors
2. Replace `logo.svg` with your own logo (recommended: 200×48px)
3. Replace `favicon.svg` with your own icon (recommended: 32×32px)
4. Restart the server

## CSS Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `--accent` | `#0d9488` | Primary brand color (buttons, links, active tabs) |
| `--accent-hover` | `#14b8a6` | Hover state for accent |
| `--accent-glow` | `rgba(13,148,136,0.15)` | Glow/shadow effect color |
| `--secondary` | `#f97316` | Secondary highlight color |
| `--bg-primary` | `#0f172a` | Page background |
| `--bg-secondary` | `#1e293b` | Card/panel background |
| `--bg-tertiary` | `#273548` | Hover/active backgrounds |
| `--text-primary` | `#f8fafc` | Main text color |
| `--text-secondary` | `#94a3b8` | Muted text |
| `--success` | `#22c55e` | Success indicators |
| `--warning` | `#eab308` | Warning indicators |
| `--error` | `#ef4444` | Error indicators |
| `--radius` | `8px` | Border radius |

## Logo Requirements

- **logo.svg**: Main login page logo. Recommended max height 48px.
- **favicon.svg**: Browser tab icon + header icon. Square, works at 16–32px.
- SVG preferred (crisp at all sizes). PNG also works.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOLLER_SERVER_NAME` | `Holler Server` | Displayed in login title and header |
| `HOLLER_ADMIN_TITLE` | `JimboMesh Holler Server — Admin` | Browser tab title |

Set these in `.env` to customize the name without editing any code.

## Example: Blue Theme

```css
:root {
  --accent: #3b82f6;
  --accent-hover: #60a5fa;
  --accent-glow: rgba(59, 130, 246, 0.15);
  --secondary: #a855f7;
}
```

## Example: Green Theme

```css
:root {
  --accent: #22c55e;
  --accent-hover: #4ade80;
  --accent-glow: rgba(34, 197, 94, 0.15);
  --bg-primary: #0a0f0d;
  --bg-secondary: #131b16;
}
```

## File Reference

| File | Purpose |
|------|---------|
| `theme.css` | User-editable CSS overrides (loaded after defaults) |
| `logo.svg` | Login page logo |
| `favicon.svg` | Browser tab icon and header icon |
| `README.md` | This file |

See [docs/CUSTOMIZATION.md](../../docs/CUSTOMIZATION.md) for the full theming guide.
