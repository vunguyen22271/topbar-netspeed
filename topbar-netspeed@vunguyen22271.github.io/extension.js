/* Topbar Net Speed - upload/download meter for the GNOME top bar.
 *
 * Copyright (C) 2026 the Topbar Net Speed contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── config ──────────────────────────────────────────────────────────────
const REFRESH_SECONDS = 1;
const UNIT_BASE = 1024;          // 1000 for decimal kB
const PANEL_POSITION = 0;        // 0 = leftmost in right box (left of wifi)

// Virtual / overlay interfaces are skipped. A VPN or container interface
// carries traffic that has already been counted on the physical NIC it rides
// over, so including it roughly doubles the reported rate.
const EXCLUDE = [/^lo$/, /^docker/, /^br-/, /^veth/, /^virbr/,
                 /^tailscale/, /^tun/, /^tap/, /^wg/];
// ─────────────────────────────────────────────────────────────────────────

// St.BoxLayout took `vertical: true` through GNOME 47. GNOME 48 introduced
// `orientation` and the shell's own code dropped `vertical` entirely. Both
// accessors still exist on 50, but `orientation` is the supported one - so
// prefer it and fall back only where it genuinely does not exist (45-47).
// Getting this wrong does not raise an error; the two labels just end up
// side by side instead of stacked.
const VERTICAL = 'orientation' in St.BoxLayout.prototype
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

const isExcluded = name => EXCLUDE.some(re => re.test(name));

/** Parse /proc/net/dev into {iface: {rx, tx}} for real interfaces only. */
function readCounters() {
    const out = new Map();
    let contents;
    try {
        const [ok, bytes] = GLib.file_get_contents('/proc/net/dev');
        if (!ok)
            return out;
        contents = new TextDecoder().decode(bytes);
    } catch {
        return out;
    }

    for (const line of contents.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const name = line.slice(0, colon).trim();
        if (!name || isExcluded(name))
            continue;
        const f = line.slice(colon + 1).trim().split(/\s+/);
        // field 0 = rx bytes, field 8 = tx bytes
        const rx = Number(f[0]);
        const tx = Number(f[8]);
        if (Number.isFinite(rx) && Number.isFinite(tx))
            out.set(name, {rx, tx});
    }
    return out;
}

// The panel label must not change width, or the "U:"/"D:" prefixes shift
// sideways every time the rate crosses a digit or a unit boundary. The font is
// monospace, so a constant CHARACTER count is a constant pixel width.
//
// Both ends are pinned and only the middle moves:
//
//     U: 0.00  B/s        "U:" is at a fixed column, left
//     U:  512  B/s        the unit is at a fixed column, right
//     U: 7.59 kB/s        the number floats in the fixed field between them
//     U: 1397 GB/s
//
// So the number is padStart(NUM_W) - right-aligned against the unit - and the
// unit is padStart(UNIT_W) too, which right-aligns "B/s" under "kB/s" instead
// of leaving it hanging a character short.
const NUM_W = 4;    // '0.00', '99.9', ' 388', '1023'
const UNIT_W = 4;   // ' B/s', 'kB/s', 'MB/s', 'GB/s'

function formatRate(bytesPerSec) {
    const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
    let v = Math.max(0, bytesPerSec);
    let i = 0;
    while (v >= UNIT_BASE && i < units.length - 1) {
        v /= UNIT_BASE;
        i++;
    }
    const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(digits).padStart(NUM_W)} ${units[i].padStart(UNIT_W)}`;
}

function formatTotal(bytes) {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let v = Math.max(0, bytes);
    let i = 0;
    while (v >= UNIT_BASE && i < units.length - 1) {
        v /= UNIT_BASE;
        i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const NetSpeedIndicator = GObject.registerClass(
class NetSpeedIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Net Speed', false);

        this._prev = readCounters();
        this._prevTime = GLib.get_monotonic_time();
        this._sessionRx = 0;
        this._sessionTx = 0;

        const box = new St.BoxLayout({
            ...VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'netspeed-box',
        });

        this._upLabel = new St.Label({
            text: `U: ${'—'.padStart(NUM_W).padEnd(NUM_W + 1 + UNIT_W)}`,
            style_class: 'netspeed-label',
            x_align: Clutter.ActorAlign.START,
        });
        this._downLabel = new St.Label({
            text: `D: ${'—'.padStart(NUM_W).padEnd(NUM_W + 1 + UNIT_W)}`,
            style_class: 'netspeed-label',
            x_align: Clutter.ActorAlign.START,
        });

        box.add_child(this._upLabel);
        box.add_child(this._downLabel);
        this.add_child(box);

        this._detailItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            style_class: 'netspeed-detail',
        });
        this._detailItem.label.clutter_text.set_line_wrap(false);
        this.menu.addMenuItem(this._detailItem);

        this._timeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });

        this._tick();
    }

    _tick() {
        const now = readCounters();
        const t = GLib.get_monotonic_time();
        const dt = (t - this._prevTime) / 1e6;   // microseconds → seconds
        if (dt <= 0) {
            this._prev = now;
            return;
        }

        let upRate = 0, downRate = 0;
        const perIface = [];

        for (const [name, cur] of now) {
            const old = this._prev.get(name);
            if (!old)
                continue;
            // Counters reset on interface down/up; clamp negatives to 0.
            const dRx = Math.max(0, cur.rx - old.rx);
            const dTx = Math.max(0, cur.tx - old.tx);
            downRate += dRx / dt;
            upRate += dTx / dt;
            this._sessionRx += dRx;
            this._sessionTx += dTx;
            if (dRx || dTx)
                perIface.push(`${name}  ↑ ${formatRate(dTx / dt)}   ↓ ${formatRate(dRx / dt)}`);
        }

        this._prev = now;
        this._prevTime = t;

        this._upLabel.text = `U: ${formatRate(upRate)}`;
        this._downLabel.text = `D: ${formatRate(downRate)}`;

        const lines = [
            `Session   ↑ ${formatTotal(this._sessionTx)}   ↓ ${formatTotal(this._sessionRx)}`,
            '',
            ...(perIface.length ? perIface : ['(no active interfaces)']),
        ];
        this._detailItem.label.text = lines.join('\n');
    }

    destroy() {
        if (this._timeout) {
            GLib.Source.remove(this._timeout);
            this._timeout = null;
        }
        super.destroy();
    }
});

export default class NetSpeedExtension extends Extension {
    enable() {
        this._indicator = new NetSpeedIndicator();
        Main.panel.addToStatusArea(
            this.uuid, this._indicator, PANEL_POSITION, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
