#!/usr/bin/env bash
# Install (or remove) the Net Speed GNOME Shell extension for the current user.
#
#   ./install.sh              install and enable
#   ./install.sh --uninstall  disable and remove
#
# SPDX-License-Identifier: GPL-2.0-or-later
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The uuid is whatever metadata.json says, so renaming the extension only means
# editing that file and the directory next to it - never this script.
SRC="$(find "$HERE" -maxdepth 1 -type d -name '*@*' | head -n1)"
[[ -n "$SRC" && -f "$SRC/metadata.json" ]] || {
    echo "error: no extension directory with a metadata.json next to this script" >&2
    exit 1
}
UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$SRC/metadata.json")"
[[ "$(basename "$SRC")" == "$UUID" ]] || {
    echo "error: directory '$(basename "$SRC")' does not match uuid '$UUID' in metadata.json" >&2
    echo "       GNOME requires these to be identical." >&2
    exit 1
}
# Extensions must land in the data directory the SHELL reads, which is not
# necessarily the caller's. A snap- or flatpak-confined terminal (VS Code, for
# one) points XDG_DATA_HOME at its own private directory; installing there
# succeeds silently while gnome-shell never sees the extension. So ask the
# running shell where its data directory is, rather than trusting this process.
shell_data_home() {
    local pid val
    pid="$(pgrep -u "$(id -u)" -x gnome-shell | head -n1)"
    if [[ -n "$pid" && -r "/proc/$pid/environ" ]]; then
        val="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^XDG_DATA_HOME=//p')"
        [[ -n "$val" ]] && { printf '%s\n' "$val"; return; }
        val="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^HOME=//p')"
        [[ -n "$val" ]] && { printf '%s/.local/share\n' "$val"; return; }
    fi
    printf '%s/.local/share\n' "$HOME"   # no shell running: tty, CI, install-then-login
}

DATA_HOME="$(shell_data_home)"
DEST="$DATA_HOME/gnome-shell/extensions/$UUID"

if [[ -n "${XDG_DATA_HOME:-}" && "$XDG_DATA_HOME" != "$DATA_HOME" ]]; then
    echo "note: this shell has XDG_DATA_HOME=$XDG_DATA_HOME"
    echo "      but gnome-shell reads $DATA_HOME - installing there instead."
    echo "      (usually means this terminal is inside a snap or flatpak)"
fi

# Add or remove $UUID in enabled-extensions, leaving every other entry alone.
set_enabled() {
    python3 - "$1" "$UUID" <<'PY'
import subprocess, sys, ast
want, uuid = sys.argv[1] == 'on', sys.argv[2]
cur = subprocess.run(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'],
                     capture_output=True, text=True).stdout.strip()
lst = ast.literal_eval(cur) if cur.startswith('[') else []
if want and uuid not in lst:
    lst.append(uuid)
elif not want and uuid in lst:
    lst.remove(uuid)
else:
    print('  enabled-extensions already correct')
    raise SystemExit
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                '[' + ', '.join(f"'{x}'" for x in lst) + ']'], check=True)
print('  enabled-extensions ->', 'added' if want else 'removed', uuid)
PY
}

if [[ "${1:-}" == "--uninstall" ]]; then
    echo "Removing $UUID"
    set_enabled off
    rm -rf "$DEST"
    echo "  deleted $DEST"
    echo "Log out and back in to drop it from the panel."
    exit 0
fi

# Refuse to clobber a destination that is not an extension we recognise
# (for example a symlink to someone's dev checkout).
if [[ -e "$DEST" && ! -e "$DEST/metadata.json" ]]; then
    echo "error: $DEST exists but has no metadata.json - not overwriting" >&2
    exit 1
fi

echo "Installing $UUID"
mkdir -p "$DEST"
cp "$SRC/metadata.json" "$SRC/extension.js" "$SRC/stylesheet.css" "$DEST/"
echo "  copied to $DEST"
set_enabled on

# `gnome-extensions enable` only works for extensions the running shell already
# knows about, and a brand new directory is invisible until the next login. The
# gsettings write above is what actually makes it come up, so a failure here is
# expected on a first install and not an error.
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "  enabled in the running shell"
else
    echo "  not yet known to the running shell - it will load at next login"
fi

echo
echo "Done. Log out and back in to see it."
