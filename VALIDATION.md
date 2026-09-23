# Validation

## Version 1.6.9 — mobile position correction

Updated September 23, 2026. A saved icon position from a larger screen is now
clamped to the visible screen when the extension first loads and when it resizes.
The default bottom-left placement remains unchanged when no position was saved.
Two additional regression tests cover initial phone loading, rotation, unchanged
positions, negative coordinates, and default placement. All 42 tests and syntax
checks passed; `git diff --check` found no whitespace errors.

The isolated SillyTavern 1.18.0 host passed Chromium touch-emulation checks at
320 × 568, 360 × 800, 390 × 844, 430 × 932, 844 × 390, 390 × 420, and 768 × 1024.
A real world-info scan populated the active panel and report with duplicate UIDs
and unusual names, including an unbroken 150-character name. Text wrapped within
the available width, and screenshots were visually inspected. A desktop-saved icon
position was visible on the initial 390-pixel-wide load and remained visible after
rotation from 390 × 844 to 844 × 390. No browser page errors were reported.

These are browser-emulation results, not physical-device or Safari tests. The
390 × 420 case checks reduced available height; it does not reproduce a native
mobile keyboard or browser-toolbar behavior.

## Version 1.6.8

Validated on September 12, 2026.

- `npm test`: 40 passing tests covering exact-name parsing, current and legacy
  logs, duplicate UIDs, processing/loop/scan/chat boundaries, historical report
  identifiers, hidden-lorebook filtering, dry runs, and zero-activation loops.
- `npm run check`: extension entry point and shared parser pass syntax checks.
- `git diff --check`: no whitespace errors.
- Browser integration on an isolated SillyTavern 1.18.0 profile: a real non-dry
  world-info scan activated three books sharing UID 0, including an apostrophe
  and brackets, Unicode and emoji, and a long name. Each retained its own matched
  keyword in the generated report; recursion counts were three entries in the
  first loop and zero in the second.
- Desktop and mobile report screenshots were visually inspected. Long names
  wrapped without horizontal overflow; no browser page errors were observed.

The extension still observes the host's world-info console diagnostics because
the host does not expose matched-keyword details through an entry activation
event. Older combined text logs remain supported; structured entry data takes
precedence when available.
