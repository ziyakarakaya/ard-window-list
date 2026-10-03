# ARD Window List Project Rules

Target environment:
- Ubuntu 26.04.1 LTS
- GNOME Shell 50.1
- Wayland
- UUID: window-list-custom@ziya.local
- Extension name: ARD Window List

Safety and scope:
- Work only inside this repository.
- Never modify /usr/share/gnome-shell/extensions.
- Never modify the live extension under ~/.local/share/gnome-shell/extensions unless I explicitly request deployment.
- Do not use sudo.
- Do not access credentials, keyrings, browser profiles, SSH keys, VPN credentials, cloud credentials, API keys, tokens, or unrelated user files.
- Do not use network access unless explicitly approved.

Development rules:
- Preserve clean enable/disable lifecycle.
- Preserve original Window List grouping, workspace, monitor, drag-and-drop, window activation, and focus behavior.
- Prefer GSettings-backed preferences for configurable options.
- Appearance settings should apply live where practical.
- Avoid polling loops, recursive actor-tree hacks, shell-global monkey patches, and unrelated refactors.
- Inspect relevant existing code before editing.
- Keep changes minimal and reviewable.
- Do not perform destructive Git operations without explicit approval.
- Do not deploy automatically.

Validation:
- Verify the GSettings schema compiles.
- Verify preferences open.
- Verify the extension can enable and disable cleanly.
- Check journal output for GNOME Shell JavaScript errors when appropriate.
- Report all changed files, commands run, tests performed, and remaining risks.

