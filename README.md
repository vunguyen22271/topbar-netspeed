# Topbar Net Speed

A network speed meter for the GNOME top bar — upload and download rate, live,
next to the system indicators. Think NetSpeedMonitor, but for GNOME.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Activities          Sep 20  08:42      U:   7.59 kB/s   wifi vol pwr │
│                                        D: 387.81 kB/s                │
└──────────────────────────────────────────────────────────────────────┘
                                         └────────────┘ this extension
```

Windows puts NetSpeedMonitor in the notification area. GNOME has no notification
area — the top bar belongs to GNOME Shell — so the equivalent has to be a shell
extension. This is that, in ~180 lines of JavaScript:

- **No dependencies.** No GTop, no Python daemon, no polling a helper process.
  It reads `/proc/net/dev`, which the kernel has always had.
- **Nothing downloaded at install time**, and nothing that runs as root.
- **One file to configure**, no preferences dialog to get in the way.

Clicking the indicator opens a popup with session totals and a per-interface
breakdown.

## Compatibility

| Ubuntu | GNOME Shell | Status |
|---|---|---|
| 26.04 LTS | 50 | **Verified** — developed and tested here |
| 25.10 | 49 | Expected to work |
| 25.04 | 48 | Expected to work |
| 24.10 | 47 | Expected to work (compat path) |
| 24.04 LTS | 46 | Expected to work (compat path) |
| 23.10 | 45 | Expected to work (compat path) |
| 22.04 LTS | 42 | **Not supported** — predates the ESM extension API |

Wayland and X11 both work. GNOME 45 is the floor because that is where GNOME
switched extensions to ES modules; supporting 42 would mean a second copy of the
extension written against the old `imports.*` API.

"Expected to work" is exactly that — the APIs used are stable across 45–51 and
the one thing that did change is feature-detected at runtime (see
[Supporting GNOME 45 through 51](#supporting-gnome-45-through-51)), but only
GNOME 50.1 has actually been run. Reports from other versions are welcome.

## Install

```bash
git clone https://github.com/vunguyen22271/topbar-netspeed.git
cd topbar-netspeed
./install.sh
```

Then **log out and log back in**. This is not optional — see
[no live reload](#2-there-is-no-live-reload).

To remove it:

```bash
./install.sh --uninstall
```

`install.sh` copies the extension into
`~/.local/share/gnome-shell/extensions/` and adds its uuid to the
`org.gnome.shell enabled-extensions` list, leaving your other extensions alone.
It needs no privileges and touches nothing outside your home directory.

## Configuration

There is no preferences dialog on purpose. The whole configuration is a block at
the top of `topbar-netspeed@vunguyen22271.github.io/extension.js`. Edit it, re-run
`./install.sh`, log out and back in.

| Setting | Default | Meaning |
|---|---|---|
| `REFRESH_SECONDS` | `1` | Sampling interval |
| `UNIT_BASE` | `1024` | Set to `1000` for decimal kB/MB |
| `PANEL_POSITION` | `0` | `0` = leftmost in the right box. Raise it to move right |
| `EXCLUDE` | below | Interfaces not counted |

```js
const EXCLUDE = [/^lo$/, /^docker/, /^br-/, /^veth/, /^virbr/,
                 /^tailscale/, /^tun/, /^tap/, /^wg/];
```

The VPN and container patterns are excluded **deliberately**. Traffic on
`tailscale0`, `wg0` or `docker0` has already been counted on the physical NIC it
rides over, so including them roughly doubles the reported rate. If you
specifically want to watch a tunnel, drop its pattern and accept the
double-counting.

## How it works

```
┌──────────────────────────┐                    ┌──────────────────────────┐
│ Linux kernel             │   poll every 1s    │ extension.js             │
│ /proc/net/dev            │ ─────────────────► │ readCounters()           │
│ cumulative rx/tx bytes   │     cumulative     │ drops EXCLUDE ifaces     │
│ per interface            │  totals, not rate  │ keeps physical NICs      │
└──────────────────────────┘                    └───────────┬──────────────┘
                                                            │ Δbytes / Δt
                                                            │ monotonic clock
                                                            ▼
┌──────────────────────────┐  addToStatusArea   ┌──────────────────────────┐
│ GNOME top bar (_rightBox)│     position 0     │ NetSpeedIndicator        │
│ U:   7.59 kB/s           │ ◄───────────────── │ PanelMenu.Button         │
│ D: 387.81 kB/s           │    box "right"     │ 2 x St.Label, stacked    │
└───────────┬──────────────┘                    │ formatRate()             │
            │ renders just left of              └──────────────────────────┘
            ▼
