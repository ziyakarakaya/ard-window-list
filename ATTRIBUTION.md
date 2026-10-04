# Attribution

ARD Window List/Taskbar (Adaptive Responsive Desktop Window List/Taskbar) is an independent
derivative of [GNOME Shell Extensions](https://gitlab.gnome.org/GNOME/gnome-shell-extensions),
principally **Window List**, including components shared with **Workspace
Indicator**. It is maintained in
[ziyakarakaya/ard-window-list](https://github.com/ziyakarakaya/ard-window-list).
GNOME does not endorse or officially support this derivative; it is not distributed
as part of GNOME Classic Mode.

## Verified local reference

The October 2026 review used Ubuntu's installed `gnome-shell-extensions` package
**50.0-1**, whose source package/version is also `gnome-shell-extensions` 50.0-1
(GNOME upstream version **50.0**). The comparison files are installed under:

- `/usr/share/gnome-shell/extensions/window-list@gnome-shell-extensions.gcampax.github.com/`
- `/usr/share/gnome-shell/extensions/workspace-indicator@gnome-shell-extensions.gcampax.github.com/`
- `/usr/share/glib-2.0/schemas/org.gnome.shell.extensions.window-list.gschema.xml`

The installed Window List metadata points to the GNOME GitLab project above.
Ubuntu's `/usr/share/doc/gnome-shell-extensions/copyright` identifies
[GNOME's source distribution](https://download.gnome.org/sources/gnome-shell-extensions/)
and licenses these components as `GPL-2+`. Their individual source headers use
`GPL-2.0-or-later`.

This is a verified local comparison reference. The repository does not record the
exact original upstream Git commit or source tarball used to create its first
commit; the review does not claim to establish that history. Ubuntu may carry
downstream changes, so matching its installed files alone is not proof of a
particular upstream commit.

## Per-file provenance and ARD changes

Paths below identify components in the upstream project. Shared JavaScript is
installed with both Window List and Workspace Indicator; those installed upstream
copies are byte-identical. Workspace switcher styles in Window List adapt the
Workspace Indicator styles to the `window-list-workspace-indicator` selector
prefix; the light variant also omits its standalone dark-style import.

| ARD file | Upstream component | Difference from the installed 50.0-1 reference |
| --- | --- | --- |
| `extension.js` | `extensions/window-list/extension.js` | Retains Window List's grouping, workspace/monitor filtering, menus, focus, activation, and drag-and-drop. ARD adds live appearance and width settings, grouped-title tooltip/focus handling, a compact status area and clock, panel positioning/startup adjustments, and lifecycle cleanup. |
| `prefs.js` | `extensions/window-list/prefs.js` | Adds four appearance controls; removes an unused `embed-previews` action. Workspace preview preferences remain in `workspacePrefs.js`. |
| `workspaceIndicator.js` | Shared Workspace Indicator `workspaceIndicator.js`, installed with both extensions | Adds compact mode and changes the `embed-previews` signal connection to `connectObject` for lifecycle cleanup. Compact mode suppresses embedded previews on ARD's bottom panel. |
| `workspacePrefs.js` | Shared Workspace Indicator `workspacePrefs.js`, installed with both extensions | Byte-for-byte unchanged. |
| `stylesheet-dark.css` | `extensions/window-list/stylesheet-dark.css` | Adds status/clock styling and width constraints; changes button state colors/borders and adds grouped-window focus styling. |
| `stylesheet-light.css` | `extensions/window-list/stylesheet-light.css` | Changes button state colors/borders and adds grouped-window focus styling. |
| `stylesheet-workspace-switcher-dark.css` | Window List's adapted Workspace Indicator dark stylesheet | Byte-for-byte unchanged from the Window List copy. |
| `stylesheet-workspace-switcher-light.css` | Window List's adapted Workspace Indicator light stylesheet | Adds ARD status-area background styling. |
| `schemas/org.gnome.shell.extensions.window-list-custom.gschema.xml` | Window List `org.gnome.shell.extensions.window-list.gschema.xml` | Uses the pre-existing local schema/enum ID and path; adds `icon-size`, `font-size`, `panel-height`, and `maximum-button-width`. Other keys and upstream license notice are retained. |
| `metadata.json` | Adapted Window List metadata | Uses ARD's name, description, UUID, repository URL, and existing local settings schema. Retains Shell 50 compatibility and the inherited gettext domain. Removes the upstream project's official-support statement. |

The historical `extension.js.before-appearance` matches the installed upstream
Window List `extension.js` byte for byte. It is not imported by runtime code and
has no unique ARD functionality. It, the generated compiled schema, and local
`AGENTS.md` are ignored and excluded from release ZIPs and should not be tracked
in the public source tree. Existing local files are preserved.

The EGO preparation in October 2026 removes the unused `extension-id` metadata
field and adds a separate submission allowlist. In `extension.js`, it replaces
the GTK import used for focus direction with the equivalent St enum, removes
routine window-tracking debug logs, and cancels pending drag-resize compositor
callbacks when the drag actor is destroyed. It also restores the on-screen
keyboard's original vertical offset on disable. These review fixes retain the
active window-list behavior and all original source notices.

## Copyright and licensing

All original per-file copyright notices and
`SPDX-License-Identifier: GPL-2.0-or-later` headers remain intact. They identify:

- Florian Müllner: Window List, preferences, workspace indicator, schema, and styles.
- Giovanni Campagna: Window List, workspace indicator, and workspace preferences.
- Sylvain Pasche: Window List and preferences.
- Erick Pérez Castellanos: workspace indicator and workspace switcher styles.
- Jakub Steiner: light styles.

Those notices, including their years and contact details, are authoritative; this
summary does not replace them. ARD customizations are identifiable in the table
above and the repository's October 2026 history. The public-release preparation
adds ARD identity, documentation, licensing text, packaging, and the optional
preferences launcher. New release tooling, documentation, and launcher:
Copyright 2026 Ziya Karakaya; distributed under `GPL-2.0-or-later`.

The top-level [LICENSE](LICENSE) is the GNU General Public License, version 2,
verified against Ubuntu's `/usr/share/common-licenses/GPL-2`. Source SPDX notices
and this project's explicit license grant permit version 2 **or any later
version**; including the GPLv2 text does not restrict that grant to version 2 only.
