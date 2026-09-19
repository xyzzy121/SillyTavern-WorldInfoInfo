# Version 1.6.8 validation

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