┌──────────────────────────┐
│ System indicators        │
│ wifi · volume · power    │
└──────────────────────────┘
```

The kernel exposes **cumulative** byte counters, never a rate. Everything
interesting is in turning one into the other:

- **The interval comes from the clock, not the timer.** A 1-second
  `GLib.timeout` does not fire after exactly 1 second, especially under load.
  Dividing by an assumed `1.0` inflates the reading whenever the system is
  busy — precisely when you are looking at it. The delta is measured with
  `GLib.get_monotonic_time()`, which also cannot jump when NTP steps the wall
  clock.
- **Negative deltas are clamped to zero.** Counters reset when an interface goes
  down and comes back. Without the clamp, reconnecting wifi prints a nonsense
  multi-gigabyte spike.
- **Both ends of the label are pinned; only the middle moves.** Every reading is
  padded to the same character count, which in a monospace font is the same pixel
  width. The prefix sits at a fixed column on the left, the unit at a fixed
  column on the right, and the number floats in the fixed field between them:

  ```
  U: 0.00  B/s
  U:  388 kB/s
  U: 4.96 MB/s
  U: 1397 GB/s
  ```

  So nothing in the panel shifts as the rate crosses a digit or unit boundary.
  An earlier version used `min-width` with `text-align: right`, which pins the
  right edge and lets text grow leftward — that made the prefixes slide sideways
  on every change, which is the bug this replaced.
- **The timer is removed in `destroy()`**, before `super.destroy()`. A
  disable/enable cycle otherwise leaks a timeout that keeps firing against a
  destroyed widget.

## Supporting GNOME 45 through 51

### 1. `St.BoxLayout` changed how it stacks vertically

It took
`vertical: true` through GNOME 47; GNOME 48 introduced `orientation` and the
shell's own code dropped `vertical` entirely. Both accessors still exist on 50,
but `orientation` is the supported one. Passing the wrong one does not raise an
error — the two labels silently lay out side by side instead of stacked, which
is a miserable thing to debug.

So it is feature-detected once, at module load:

```js
const VERTICAL = 'orientation' in St.BoxLayout.prototype
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};
```

### 2. There is no live reload

`org.gnome.Shell.Extensions.ReloadExtension` answers
`NotSupported: ReloadExtension is deprecated and does not work`, and a Wayland
session cannot restart gnome-shell in place the way `Alt+F2` → `r` did under
X11. A newly created extension directory is therefore invisible to the running
shell: `gnome-extensions enable` reports *"does not exist"* until the next login.

`install.sh` works around this by writing the uuid straight into the
`enabled-extensions` gsettings key, so the extension comes up on its own at the
next login with no further action.

## Layout

```
topbar-netspeed/
├── README.md
├── LICENSE                         GPL-2.0-or-later
├── install.sh                      install / --uninstall
└── topbar-netspeed@vunguyen22271.github.io/  directory name must equal the uuid
    ├── metadata.json               uuid, supported shell versions
    ├── extension.js                all the logic
    └── stylesheet.css              panel font and fixed width
```

## Troubleshooting

```bash
# Is the shell loading it?
gnome-extensions info topbar-netspeed@vunguyen22271.github.io

# Errors from the extension
journalctl --user -b | grep netspeed

# What the meter is reading from
cat /proc/net/dev
```

**Nothing in the panel after logging in.** Check `gnome-extensions info`. If it
says the extension does not exist, the files are not in
`~/.local/share/gnome-shell/extensions/` — re-run `./install.sh`. If it reports
`ERROR`, `journalctl` has the stack trace.

**Installed from a snap or flatpak terminal and nothing appeared.**
`install.sh` handles this, but it is worth knowing why. Snap-confined terminals
(the VS Code snap, for one) set `XDG_DATA_HOME` to a private directory such as
`~/snap/code/263/.local/share`. Following it is correct by the XDG spec and
wrong for extensions: gnome-shell has no `XDG_DATA_HOME` of its own and reads
`$HOME/.local/share`, so an install there succeeds silently and the shell never
sees it. Worse, `gsettings` is *not* sandboxed, so the extension still shows up
in `enabled-extensions` and everything looks fine.

`install.sh` therefore reads the data directory out of the running gnome-shell's
own environment (`/proc/<pid>/environ`) rather than trusting its own, and prints
a note when the two disagree. To check by hand:

```bash
tr '\0' '\n' < "/proc/$(pgrep -x gnome-shell)/environ" | grep -E '^(HOME|XDG_DATA_HOME)='
```

**The two lines sit side by side instead of stacked.** The `VERTICAL`
feature-detection picked the wrong branch for your shell. Please open an issue
with your `gnome-shell --version`.

**Numbers look roughly doubled.** A tunnel or bridge interface is being counted
alongside the physical NIC it rides over. Add it to `EXCLUDE`.

## Hacking on it

`extension.js` cannot be imported outside gnome-shell, but it can still be
parse-checked. An `ImportError` on a `resource:///` path means the file parsed
fine; a `SyntaxError` would be reported first:

```bash
gjs -m topbar-netspeed@vunguyen22271.github.io/extension.js
# expected: ImportError: Unable to load file from:
#           resource:///org/gnome/shell/ui/main.js
```

The pure functions — `readCounters`, `formatRate`, `formatTotal` — depend only
on `GLib`, so they can be copied into a scratch file and run under plain `gjs`
against the live `/proc/net/dev`.

The shell's own JavaScript is the best reference for what an API actually looks
like on a given version. On modern Ubuntu it is not on disk as plain files; it
is packed into a gresource inside the shell library:

```bash
gresource extract /usr/lib/gnome-shell/libshell-18.so /org/gnome/shell/ui/panel.js
```

(The library version tracks the shell — `libshell-18.so` on GNOME 50. Use
`gresource list` to confirm.)

## Forking and publishing

The uuid is `topbar-netspeed@vunguyen22271.github.io`. If you publish your own build to
[extensions.gnome.org](https://extensions.gnome.org), you need a uuid whose
domain part is one you control — change it in **both** `metadata.json` and the
directory name, which GNOME requires to be identical. `install.sh` reads the
uuid from `metadata.json`, so it needs no edit.

To build a submittable zip:

```bash
gnome-extensions pack topbar-netspeed@vunguyen22271.github.io
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
