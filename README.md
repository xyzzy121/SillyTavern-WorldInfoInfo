# SillyTavern - WorldInfo Info

Forked from the amazing LenAnderson. Original at https://github.com/LenAnderson/SillyTavern-WorldInfoInfo; this version adds the following features:


Click the book in the lower left corner of the screen to see the list of active entries. 

![list of entries](https://github.com/aikohanasaki/imagehost/blob/main/wii-list.png)

The floating book icon can be dragged to a different location (right-click to enable dragging). To reset its position, use `/wi-position-reset`.
![drag-to-move](https://github.com/aikohanasaki/imagehost/blob/main/wii-dragtomove.png)

🆕 `/wi-report` shows you what keywords triggered which entry during which round of recursion.

![Popup showing /wi-report](https://github.com/aikohanasaki/imagehost/blob/main/worldinfo.png)

Visibility and privacy
- Entries from hidden lorebooks are omitted from /wi-report for non-admin users.
- All counts in the report (summary and per-loop) reflect only visible entries.

![hidden lorebook](https://github.com/aikohanasaki/imagehost/blob/main/wii-listwithhide.png)

![report omits hidden books](https://github.com/aikohanasaki/imagehost/blob/main/wii-hiddenreport.png)

## Lorebook-name warnings during generation (1.6.10)

The activity panel now reads sticky countdowns from the host's existing chat
metadata. Previously it called `/wi-get-timed-effect` for every activated entry,
which checked the lorebook's name against the file list and reloaded the book.
That extra lookup could report "Valid World Info file name is required" for an
entry that had already activated successfully, or leave the panel on "Updating..."
if the command failed.

Lorebook names are preserved exactly. Missing or incompatible timed-effect
metadata simply leaves out the sticky indicator. Display updates use copies of
activated entries, preserving the host's configured sticky durations and depths.

## Unusual lorebook names (1.6.8)

Activation capture now uses the host's structured lorebook name and entry UID
whenever available, including current SillyTavern logs that split the entry
header and lorebook name into separate arguments. Names are kept exactly as
provided: apostrophes, quotes, colons, brackets, emoji, combining characters,
spaces, and line breaks do not change entry identity. Long names wrap in the
activity panel and keyword report.

Entry attribution is scoped to the current processing block and cleared at scan,
loop, and chat boundaries. Entries with the same UID in different lorebooks stay
separate. Historical reports still accept the old `World:UID` identifiers and
combined text logs; their keyword fallback stops at the next entry or loop. New
reports use exact structured capture without replacing it with inferred log text.
Existing hidden-lorebook visibility rules are unchanged. This display behavior
does not change which lorebooks the host loads or who can access their files.

To install this local checkout, copy the repository into
`public/scripts/extensions/third-party/SillyTavern-WorldInfoInfo` in your
SillyTavern installation, then reload SillyTavern. Replace an existing copy instead
of loading two copies of the extension. No SillyTavern core patch is required.

The regression suite requires Node.js 20 or newer and has no additional packages:

```sh
npm test
npm run check
```

## License

This project is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).
