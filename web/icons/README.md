# Service letter avatars

The 80 supplier and agent SVG files in this directory are original EasySwitch
letter avatars. They use ordinary text and, for colored variants, a rounded tile.
They contain no vendor logo paths, embedded fonts, external resources, or animation.
Service names and initials identify the existing provider and agent mappings; the
avatars are not official brand marks.

Regenerate the exact assets and manifest with:

```
node scripts/provider-icons.mjs
```

The explicit catalog in that script keeps the existing filenames stable, including
aliases used by saved configurations. Plain filenames are transparent monochrome
letters so the console's mask fallback still works before the manifest loads.
Files ending in `-color.svg` use a color derived deterministically from the service
label. The manifest continues to classify the actual SVG content.

## Historical attribution

These avatars replace previously vendored marks. Historical sources and notices
remain in `PROVENANCE.md`, `third_party/lobe-icons/LICENSE`, and
`third_party/opencodex-provider-icons/{LICENSE,SOURCES.md}`; replacing the current
asset bytes does not remove those records or assert that past assets were original.

The prior `kiro-color.svg` header identified <https://kiro.dev/icon.svg> (fetched
2026-05-31). The prior `cursor-color.svg` header identified
<https://cursor.com/en-US/brand> (`brand-logo-7.svg`, cropped to an app icon).
These are historical source references only; regeneration does not download or
reuse those assets.

EasySwitch's own product icons are outside this directory and are not generated
or changed by this script.
