// SPDX-FileCopyrightText: 2012 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2013 Giovanni Campagna <gcampagna@src.gnome.org>
// SPDX-FileCopyrightText: 2014 Sylvain Pasche <sylvain.pasche@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later

// ARD Window List review changes, 2026-10-04: Shell-only focus navigation,
// logging and lifecycle cleanup. See ATTRIBUTION.md.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {DashItemContainer} from 'resource:///org/gnome/shell/ui/dash.js';
import {
    ANIMATION_TIME as SLIDE_ANIMATION_TIME,
} from 'resource:///org/gnome/shell/ui/overview.js';

import {WorkspaceIndicator} from './workspaceIndicator.js';

let currentIconSize = 24;
const DND_ACTIVATE_TIMEOUT = 500;

const MIN_DRAG_UPDATE_INTERVAL = 500 * GLib.TIME_SPAN_MILLISECOND;

const DRAG_OPACITY = 0.3;
const DRAG_FADE_DURATION = 200;

const DRAG_RESIZE_DURATION = 400;

const DRAG_PROXIMITY_THRESHOLD = 30;

const SAVED_POSITIONS_KEY = 'window-list-positions';

const ATTENTION_INDICATOR_MAX_SCALE = 0.4;
const ATTENTION_INDICATOR_TRANSITION_DURATION = 300;

const GroupingMode = {
    NEVER: 0,
    AUTO: 1,
    ALWAYS: 2,
};

class DragPlaceholderItem extends DashItemContainer {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super();
        this.setChild(new St.Bin({style_class: 'placeholder'}));
    }
}

/**
 * @param {Shell.App} app - an app
 * @returns {number} - the smallest stable sequence of the app's windows
 */
function _getAppStableSequence(app) {
    const windows = app.get_windows().filter(w => !w.skip_taskbar);
    return windows.reduce((prev, cur) => {
        return Math.min(prev, cur.get_stable_sequence());
    }, Infinity);
}

class WindowContextMenu extends PopupMenu.PopupMenu {
    constructor(source, metaWindow) {
        super(source, 0.5, St.Side.BOTTOM);

        this._metaWindow = metaWindow;

        this._minimizeItem = new PopupMenu.PopupMenuItem('');
        this._minimizeItem.connect('activate', () => {
            if (this._metaWindow.minimized)
                this._metaWindow.unminimize();
            else
                this._metaWindow.minimize();
        });
        this.addMenuItem(this._minimizeItem);

        this._maximizeItem = new PopupMenu.PopupMenuItem('');
        this._maximizeItem.connect('activate', () => {
            if (this._metaWindow.is_maximized())
                this._metaWindow.unmaximize();
            else
                this._metaWindow.maximize();
        });
        this.addMenuItem(this._maximizeItem);

        this._closeItem = new PopupMenu.PopupMenuItem(_('Close'));
        this._closeItem.connect('activate', () => {
            this._metaWindow.delete(global.get_current_time());
        });
        this.addMenuItem(this._closeItem);

        this._metaWindow.connectObject(
            'notify::minimized', this._updateMinimizeItem.bind(this),
            'notify::maximized-horizontally', this._updateMaximizeItem.bind(this),
            'notify::maximized-vertically', this._updateMaximizeItem.bind(this),
            this.actor);

        this._updateMinimizeItem();
        this._updateMaximizeItem();

        this.connect('open-state-changed', () => {
            if (!this.isOpen)
                return;

            this._minimizeItem.setSensitive(this._metaWindow.can_minimize());
            this._maximizeItem.setSensitive(this._metaWindow.can_maximize());
            this._closeItem.setSensitive(this._metaWindow.can_close());
        });
    }

    _updateMinimizeItem() {
        this._minimizeItem.label.text = this._metaWindow.minimized
            ? _('Unminimize') : _('Minimize');
    }

    _updateMaximizeItem() {
        this._maximizeItem.label.text = this._metaWindow.is_maximized()
            ? _('Unmaximize') : _('Maximize');
    }
}

class TitleWidget extends St.Widget {
    static {
        GObject.registerClass({
            GTypeFlags: GObject.TypeFlags.ABSTRACT,
            Properties: {
                'abstract-label': GObject.ParamSpec.boolean(
                    'abstract-label', null, null,
                    GObject.ParamFlags.READWRITE,
                    false),
            },
        }, this);
    }

    constructor() {
        super({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        const hbox = new St.BoxLayout({
            style_class: 'window-button-box',
            x_expand: true,
            y_expand: true,
        });
        this.add_child(hbox);

        this._icon = new St.Bin({
            style_class: 'window-button-icon',
        });
        hbox.add_child(this._icon);

        this._label = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._label.clutter_text.single_line_mode = true;
        hbox.add_child(this._label);
        this.label_actor = this._label;

        this.bind_property('abstract-label',
            this._label, 'visible',
            GObject.BindingFlags.SYNC_CREATE |
            GObject.BindingFlags.INVERT_BOOLEAN);

        this._abstractLabel = new St.Widget({
            style_class: 'window-button-abstract-label',
            x_expand: true,
            y_expand: true,
        });
        hbox.add_child(this._abstractLabel);

        this.bind_property('abstract-label',
            this._abstractLabel, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this._attentionIndicator = new St.Widget({
            style_class: 'window-button-attention-indicator',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
            scale_x: 0,
        });
        this._attentionIndicator.set_pivot_point(0.5, 0.5);
        this.add_child(this._attentionIndicator);
    }

    setNeedsAttention(enable) {
        this._attentionIndicator.ease({
            scaleX: enable ? ATTENTION_INDICATOR_MAX_SCALE : 0,
            duration: ATTENTION_INDICATOR_TRANSITION_DURATION,
        });
    }
}

class WindowTitle extends TitleWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow) {
        super();

        this._metaWindow = metaWindow;

        this._metaWindow.connectObject(
            'notify::wm-class',
            () => this._updateIcon(), GObject.ConnectFlags.AFTER,
            'notify::gtk-application-id',
            () => this._updateIcon(), GObject.ConnectFlags.AFTER,
            'notify::title', () => this._updateTitle(),
            'notify::minimized', () => this._minimizedChanged(),
            'notify::demands-attention', () => this._updateNeedsAttention(),
            'notify::urgent', () => this._updateNeedsAttention(),
            this);

        this._updateIcon();
        this._minimizedChanged();
        this._updateNeedsAttention();
    }

    _minimizedChanged() {
        this._icon.opacity = this._metaWindow.minimized ? 128 : 255;
        this._updateTitle();
    }

    _updateNeedsAttention() {
        const {urgent, demandsAttention} = this._metaWindow;
        this.setNeedsAttention(urgent || demandsAttention);
    }

    _updateTitle() {
        if (!this._metaWindow.title)
            return;

        if (this._metaWindow.minimized)
            this._label.text = '[%s]'.format(this._metaWindow.title);
        else
            this._label.text = this._metaWindow.title;
    }

    _updateIcon() {
        this._icon.set_style(
            `width: ${currentIconSize}px; height: ${currentIconSize}px;`);

        const app =
            Shell.WindowTracker.get_default().get_window_app(this._metaWindow);

        if (app) {
            this._icon.child = app.create_icon_texture(currentIconSize);
        } else {
            this._icon.child = new St.Icon({
                icon_name: 'application-x-executable',
                icon_size: currentIconSize,
            });
        }
    }
}

class AppTitle extends TitleWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(app) {
        super();

        this._app = app;
        this._windows = new Set();

        this._icon.set_style(
            `width: ${currentIconSize}px; height: ${currentIconSize}px;`);

        this._icon.child = app.create_icon_texture(currentIconSize);
        this._label.text = app.get_name();

        this._app.connectObject(
            'windows-changed', () => this._onWindowsChanged(),
            this);
        this._onWindowsChanged();

        this.connect('destroy', () => {
            this._windows.clear();
        });
    }

    _onWindowsChanged() {
        const windows = this._app.get_windows();
        const removed = [...this._windows].filter(w => !windows.includes(w));
        removed.forEach(w => this._untrackWindow(w));
        windows.forEach(w => this._trackWindow(w));
        this._updateNeedsAttention();
    }

    _trackWindow(window) {
        if (this._windows.has(window))
            return;

        window.connectObject(
            'notify::urgent', () => this._updateNeedsAttention(),
            'notify::demands-attention', () => this._updateNeedsAttention(),
            this);
        this._windows.add(window);
    }

    _untrackWindow(window) {
        if (!this._windows.delete(window))
            return;

        window.disconnectObject(this);
    }

    _updateNeedsAttention() {
        const needsAttention =
            [...this._windows].some(w => w.urgent || w.demandsAttention);
        this.setNeedsAttention(needsAttention);
    }
}

class DragActor extends St.Bin {
    static {
        GObject.registerClass(this);
    }

    constructor(source, titleActor) {
        super({
            style_class: 'window-button-drag-actor',
            child: titleActor,
            width: source.width,
        });

        this.source = source;
        this._resizeLaterIds = new Set();
        this.connect('destroy', () => {
            const laters = global.compositor.get_laters();
            for (const id of this._resizeLaterIds)
                laters.remove(id);
            this._resizeLaterIds.clear();
        });
    }

    setTargetWidth(width) {
        const currentWidth = this.width;

        // set width immediately so shell's DND code uses correct values
        this.set({width});

        // then transition from the original to the new width
        const laters = global.compositor.get_laters();
        const laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._resizeLaterIds.delete(laterId);
            this.set({width: currentWidth});
            this.ease({
                width,
                duration: DRAG_RESIZE_DURATION,
            });
            return GLib.SOURCE_REMOVE;
        });
        this._resizeLaterIds.add(laterId);
    }
}

function getTitleTooltipText(titleActor) {
    const text = titleActor.text;
    const [, , preferredTitleWidth] = titleActor.get_preferred_size();
    const maxTitleWidth = titleActor.allocation.get_width();
    return preferredTitleWidth <= maxTitleWidth ? '' : text;
}

class WindowHoverCard {
    constructor(button, settings, {parent = null, onSizeChanged = null, adjacentTo = null} = {}) {
        this._button = button;
        this._settings = settings;
        this._embedded = parent !== null;
        this._onSizeChanged = onSizeChanged;
        this._adjacentTo = adjacentTo;
        this._laterId = 0;
        this._window = null;
        this._source = null;
        this._clone = null;
        this._actor = new St.BoxLayout({
            style_class: 'window-list-hover-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            visible: false,
        });
        this._appName = new St.Label({
            style_class: 'window-list-hover-card-app',
        });
        this._appName.clutter_text.set({
            single_line_mode: true,
            ellipsize: Pango.EllipsizeMode.END,
        });
        this._preview = new St.Bin({clip_to_allocation: true});
        this._title = new St.Label();
        this._title.clutter_text.set({
            single_line_mode: false,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
        });
        this._actor.add_child(this._appName);
        this._actor.add_child(this._preview);
        this._actor.add_child(this._title);
        if (parent)
            parent.set_child(this._actor);
        else
            Main.layoutManager.addChrome(this._actor);

        settings.connectObject('changed::preview-width',
            () => this._queueUpdate(), this._actor);
        button.connectObject(
            'notify::allocation', () => this._queueUpdate(),
            'notify::mapped', () => {
                if (!button.mapped)
                    this.hide();
            }, this._actor);
        this._actor.connect('style-changed', () => this._queueUpdate());
    }

    show(window) {
        if (this._window !== window) {
            this.hide();
            this._window = window;
            window.connectObject(
                'notify::title', () => this._queueUpdate(),
                'notify::wm-class', () => this._queueUpdate(),
                'notify::gtk-application-id', () => this._queueUpdate(),
                'size-changed', () => this._queueUpdate(),
                'shown', () => this._queueUpdate(),
                'unmanaging', () => this.hide(), this._actor);
        }
        // Each enter establishes and renders the request before any later runs.
        this._actor.show();
        this._update();
        // Chrome may invalidate layout; coalesce one layout/source refresh.
        this._queueUpdate();
    }

    _queueUpdate() {
        if (!this._window || this._laterId)
            return;

        const window = this._window;
        const laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                if (this._laterId !== laterId || this._window !== window)
                    return GLib.SOURCE_REMOVE;
                this._laterId = 0;
                this._update();
                return GLib.SOURCE_REMOVE;
            });
        this._laterId = laterId;
    }

    _clearSource() {
        this._source?.disconnectObject(this._actor);
        this._source = null;
        this._clearClone();
    }

    _clearClone() {
        this._clone?.destroy();
        this._clone = null;
        this._preview.hide();
    }

    _update() {
        if (!this._window)
            return;

        if (!this._button.mapped) {
            this.hide();
            return;
        }

        const width = this._settings.get_int('preview-width');
        const app = Shell.WindowTracker.get_default().get_window_app(this._window);
        this._appName.text = app?.get_name() || this._window.get_wm_class() || _('Unknown application');
        this._title.text = this._window.title ?? '';
        this._appName.width = width;
        this._title.width = width;
        this._preview.width = width;

        const layout = this._title.clutter_text.get_layout();
        const context = layout.get_context();
        const metrics = context.get_metrics(layout.get_font_description(), context.get_language());
        const lineHeight = Math.ceil((metrics.get_ascent() + metrics.get_descent()) / Pango.SCALE);
        // Clutter.Text ellipsizes the final line within this two-line allocation.
        this._title.height = 2 * lineHeight;

        const actorMonitor = Main.layoutManager.findIndexForActor(this._button);
        const monitorIndex = actorMonitor >= 0 ? actorMonitor : this._button._monitorIndex;
        if (!Number.isInteger(monitorIndex) || monitorIndex < 0)
            return;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        this._updatePreview(width, workArea);

        // Drop the previous explicit size so live width/geometry changes resize
        // the card from its newly constrained contents.
        this._actor.set_size(-1, -1);
        const [, cardWidth] = this._actor.get_preferred_width(-1);
        const [, cardHeight] = this._actor.get_preferred_height(cardWidth);
        if (this._embedded) {
            // The panel allocates embedded cards; rendering/sizing stays shared.
            this._actor.set_size(cardWidth, cardHeight);
            if (this._cardWidth !== cardWidth || this._cardHeight !== cardHeight) {
                this._cardWidth = cardWidth;
                this._cardHeight = cardHeight;
                this._onSizeChanged?.();
            }
            return;
        }
        const [buttonX, buttonY] = this._button.get_transformed_position();
        const [buttonWidth] = this._button.get_transformed_size();
        let anchorX = buttonX + (buttonWidth - cardWidth) / 2;
        let anchorY = buttonY - cardHeight - 6;
        if (this._adjacentTo) {
            const [menuX] = this._adjacentTo.get_transformed_position();
            const [menuWidth] = this._adjacentTo.get_transformed_size();
            anchorX = menuX + menuWidth + 6;
            if (anchorX + cardWidth > workArea.x + workArea.width)
                anchorX = menuX - cardWidth - 6;
            anchorY = Math.min(buttonY, workArea.y + workArea.height - cardHeight);
        }
        const x = Math.max(workArea.x, Math.min(anchorX,
            workArea.x + workArea.width - cardWidth));
        const y = Math.max(workArea.y, anchorY);
        this._actor.set_position(Math.round(x), Math.round(y));
        this._actor.set_size(cardWidth, cardHeight);
        // Allocate our own card, independently of the source/button allocation.
        const box = new Clutter.ActorBox();
        box.set_origin(Math.round(x), Math.round(y));
        box.set_size(cardWidth, cardHeight);
        this._actor.allocate(box);
        this._actor.get_parent().set_child_above_sibling(this._actor, null);
    }

    _updatePreview(width, workArea) {
        const source = this._window.get_compositor_private();
        if (source !== this._source) {
            this._clearSource();
            this._source = source;
            source?.connectObject(
                'notify::allocation', () => this._queueUpdate(),
                'notify::mapped', () => this._queueUpdate(),
                'destroy', () => {
                    this._clearSource();
                    this._queueUpdate();
                }, this._actor);
        }

        const frame = this._window.get_frame_rect();
        if (!source || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) ||
            frame.width <= 0 || frame.height <= 0) {
            this._clearClone();
            return;
        }

        if (!this._clone) {
            try {
                // The compositor actor supplies pixels, never sizing/readiness.
                this._clone = new Clutter.Clone({source});
                this._preview.set_child(this._clone);
            } catch {
                // Keep text visible; source/window signals can recover a clone.
                this._clearClone();
                return;
            }
        }

        // Group cards share a compact slot; fit each window inside it without
        // changing its aspect ratio. Individual previews retain their geometry.
        const proportionalHeight = this._embedded ? width * 9 / 16 : width * frame.height / frame.width;
        const height = Math.max(1, Math.min(proportionalHeight, workArea.height / 2));
        const scale = Math.min(width / frame.width, height / frame.height);
        this._clone.set_size(frame.width * scale, frame.height * scale);
        this._clone.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._preview.height = height;
        this._preview.show();
    }

    hide() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._actor.hide();
        this._window?.disconnectObject(this._actor);
        this._window = null;
        this._clearSource();
    }

    destroy() {
        this.hide();
        if (!this._embedded)
            Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
    }
}

class GroupWindowHoverPanel {
    constructor(button, settings) {
        this._button = button;
        this._settings = settings;
        this._entries = new Map();
        this._closingWindows = new Set();
        this._rows = [];
        this._laterId = 0;
        this._hideId = 0;
        this._modalGrab = null;
        this._actor = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: true,
            visible: false,
        });
        this._panel = new St.BoxLayout({
            style_class: 'window-list-group-preview-panel',
            orientation: Clutter.Orientation.VERTICAL,
            clip_to_allocation: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'window-list-group-preview-scroll',
            reactive: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,
            enable_mouse_scrolling: true,
        });
        // St.Viewport translates its own coordinate system when scrolling.
        // Its clip_to_view follows the adjustment; clip_to_allocation would
        // clip against the original first page, including during picking.
        this._content = new St.BoxLayout({
            style_class: 'window-list-group-preview-rows',
            orientation: Clutter.Orientation.VERTICAL,
            clip_to_view: true,
        });
        this._scroll.set_child(this._content);
        this._panel.add_child(this._scroll);
        this._actor.add_child(this._panel);
        // Cover only the real distance from the work-area edge to button top.
        this._bridge = new St.Widget({reactive: true, clip_to_allocation: true});
        this._actor.add_child(this._bridge);
        Main.layoutManager.addChrome(this._actor);
        this._actor.connect('notify::hover', () => this.syncHover());
        // Capture ESC and Ctrl+wheel before focused children consume them.
        this._actor.connect('captured-event', (_actor, event) => {
            if (this._modalGrab && event.type() === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this._button._hoverDismissed = true;
                this._button._cancelShowLabel();
                this.hide();
                return Clutter.EVENT_STOP;
            }
            if (event.type() === Clutter.EventType.SCROLL)
                return this._onScrollEvent(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this._panel.connect('style-changed', () => this._queueLayout());
        this._scroll.connect('style-changed', () => this._queueLayout());
        settings.connectObject('changed::preview-width',
            () => this._queueLayout(), this._actor);
        button.connectObject(
            'notify::allocation', () => this._queueLayout(),
            'notify::mapped', () => {
                if (!button.mapped)
                    this.hide();
            },
            'drag-begin', () => this.hide(), this._actor);
        global.display.connectObject(
            'notify::focus-window', () => this._syncLastActive(),
            'workareas-changed', () => this._queueLayout(), this._actor);
    }

    show() {
        if (this._button._hoverDismissed)
            return;
        if (this._actor.visible) {
            this.syncHover();
            return;
        }
        this.refresh(true);
    }

    _onScrollEvent(event) {
        if (!(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return Clutter.EVENT_PROPAGATE;
        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = 20;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -20;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            this._zoomRemainder = (this._zoomRemainder ?? 0) - dy * 20;
            delta = Math.trunc(this._zoomRemainder);
            this._zoomRemainder -= delta;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        if (delta) {
            const width = this._settings.get_int('preview-width');
            const [, range] = this._settings.settings_schema.get_key('preview-width').get_range().deep_unpack();
            const [min, max] = range.deep_unpack();
            const newWidth = Math.max(min, Math.min(max, width + delta));
            if (newWidth !== width)
                this._settings.set_int('preview-width', newWidth);
        }
        return Clutter.EVENT_STOP;
    }

    refresh(show = false) {
        if (!show && !this._actor.visible)
            return;
        this._cancelHide();
        const windows = this._button.getWindowList()
            .filter(window => !this._closingWindows.has(window));
        if (windows.length < 2 || !this._button.mapped ||
            this._button._menu.isOpen || this._button._contextMenu.isOpen) {
            this.hide();
            return;
        }
        // Keep the panel mapped during membership changes. New buttons stay
        // hidden until layout, so hover/grabs on existing cards are preserved.
        for (const [window, entry] of this._entries) {
            if (!windows.includes(window)) {
                entry.card.destroy();
                entry.button.destroy();
                this._entries.delete(window);
            }
        }
        for (const window of windows) {
            if (this._entries.has(window))
                continue;
            const cardButton = new St.Button({
                style_class: 'window-list-group-preview-button',
                reactive: true,
                can_focus: true,
                track_hover: true,
                button_mask: St.ButtonMask.ONE,
                x_expand: false,
                y_expand: false,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
                visible: false,
            });
            if (!this._rows.length)
                this._addRow();
            this._rows[0].add_child(cardButton);
            const card = new WindowHoverCard(this._button, this._settings, {
                parent: cardButton,
                onSizeChanged: () => this._queueLayout(),
            });
            card._title.add_style_class_name('window-list-group-preview-title');
            this._entries.set(window, {button: cardButton, card});
            cardButton.connect('notify::hover', () => {
                if (cardButton.hover)
                    card._actor.add_style_pseudo_class('hover');
                else
                    card._actor.remove_style_pseudo_class('hover');
            });
            cardButton.connect('clicked', () => {
                this.hide();
                Main.activateWindow(window);
            });
            window.connectObject(
                'workspace-changed', () => this.refresh(),
                'notify::skip-taskbar', () => this.refresh(),
                'unmanaging', () => {
                    this._closingWindows.add(window);
                    this.refresh();
                }, cardButton);
            card.show(window);
        }
        this._syncLastActive(windows);
        // Allocate the entire panel before mapping any embedded preview actors.
        this._layout();
        for (const entry of this._entries.values())
            entry.button.show();
        this._actor.show();
        if (!this._modalGrab) {
            // On Wayland, a stage signal alone cannot intercept application
            // keys. Main.pushModal saves the previous key focus; popModal
            // restores it after releasing the grab. Grab the stage
            // so pointer events can still reach the source taskbar button and
            // other groups, preserving their click, hover and drag behavior.
            this._modalGrab = Main.pushModal(global.stage, {
                actionMode: Shell.ActionMode.POPUP,
            });
            if (!this._modalGrab) {
                this._modalGrab = null;
                this.hide();
                return;
            }
            global.stage.set_key_focus(this._actor);
        }
        if (!show)
            this.syncHover();
    }

    _syncLastActive(windows = this._button.getWindowList()) {
        if (!this._entries.size)
            return;
        const lastActive = this._button._getLastActiveWindow(windows);
        for (const [window, entry] of this._entries) {
            if (window === lastActive)
                entry.card._actor.add_style_pseudo_class('last-active');
            else
                entry.card._actor.remove_style_pseudo_class('last-active');
        }
    }

    _queueLayout() {
        if (!this._entries.size || this._laterId)
            return;
        const laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                if (this._laterId !== laterId)
                    return GLib.SOURCE_REMOVE;
                this._laterId = 0;
                this._layout();
                return GLib.SOURCE_REMOVE;
            });
        this._laterId = laterId;
    }

    _layout() {
        if (!this._entries.size)
            return;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(this._button._monitorIndex);
        const [buttonX, buttonY] = this._button._button.get_transformed_position();
        const [buttonWidth] = this._button._button.get_transformed_size();
        const bottom = Math.min(buttonY, workArea.y + workArea.height);
        const availableHeight = Math.max(1, bottom - workArea.y);
        const bounds = new Clutter.ActorBox();
        bounds.set_origin(0, 0);
        bounds.set_size(workArea.width, availableHeight);
        const contentBox = this._panel.get_theme_node().get_content_box(bounds);
        const availableWidth = Math.max(1, contentBox.get_width());
        const maxHeight = Math.max(1, contentBox.get_height());
        const entries = [...this._entries.values()];
        const cardWidth = Math.max(...entries.map(entry =>
            entry.button.get_preferred_width(-1)[1]));
        const cardHeight = Math.max(...entries.map(entry =>
            entry.button.get_preferred_height(cardWidth)[1]));
        if (!this._rows.length)
            this._addRow();
        const spacing = this._rows[0].get_theme_node().get_length('spacing');
        const rowSpacing = this._content.get_theme_node().get_length('spacing');
        const rowsBox = this._content.get_theme_node().get_content_box(bounds);
        const contentInset = workArea.width - rowsBox.get_width();
        // Reserve three themed gaps for the non-overlay scrollbar without
        // measuring an internal actor. ScrollView allocates the bar itself;
        // the content's right padding keeps it clear of the cards.
        const scrollbarGutter = 3 * spacing;
        // The viewport is sized for 3x3 cards at the schema's default zoom.
        // Keep that budget as zoom changes; smaller cards reveal more columns
        // and rows, rather than shrinking the panel together with its cards.
        const defaultWidth = this._settings.get_default_value('preview-width').get_int32();
        const previewWidth = this._settings.get_int('preview-width');
        const referenceWidth = cardWidth - previewWidth + defaultWidth;
        const previewHeightDelta = Math.min(defaultWidth * 9 / 16, workArea.height / 2) -
            Math.min(previewWidth * 9 / 16, workArea.height / 2);
        const referenceHeight = Math.max(...entries.map(entry =>
            entry.button.get_preferred_height(cardWidth)[1] +
            (entry.card._preview.visible ? previewHeightDelta : 0)));
        const referenceColumns = Math.min(3, entries.length);
        const viewportWidth = Math.min(availableWidth,
            referenceColumns * referenceWidth + (referenceColumns - 1) * spacing +
            contentInset + scrollbarGutter);
        const columns = Math.max(1, Math.min(entries.length, Math.floor(
            (viewportWidth - contentInset - scrollbarGutter + spacing) / (cardWidth + spacing))));
        const rowCount = Math.ceil(entries.length / columns);
        while (this._rows.length < rowCount)
            this._addRow();
        entries.forEach((entry, i) => {
            const row = this._rows[Math.floor(i / columns)];
            if (entry.button.get_parent() !== row) {
                entry.button.get_parent()?.remove_child(entry.button);
                row.add_child(entry.button);
            }
        });
        while (this._rows.length > rowCount)
            this._rows.pop().destroy();
        // Uniform slots keep rows aligned, including cards without a source.
        for (const row of this._rows)
            row.height = cardHeight;

        const viewportHeight = 3 * referenceHeight + 2 * rowSpacing;
        const scrollWidth = viewportWidth;
        const scrollHeight = Math.min(maxHeight, viewportHeight,
            rowCount * cardHeight + (rowCount - 1) * rowSpacing);
        this._scroll.set_size(scrollWidth, scrollHeight);
        const width = scrollWidth + workArea.width - contentBox.get_width();
        const panelHeight = scrollHeight + availableHeight - contentBox.get_height();
        const bridgeHeight = Math.max(0, buttonY - bottom);
        const height = panelHeight + bridgeHeight;
        const x = Math.max(workArea.x, Math.min(
            buttonX + (buttonWidth - width) / 2,
            workArea.x + workArea.width - width));
        // Share the button's exact edge, including fractional monitor scaling.
        const y = buttonY - height;
        // FixedLayout keeps natural scroll-content requests from enlarging the
        // outer actor or allocating the reactive bridge over the card area.
        this._panel.set_position(0, 0);
        this._panel.set_size(width, panelHeight);
        this._bridge.set_position(0, panelHeight);
        this._bridge.set_size(width, bridgeHeight);
        this._actor.set_position(x, y);
        this._actor.set_size(width, height);
        const box = new Clutter.ActorBox();
        box.set_origin(x, y);
        box.set_size(width, height);
        this._actor.allocate(box);
        this._actor.get_parent().set_child_above_sibling(this._actor, null);
        // Keep a mapped panel mapped: hiding during layout invalidates hover
        // and interrupts St.Button/ScrollBar pointer grabs mid-interaction.
    }

    _addRow() {
        const row = new St.BoxLayout({style_class: 'window-list-group-preview-row'});
        this._content.add_child(row);
        this._rows.push(row);
    }

    syncHover() {
        if (!this._actor.visible)
            return;
        if (this._containsPointer()) {
            this._cancelHide();
            return;
        }
        if (this._hideId)
            return;
        // Leave can precede enter and picking can still describe the preceding
        // allocation. Check again after event delivery before destroying buttons.
        const hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (this._hideId !== hideId)
                return GLib.SOURCE_REMOVE;
            this._hideId = 0;
            if (!this._containsPointer())
                this.hide();
            return GLib.SOURCE_REMOVE;
        });
        this._hideId = hideId;
    }

    _containsPointer() {
        const [x, y] = global.get_pointer();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        const grabActor = global.stage.get_grab_actor();
        return this._button._button.hover || this._actor.hover ||
            !!(actor && (this._button._button.contains(actor) || this._actor.contains(actor))) ||
            !!(grabActor && this._actor.contains(grabActor));
    }

    _cancelHide() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
    }

    hide() {
        this._cancelHide();
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        this._zoomRemainder = 0;
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._actor.hide();
        for (const entry of this._entries.values()) {
            entry.card.destroy();
            entry.button.destroy();
        }
        this._entries.clear();
        this._closingWindows.clear();
        for (const row of this._rows)
            row.destroy();
        this._rows = [];
        const adjustment = this._scroll.get_vadjustment();
        if (adjustment)
            adjustment.value = adjustment.lower;
    }

    destroy() {
        this.hide();
        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
    }
}

class BaseButton extends DashItemContainer {
    static {
        GObject.registerClass({
            GTypeFlags: GObject.TypeFlags.ABSTRACT,
            Properties: {
                'ignore-workspace': GObject.ParamSpec.boolean(
                    'ignore-workspace', null, null,
                    GObject.ParamFlags.READWRITE,
                    false),
            },
            Signals: {
                'drag-begin': {},
                'drag-end': {},
            },
        }, this);
    }

    constructor(perMonitor, monitorIndex) {
        super();

        this._button = new St.Button({
            style_class: 'window-button',
            can_focus: true,
            x_expand: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        this.setChild(this._button);

        this._button.connect('notify::hover', () => {
            if (this._button.hover) {
                this._queueShowLabel();
            } else {
                this._hoverDismissed = false;
                this.hideLabel();
            }
        });

        this._perMonitor = perMonitor;
        this._monitorIndex = monitorIndex;
        this._ignoreWorkspace = false;

        this.connect('notify::allocation',
            this._updateIconGeometry.bind(this));
        this._button.connect('clicked', this._onClicked.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('popup-menu', this._onPopupMenu.bind(this));

        this._contextMenuManager = new PopupMenu.PopupMenuManager(this);

        global.window_manager.connectObject('switch-workspace',
            () => this._updateVisibility(), this);

        if (this._perMonitor) {
            global.display.connectObject(
                'window-entered-monitor',
                this._windowEnteredOrLeftMonitor.bind(this),
                'window-left-monitor',
                this._windowEnteredOrLeftMonitor.bind(this),
                this);
        }

        this._button._delegate = this;
        this._draggable = DND.makeDraggable(this._button);
        this._draggable.connect('drag-begin', () => {
            this._hoverDragging = true;
            this._removeLongPressTimeout();
            this.hideLabel();
            this.emit('drag-begin');
        });
        this._draggable.connect('drag-cancelled', () => {
            this._hoverDragging = false;
            this._draggable._dragActor?.setTargetWidth(this.width);
            this.emit('drag-end');
        });
        this._draggable.connect('drag-end', () => {
            this._hoverDragging = false;
            this.emit('drag-end');
        });
    }

    get active() {
        return this._button.has_style_class_name('focused');
    }

    setMaximumWidth(maximumWidth) {
        this._button.get_child().set_style(
            `-st-natural-width: ${maximumWidth}px; ` +
            `max-width: ${maximumWidth}px;`);
    }

    get ignore_workspace() {
        return this._ignoreWorkspace;
    }

    set ignore_workspace(ignore) {
        if (this._ignoreWorkspace === ignore)
            return;

        this._ignoreWorkspace = ignore;
        this.notify('ignore-workspace');

        this._updateVisibility();
    }

    _queueShowLabel() {
        if (this._hoverDismissed || this._showLabelId)
            return;
        if (this._groupHoverPanel?._actor.visible) {
            this._groupHoverPanel.syncHover();
            return;
        }
        const showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._showLabelId !== showId)
                return GLib.SOURCE_REMOVE;
            this._showLabelId = 0;
            if (this.mapped && this._button.hover && !this._hoverDismissed &&
                !this._hoverDragging && !this._menu?.isOpen && !this._contextMenu?.isOpen)
                this.showLabel();
            return GLib.SOURCE_REMOVE;
        });
        this._showLabelId = showId;
    }

    _cancelShowLabel() {
        if (this._showLabelId)
            GLib.source_remove(this._showLabelId);
        this._showLabelId = 0;
    }

    showLabel() {
        if (this._hoverDismissed)
            return;
        const window = this instanceof WindowButton
            ? (this._unmanaging ? null : this.metaWindow)
            : (this._singleWindowMode ? this.getWindowList()[0] : null);
        if (window) {
            super.hideLabel();
            if (!this._hoverCard) {
                const settings = Extension.lookupByURL(import.meta.url).getSettings();
                this._hoverCard = new WindowHoverCard(this, settings);
            }
            this._hoverCard.show(window);
            return;
        }
        this._hoverCard?.hide();
        this.setLabelText(getTitleTooltipText(this.label_actor));
        super.showLabel();
    }

    hideLabel() {
        this._cancelShowLabel();
        this._hoverCard?.hide();
        super.hideLabel();
    }

    _setLongPressTimeout() {
        if (this._longPressTimeoutId)
            return;

        const {longPressDuration} = Clutter.Settings.get_default();
        this._longPressTimeoutId =
            GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, longPressDuration, () => {
                delete this._longPressTimeoutId;

                if (this._canOpenPopupMenu() && !this._contextMenu.isOpen)
                    this._openMenu(this._contextMenu);
            });
    }

    _removeLongPressTimeout() {
        if (!this._longPressTimeoutId)
            return;
        GLib.source_remove(this._longPressTimeoutId);
        delete this._longPressTimeoutId;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() === 1)
            this._setLongPressTimeout();
        return super.vfunc_button_press_event(event);
    }

    vfunc_button_release_event(event) {
        this._removeLongPressTimeout();

        return super.vfunc_button_release_event(event);
    }

    vfunc_touch_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN)
            this._setLongPressTimeout();
        else if (event.type() === Clutter.EventType.TOUCH_END)
            this._removeLongPressTimeout();
        return super.vfunc_touch_event(event);
    }

    activate() {
        if (this.active)
            return;

        this._onClicked(this, 1);
    }

    getDragActor() {
        const titleActor = this._createTitleActor();
        titleActor.set({abstractLabel: true});

        const dragActor = new DragActor(this, titleActor);

        const [, natWidth] = this.get_preferred_width(-1);
        const targetWidth = Math.min(natWidth / 2, this.width);
        dragActor.setTargetWidth(targetWidth);

        return dragActor;
    }

    getDragActorSource() {
        return this;
    }

    _createTitleActor() {
        throw new GObject.NotImplementedError(
            `_createTitleActor in ${this.constructor.name}`);
    }

    _onClicked(_actor, _button) {
        throw new GObject.NotImplementedError(
            `_onClicked in ${this.constructor.name}`);
    }

    _canOpenPopupMenu() {
        return true;
    }

    _openMenu(menu) {
        menu.open();

        const event = Clutter.get_current_event();
        if (event && event.type() === Clutter.EventType.KEY_RELEASE)
            menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _minimizeOrActivateWindow(window) {
        const focusWindow = global.display.focus_window;
        if (focusWindow === window ||
            focusWindow && focusWindow.get_transient_for() === window)
            window.minimize();
        else
            window.activate(global.get_current_time());
    }

    _onMenuStateChanged(menu, isOpen) {
        if (isOpen)
            return;

        const extension = Extension.lookupByURL(import.meta.url);

        const [x, y] = global.get_pointer();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (extension.someWindowListContains(actor))
            actor.sync_hover();
    }

    _onPopupMenu(_actor) {
        if (!this._canOpenPopupMenu() || this._contextMenu.isOpen)
            return;
        this._openMenu(this._contextMenu);
    }

    _isFocused() {
        throw new GObject.NotImplementedError(
            `_isFocused in ${this.constructor.name}`);
    }

    _updateStyle() {
        if (this._isFocused())
            this._button.add_style_class_name('focused');
        else
            this._button.remove_style_class_name('focused');
    }

    _windowEnteredOrLeftMonitor(_metaDisplay, _monitorIndex, _metaWindow) {
        throw new GObject.NotImplementedError(
            `_windowEnteredOrLeftMonitor in ${this.constructor.name}`);
    }

    _isWindowVisible(window) {
        const workspace = global.workspace_manager.get_active_workspace();

        return !window.skip_taskbar &&
               (this._ignoreWorkspace || window.located_on_workspace(workspace)) &&
               (!this._perMonitor || window.get_monitor() === this._monitorIndex);
    }

    _updateVisibility() {
        throw new GObject.NotImplementedError(
            `_updateVisibility in ${this.constructor.name}`);
    }

    _getIconGeometry() {
        const rect = new Mtk.Rectangle();

        [rect.x, rect.y] = this.get_transformed_position();
        [rect.width, rect.height] = this.get_transformed_size();

        return rect;
    }

    _updateIconGeometry() {
        throw new GObject.NotImplementedError(
            `_updateIconGeometry in ${this.constructor.name}`);
    }

    _onDestroy() {
        this._cancelShowLabel();
        this._hoverCard?.destroy();
        this._hoverCard = null;
        this._removeLongPressTimeout();
        this._contextMenu?.destroy();
    }
}

class WindowButton extends BaseButton {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow, perMonitor, monitorIndex) {
        super(perMonitor, monitorIndex);

        this.metaWindow = metaWindow;
        this._unmanaging = false;
        metaWindow.connectObject(
            'notify::skip-taskbar', () => this._updateVisibility(),
            'workspace-changed', () => this._updateVisibility(),
            'unmanaging', () => (this._unmanaging = true),
            this);

        this._updateVisibility();

        const windowTitle = this._createTitleActor();
        this._button.set_child(windowTitle);
        this.label_actor = windowTitle.label_actor;

        this._contextMenu = new WindowContextMenu(this, this.metaWindow);
        this._contextMenu.connect('open-state-changed',
            this._onMenuStateChanged.bind(this));
        this._contextMenu.actor.hide();
        this._contextMenuManager.addMenu(this._contextMenu);
        Main.uiGroup.add_child(this._contextMenu.actor);

        global.display.connectObject('notify::focus-window',
            () => this._updateStyle(), this);
        this._updateStyle();
    }

    get id() {
        return `window:${this.metaWindow.get_id()}`;
    }

    _createTitleActor() {
        return new WindowTitle(this.metaWindow);
    }

    _onClicked(actor, button) {
        if (this._contextMenu.isOpen) {
            this._contextMenu.close();
            return;
        }

        if (!button || button === 1)
            this._minimizeOrActivateWindow(this.metaWindow);
        else
            this._openMenu(this._contextMenu);
    }

    _isFocused() {
        return global.display.focus_window === this.metaWindow;
    }

    _updateStyle() {
        super._updateStyle();

        if (this.metaWindow.minimized)
            this._button.add_style_class_name('minimized');
        else
            this._button.remove_style_class_name('minimized');
    }

    _windowEnteredOrLeftMonitor(metaDisplay, monitorIndex, metaWindow) {
        if (monitorIndex === this._monitorIndex && metaWindow === this.metaWindow)
            this._updateVisibility();
    }

    _updateVisibility() {
        if (this._unmanaging)
            return;

        this.visible = this._isWindowVisible(this.metaWindow);
    }

    _updateIconGeometry() {
        this.metaWindow.set_icon_geometry(this._getIconGeometry());
    }
}

class AppContextMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, St.Side.BOTTOM);

        this._appButton = source;

        this._minimizeItem = new PopupMenu.PopupMenuItem(_('Minimize all'));
        this._minimizeItem.connect('activate', () => {
            this._appButton.getWindowList().forEach(w => w.minimize());
        });
        this.addMenuItem(this._minimizeItem);

        this._unminimizeItem = new PopupMenu.PopupMenuItem(_('Unminimize all'));
        this._unminimizeItem.connect('activate', () => {
            this._appButton.getWindowList().forEach(w => w.unminimize());
        });
        this.addMenuItem(this._unminimizeItem);

        this._maximizeItem = new PopupMenu.PopupMenuItem(_('Maximize all'));
        this._maximizeItem.connect('activate', () => {
            this._appButton.getWindowList().forEach(w => {
                w.maximize();
            });
        });
        this.addMenuItem(this._maximizeItem);

        this._unmaximizeItem = new PopupMenu.PopupMenuItem(_('Unmaximize all'));
        this._unmaximizeItem.connect('activate', () => {
            this._appButton.getWindowList().forEach(w => {
                w.unmaximize();
            });
        });
        this.addMenuItem(this._unmaximizeItem);

        const item = new PopupMenu.PopupMenuItem(_('Close all'));
        item.connect('activate', () => {
            this._appButton.getWindowList().forEach(w => {
                w.delete(global.get_current_time());
            });
        });
        this.addMenuItem(item);
    }

    open(animate) {
        const windows = this._appButton.getWindowList();
        this._minimizeItem.visible = windows.some(w => !w.minimized);
        this._unminimizeItem.visible = windows.some(w => w.minimized);
        this._maximizeItem.visible = windows.some(w => {
            return !w.is_maximized();
        });
        this._unmaximizeItem.visible = windows.some(w => {
            return w.is_maximized();
        });

        super.open(animate);
    }
}

class GroupedWindowMenuItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow, menu, maxWidth, monitorIndex) {
        super();
        this.add_style_class_name('window-list-grouped-item');

        this._window = metaWindow;

        this._title = new WindowTitle(metaWindow);
        this._title.set_style(`max-width: ${maxWidth}px;`);
        this.add_child(this._title);
        this.label_actor = this._title.label_actor;

        this._monitorIndex = monitorIndex;
        this._unmanaging = false;
        this.connect('notify::hover', () => this._syncPreview(menu));
        this.connect('notify::allocation', () => this._syncPreview(menu));
        this.connect('notify::mapped', () => this._syncPreview(menu));
        metaWindow.connectObject('unmanaging', () => {
            this._unmanaging = true;
            this._syncPreview(menu);
        }, this);
        this.connect('destroy', () => {
            if (menu._windowPreviewItem === this)
                menu._windowPreviewItem = null;
            this._hoverCard?.destroy();
            this._hoverCard = null;
        });

        global.display.connectObject(
            'notify::focus-window', () => this._syncFocus(), this);
        menu.connectObject(
            'open-state-changed', () => {
                this._syncFocus();
                this._syncPreview(menu);
            }, this);
        this._syncFocus();
    }

    _syncPreview(menu) {
        if (!menu.isOpen || !this.hover || !this.mapped || this._unmanaging) {
            this._hoverCard?.hide();
            if (menu._windowPreviewItem === this)
                menu._windowPreviewItem = null;
            return;
        }
        // Enter can precede the previous row's leave notification.
        if (menu._windowPreviewItem !== this) {
            menu._windowPreviewItem?._hoverCard?.hide();
            menu._windowPreviewItem = this;
        }
        if (!this._hoverCard) {
            const settings = Extension.lookupByURL(import.meta.url).getSettings();
            this._hoverCard = new WindowHoverCard(this, settings, {adjacentTo: menu.actor});
        }
        this._hoverCard.show(this._window);
    }

    _syncFocus() {
        if (global.display.focus_window === this._window)
            this.add_style_class_name('active-window');
        else
            this.remove_style_class_name('active-window');
    }
}

class AppButton extends BaseButton {
    static {
        GObject.registerClass(this);
    }

    constructor(app, perMonitor, monitorIndex) {
        super(perMonitor, monitorIndex);

        this.app = app;
        this._updateVisibility();

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
        this._menu.connect('open-state-changed',
            this._onMenuStateChanged.bind(this));
        this._menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._groupHoverPanel?.hide();
        });
        this._menu.actor.hide();
        this._menu.connect('activate', this._onMenuActivate.bind(this));
        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);

        this.app.connectObject('windows-changed',
            () => this._windowsChanged(), this);
        this._windowsChanged();

        this._windowTracker = Shell.WindowTracker.get_default();
        this._windowTracker.connectObject('notify::focus-app',
            () => this._updateStyle(), this);
        this._updateStyle();
    }

    get id() {
        return `app:${this.app.get_id()}`;
    }

    _windowEnteredOrLeftMonitor(metaDisplay, monitorIndex, metaWindow) {
        if (this._windowTracker.get_window_app(metaWindow) === this.app &&
            monitorIndex === this._monitorIndex) {
            this._updateVisibility();
            this._windowsChanged();
        }
    }

    _updateVisibility() {
        if (this._ignoreWorkspace) {
            this.visible = true;
        } else if (!this._perMonitor) {
            // fast path: use ShellApp API to avoid iterating over all windows.
            const workspace = global.workspace_manager.get_active_workspace();
            this.visible = this.app.is_on_workspace(workspace);
        } else {
            this.visible = this.getWindowList().length >= 1;
        }
        this._groupHoverPanel?.refresh();
    }

    _isFocused() {
        return this._windowTracker.focus_app === this.app;
    }

    _updateIconGeometry() {
        const rect = this._getIconGeometry();

        const windows = this.app.get_windows();
        windows.forEach(w => w.set_icon_geometry(rect));
    }

    getWindowList() {
        return this.app.get_windows().filter(win => this._isWindowVisible(win));
    }

    _getLastActiveWindow(windows) {
        const mruWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        return mruWindows.find(win => windows.includes(win)) ?? windows[0];
    }

    showLabel() {
        if (this._hoverDismissed)
            return;
        if (this.getWindowList().length > 1) {
            super.hideLabel();
            if (!this._groupHoverPanel) {
                const settings = Extension.lookupByURL(import.meta.url).getSettings();
                this._groupHoverPanel = new GroupWindowHoverPanel(this, settings);
            }
            this._groupHoverPanel.show();
            return;
        }
        super.showLabel();
    }

    hideLabel() {
        super.hideLabel();
        this._groupHoverPanel?.syncHover();
    }

    _windowsChanged() {
        const windows = this.getWindowList();
        const singleWindowMode = windows.length === 1;
        this._groupHoverPanel?.refresh();

        if (this._singleWindowMode === singleWindowMode)
            return;

        this._singleWindowMode = singleWindowMode;

        this._hoverCard?.hide();

        this._button.child?.destroy();
        this._contextMenu?.destroy();

        if (this._singleWindowMode) {
            const [window] = windows;
            this._contextMenu = new WindowContextMenu(this, window);
        } else {
            this._contextMenu = new AppContextMenu(this);
        }

        this._button.child = this._createTitleActor();
        this.label_actor = this._button.child.label_actor;

        this._contextMenu.connect(
            'open-state-changed', this._onMenuStateChanged.bind(this));
        this._contextMenu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._groupHoverPanel?.hide();
        });
        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();
        this._contextMenuManager.addMenu(this._contextMenu);
    }

    _createTitleActor() {
        if (this._singleWindowMode) {
            const [window] = this.getWindowList();
            return new WindowTitle(window);
        } else {
            return new AppTitle(this.app);
        }
    }

    _onClicked(actor, button) {
        this._groupHoverPanel?.hide();
        const menuWasOpen = this._menu.isOpen;
        if (menuWasOpen)
            this._menu.close();

        const contextMenuWasOpen = this._contextMenu.isOpen;
        if (contextMenuWasOpen)
            this._contextMenu.close();

        if (!button || button === 1) {
            if (menuWasOpen)
                return;

            const windows = this.getWindowList();
            if (windows.length === 1) {
                if (contextMenuWasOpen)
                    return;
                this._minimizeOrActivateWindow(windows[0]);
            } else if (windows.length > 1 &&
                !windows.includes(global.display.focus_window)) {
                Main.activateWindow(this._getLastActiveWindow(windows));
            } else {
                this._menu.removeAll();
                const maxWidth = this._getMenuMaxWidth();

                for (let i = 0; i < windows.length; i++) {
                    const item = new GroupedWindowMenuItem(
                        windows[i], this._menu, maxWidth, this._monitorIndex);
                    this._menu.addMenuItem(item);
                }
                this._openMenu(this._menu);
            }
        } else {
            if (contextMenuWasOpen)
                return;
            this._openMenu(this._contextMenu);
        }
    }

    _getMenuMaxWidth() {
        const workArea =
            Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);
        const maxWidth = Math.floor(workArea.width / 2);

        this._menu.actor.set_style(`max-width: ${maxWidth}px;`);
        return maxWidth;
    }

    _canOpenPopupMenu() {
        return !this._menu.isOpen;
    }

    _onMenuActivate(menu, child) {
        child._window.activate(global.get_current_time());
    }

    _onDestroy() {
        this._groupHoverPanel?.destroy();
        this._groupHoverPanel = null;
        super._onDestroy();
        this._menu.destroy();
    }
}

class WindowList extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(perMonitor, monitor, settings) {
        super({
            name: 'panel',
            style_class: 'bottom-panel solid',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._windowSignals = new Map();
        this._clockTimeoutId = 0;
        this._dndTimeoutId = 0;
        this._dndWindow = null;
        this._destroyed = false;
        this._ctrlAltTabGroupAdded = false;
        this._itemDragMonitorInstalled = false;
        this.connect('destroy', this._onDestroy.bind(this));

        this._perMonitor = perMonitor;
        this._monitor = monitor;

        const box = new St.BoxLayout({x_expand: true, y_expand: true});
        this.add_child(box);

        this._windowList = new St.BoxLayout({
            style_class: 'window-list',
            reactive: true,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._windowList);

        this._windowList.connect('scroll-event', this._onScrollEvent.bind(this));

        const indicatorsBox = new St.BoxLayout({
            style_class: 'window-list-status-area',
            x_align: Clutter.ActorAlign.END,
            x_expand: false,
            y_expand: true,
        });
        box.add_child(indicatorsBox);

        this._workspaceIndicator = new BottomWorkspaceIndicator({
            baseStyleClass: 'window-list-workspace-indicator',
            compact: true,
            settings,
        });
        indicatorsBox.add_child(this._workspaceIndicator.container);

        this._clock = new St.Label({
            style_class: 'window-list-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        indicatorsBox.add_child(this._clock);
        this._updateClock();

        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._mutterSettings.connectObject(
            'changed::workspaces-only-on-primary',
            () => this._updateWorkspaceIndicatorVisibility(),
            'changed::dynamic-workspaces',
            () => this._updateWorkspaceIndicatorVisibility(),
            this);
        this._updateWorkspaceIndicatorVisibility();

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._workspaceIndicator.connectObject('menu-set',
            () => this._onWorkspaceMenuSet(), this);
        this._onWorkspaceMenuSet();

        const inOverview = Main.overview.visible ||
            (Main.layoutManager._startingUp && Main.sessionMode.hasOverview);

        const overviewChromeOptions = {
            affectsStruts: true,
        };
        const chromeOptions = {
            ...overviewChromeOptions,
            trackFullscreen: true,
        };
        Main.layoutManager.addChrome(this, inOverview
            ? overviewChromeOptions
            : chromeOptions);

        Main.uiGroup.set_child_above_sibling(this, Main.layoutManager.panelBox);
        Main.ctrlAltTabManager.addGroup(this, _('Window List'), 'start-here-symbolic');
        this._ctrlAltTabGroupAdded = true;

        this.visible = !inOverview;

        global.display.connectObject('workareas-changed',
            () => this._updatePosition(), this);
        this._updatePosition();

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('app-state-changed',
            this._onAppStateChanged.bind(this), this);

        // Hack: OSK gesture is tied to visibility, piggy-back on that
        Main.keyboard._bottomDragGesture.connectObject('notify::enabled',
            action => {
                const visible = !action.enabled;
                if (visible) {
                    Main.uiGroup.set_child_above_sibling(
                        this, Main.layoutManager.keyboardBox);
                } else {
                    Main.uiGroup.set_child_above_sibling(
                        this, Main.layoutManager.panelBox);
                }
                this._updateKeyboardAnchor();
            }, this);

        const workspaceManager = global.workspace_manager;

        workspaceManager.connectObject('notify::n-workspaces',
            () => this._updateWorkspaceIndicatorVisibility(), this);
        this._updateWorkspaceIndicatorVisibility();

        global.window_manager.connectObject('switch-workspace',
            () => this._checkGrouping(), this);

        Main.overview.connectObject(
            'showing', () => {
                this._retrackChrome(overviewChromeOptions);
                this._slideOut();
                this._updateKeyboardAnchor();
            },
            'hiding', () => {
                if (!this._monitor.inFullscreen)
                    this._slideIn();
            },
            'hidden', () => {
                this._retrackChrome(chromeOptions);
                this._updateKeyboardAnchor();
            }, this);

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject('startup-complete', () => {
                if (Main.overview.visible)
                    return;

                this._retrackChrome(chromeOptions);
                if (!this._monitor.inFullscreen)
                    this._slideIn();
                this._updateKeyboardAnchor();
            }, this);
        }

        global.display.connectObject('in-fullscreen-changed', () => {
            this._updateKeyboardAnchor();
        }, this);

        global.display.connectObject(
            'window-created', (dsp, win) => this._addWindow(win, true), this);

        Main.xdndHandler.connectObject(
            'drag-begin', () => this._monitorXdndDrag(),
            'drag-end', () => this._stopMonitoringXdndDrag(),
            this);

        this._xdndDragMonitor = {
            dragMotion: this._onXdndDragMotion.bind(this),
        };

        this._itemDragMonitor = {
            dragMotion: this._onItemDragMotion.bind(this),
            dragDrop: this._onItemDragDrop.bind(this),
        };

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._lastPlaceholderUpdate = 0;

        this._delegate = this;

        this._settings = settings;

        currentIconSize = this._settings.get_int('icon-size');

        this._settings.connectObject(
            'changed::grouping-mode',
            () => this._groupingModeChanged(),

            'changed::font-size',
            () => this._applyAppearance(),

            'changed::panel-height',
            () => this._applyAppearance(),

            'changed::maximum-button-width',
            () => this._maximumButtonWidthChanged(),

            'changed::icon-size',
            () => {
                currentIconSize = this._settings.get_int('icon-size');
                this._populateWindowList();
            },

            this);

        this._applyAppearance();

        this._grouped = undefined;
        this._groupingModeChanged();
    }

    _applyAppearance() {
        const fontSize = this._settings.get_int('font-size');
        const panelHeight = this._settings.get_int('panel-height');

        this.set_style(
            `height: ${panelHeight}px;`);

        // The requested panel height is already known here. Position the panel
        // directly instead of reacting synchronously to notify::height while
        // Clutter is still resolving the new allocation.
        this._updatePosition(panelHeight);

        this._windowList.set_style(
            `font-size: ${fontSize}pt;`);
    }

    _maximumButtonWidthChanged() {
        const maximumWidth = this._settings.get_int('maximum-button-width');

        for (const child of this._windowList.get_children()) {
            if (child instanceof BaseButton)
                child.setMaximumWidth(maximumWidth);
        }

        this._checkGrouping();
    }

    get_transformed_position() {
        // HACK: Remove translation we use for animations
        //       to keep struts stable
        const [x, y] = super.get_transformed_position();
        return [x, y - this.translation_y];
    }

    _onScrollEvent(actor, event) {
        const direction = event.get_scroll_direction();
        let diff = 0;
        if (direction === Clutter.ScrollDirection.DOWN)
            diff = 1;
        else if (direction === Clutter.ScrollDirection.UP)
            diff = -1;
        else
            return;

        const children = this._windowList.get_children()
            .filter(c => c.visible);
        const active = children.findIndex(c => c.active);
        const newActive = Math.max(0, Math.min(active + diff, children.length - 1));
        children[newActive].activate();
    }

    _onWorkspaceMenuSet() {
        if (this._workspaceIndicator.menu)
            this._menuManager.addMenu(this._workspaceIndicator.menu);
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        this._clock.text = now.format('%H:%M');

        const millisecondsToNextMinute =
            (60 - now.get_second()) * 1000 -
            Math.floor(now.get_microsecond() / 1000);
        this._clockTimeoutId = GLib.timeout_add_once(
            GLib.PRIORITY_DEFAULT,
            Math.max(millisecondsToNextMinute, 100),
            () => {
                this._clockTimeoutId = 0;
                this._updateClock();
            });
    }

    _updatePosition(panelHeight = this.height) {
        this.width = this._monitor.width;
        this.set_position(
            this._monitor.x,
            this._monitor.y + this._monitor.height - panelHeight);
    }

    _retrackChrome(options) {
        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.trackChrome(this, options);
    }

    _slideIn() {
        this.show();
        this.ease({
            translation_y: 0,
            duration: SLIDE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _slideOut() {
        this.ease({
            translation_y: this.height,
            duration: SLIDE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.hide(),
        });
    }

    _updateWorkspaceIndicatorVisibility() {
        const workspaceManager = global.workspace_manager;
        const hasWorkspaces = this._mutterSettings.get_boolean('dynamic-workspaces') ||
                            workspaceManager.n_workspaces > 1;
        const workspacesOnMonitor = this._monitor === Main.layoutManager.primaryMonitor ||
                                  !this._mutterSettings.get_boolean('workspaces-only-on-primary');

        this._workspaceIndicator.visible = hasWorkspaces && workspacesOnMonitor;
    }

    _getPreferredUngroupedWindowListWidth() {
        if (this._windowList.get_n_children() === 0)
            return this._windowList.get_preferred_width(-1)[1];

        const children = this._windowList.get_children();
        const [, childWidth] = children[0].get_preferred_width(-1);
        const {spacing} = this._windowList.layout_manager;

        const workspace = global.workspace_manager.get_active_workspace();
        let windows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        if (this._perMonitor)
            windows = windows.filter(w => w.get_monitor() === this._monitor.index);
        const nWindows = windows.length;
        if (nWindows === 0)
            return this._windowList.get_preferred_width(-1)[1];

        return nWindows * childWidth + (nWindows - 1) * spacing;
    }

    _getMaxWindowListWidth() {
        const indicatorsBox = this._workspaceIndicator?.get_parent();
        if (!indicatorsBox)
            return Math.max(0, this.width);

        return Math.max(
            0,
            this.width - indicatorsBox.get_preferred_width(-1)[1]);
    }

    _groupingModeChanged() {
        this._groupingMode = this._settings.get_enum('grouping-mode');

        if (this._groupingMode === GroupingMode.AUTO) {
            this._checkGrouping();
        } else {
            this._grouped = this._groupingMode === GroupingMode.ALWAYS;
            this._populateWindowList();
        }
    }

    _checkGrouping() {
        if (this._destroyed ||
            this._groupingMode !== GroupingMode.AUTO)
            return;

        const maxWidth = this._getMaxWindowListWidth();
        const natWidth = this._getPreferredUngroupedWindowListWidth();

        const grouped = maxWidth < natWidth;
        if (this._grouped !== grouped) {
            this._grouped = grouped;
            this._populateWindowList();
        }
    }

    _populateWindowList() {
        this._windowList.destroy_all_children();

        if (!this._grouped) {
            const windows = global.get_window_actors().sort((w1, w2) => {
                return w1.metaWindow.get_stable_sequence() -
                       w2.metaWindow.get_stable_sequence();
            });
            for (let i = 0; i < windows.length; i++)
                this._addWindow(windows[i].metaWindow, false);
        } else {
            const apps = this._appSystem.get_running().sort((a1, a2) => {
                return _getAppStableSequence(a1) -
                       _getAppStableSequence(a2);
            });
            for (let i = 0; i < apps.length; i++)
                this._addApp(apps[i], false);
        }

        this._restorePositions();
    }

    _updateKeyboardAnchor() {
        const translationY = Main.overview.visible ? 0 : this.height;
        Main.layoutManager.keyboardBox.translation_y = -translationY;
    }

    _onAppStateChanged(appSys, app) {
        if (!this._grouped)
            return;

        if (app.state === Shell.AppState.RUNNING)
            this._addApp(app, true);
        else if (app.state === Shell.AppState.STOPPED)
            this._removeApp(app);
    }

    _addButton(button, animate) {
        this._settings.bind('display-all-workspaces',
            button, 'ignore-workspace', Gio.SettingsBindFlags.GET);

        button.setMaximumWidth(
            this._settings.get_int('maximum-button-width'));

        button.connect('drag-begin', () => {
            button.ease({
                opacity: 255 * DRAG_OPACITY,
                duration: DRAG_FADE_DURATION,
            });

            this._monitorItemDrag();
        });
        button.connect('drag-end', () => {
            button.ease({
                opacity: 255,
                duration: DRAG_FADE_DURATION,
            });

            this._stopMonitoringItemDrag();
            this._clearDragPlaceholder();
        });

        this._windowList.add_child(button);
        button.show(animate);
    }

    _addApp(app, animate) {
        const button = new AppButton(app, this._perMonitor, this._monitor.index);
        this._addButton(button, animate);
    }

    _removeApp(app) {
        const children = this._windowList.get_children();
        const child = children.find(c => c.app === app);
        child?.animateOutAndDestroy();
    }

    _addWindow(win, animate) {
        if (!this._grouped)
            this._checkGrouping();

        if (this._grouped)
            return;

        const children = this._windowList.get_children();
        if (children.find(c => c.metaWindow === win))
            return;

        const id = this._windowSignals.get(win);
        if (id)
            win.disconnect(id);

        this._windowSignals.set(
            win, win.connect('unmanaged', () => this._removeWindow(win)));

        const button = new WindowButton(win, this._perMonitor, this._monitor.index);
        this._addButton(button, animate);
    }

    _removeWindow(win) {
        if (this._grouped)
            this._checkGrouping();

        if (this._grouped)
            return;

        const id = this._windowSignals.get(win);
        if (id)
            win.disconnect(id);
        this._windowSignals.delete(win);

        const children = this._windowList.get_children();
        const child = children.find(c => c.metaWindow === win);
        child?.animateOutAndDestroy();
    }

    _disconnectWindowSignals() {
        this._windowSignals.forEach((id, win) => win.disconnect(id));
        this._windowSignals.clear();
    }

    _clearDragPlaceholder() {
        this._dragPlaceholder?.animateOutAndDestroy();
        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
    }

    handleDragOver(source, _actor, x, _y, _time) {
        if (!(source instanceof BaseButton))
            return DND.DragMotionResult.NO_DROP;

        const buttons = this._windowList.get_children().filter(c => c instanceof BaseButton);
        const buttonPos = buttons.indexOf(source);
        const numButtons = buttons.length;
        const boxWidth = this._windowList.width;

        // Transform to window list coordinates for index calculation
        // (mostly relevant for RTL to discard workspace indicator etc.)
        x -= this._windowList.x;

        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        let pos = rtl
            ? numButtons - Math.round(x * numButtons / boxWidth)
            : Math.round(x * numButtons / boxWidth);

        pos = Math.clamp(pos, 0, numButtons);

        const timeDelta =
            GLib.get_monotonic_time() - this._lastPlaceholderUpdate;

        if (pos !== this._dragPlaceholderPos && timeDelta >= MIN_DRAG_UPDATE_INTERVAL) {
            this._clearDragPlaceholder();
            this._dragPlaceholderPos = pos;

            this._lastPlaceholderUpdate = GLib.get_monotonic_time();

            // Don't allow positioning before or after self
            if (pos === buttonPos || pos === buttonPos + 1)
                return DND.DragMotionResult.CONTINUE;

            this._dragPlaceholder = new DragPlaceholderItem();
            const sibling = buttons[pos] ?? null;
            if (sibling)
                this._windowList.insert_child_below(this._dragPlaceholder, sibling);
            else
                this._windowList.insert_child_above(this._dragPlaceholder, null);
            this._dragPlaceholder.show(true);
        }

        return this._dragPlaceholder
            ? DND.DragMotionResult.MOVE_DROP
            : DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        if (this._dragPlaceholderPos >= 0)
            this._windowList.set_child_at_index(source, this._dragPlaceholderPos);

        this._clearDragPlaceholder();

        this._savePositions();

        return true;
    }

    _getPositionStateKey() {
        return `${SAVED_POSITIONS_KEY}:${this._monitor.index}`;
    }

    _savePositions() {
        const buttons = this._windowList.get_children()
            .filter(b => b instanceof BaseButton);
        global.set_runtime_state(this._getPositionStateKey(),
            new GLib.Variant('as', buttons.map(b => b.id)));
    }

    _restorePositions() {
        const positions = global.get_runtime_state('as',
            this._getPositionStateKey())?.deepUnpack() ?? [];

        for (const button of this._windowList.get_children()) {
            const pos = positions.indexOf(button.id);
            if (pos > -1)
                this._windowList.set_child_at_index(button, pos);
        }
    }

    _monitorItemDrag() {
        if (this._itemDragMonitorInstalled)
            return;

        DND.addDragMonitor(this._itemDragMonitor);
        this._itemDragMonitorInstalled = true;
    }

    _stopMonitoringItemDrag() {
        if (!this._itemDragMonitorInstalled)
            return;

        DND.removeDragMonitor(this._itemDragMonitor);
        this._itemDragMonitorInstalled = false;
    }

    _onItemDragMotion(dragEvent) {
        const {source, targetActor, dragActor, x, y} = dragEvent;

        const hasTarget = this._windowList.contains(targetActor);
        const isNear = Math.abs(y - this.y) < DRAG_PROXIMITY_THRESHOLD;

        if (hasTarget || isNear)
            return this.handleDragOver(source, dragActor, x, y);

        this._clearDragPlaceholder();
        return DND.DragMotionResult.CONTINUE;
    }

    _onItemDragDrop(dropEvent) {
        if (this._dragPlaceholderPos < 0)
            return DND.DragDropResult.CONTINUE;

        const {source} = dropEvent.dropActor;
        this.acceptDrop(source);
        dropEvent.dropActor.destroy();
        // HACK: SUCCESS would make more sense, but results in gnome-shell
        // skipping all drag-end code
        return DND.DragDropResult.CONTINUE;
    }

    _monitorXdndDrag() {
        DND.addDragMonitor(this._xdndDragMonitor);
    }

    _stopMonitoringXdndDrag() {
        if (this._xdndDragMonitor)
            DND.removeDragMonitor(this._xdndDragMonitor);
        this._removeActivateTimeout();
    }

    _onXdndDragMotion(dragEvent) {
        if (Main.overview.visible ||
            !this.contains(dragEvent.targetActor)) {
            this._removeActivateTimeout();
            return DND.DragMotionResult.CONTINUE;
        }

        const hoveredWindow = dragEvent.targetActor.metaWindow;
        if (!hoveredWindow ||
            this._dndWindow === hoveredWindow)
            return DND.DragMotionResult.CONTINUE;

        this._removeActivateTimeout();

        this._dndWindow = hoveredWindow;
        this._dndTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            DND_ACTIVATE_TIMEOUT, this._activateWindow.bind(this));

        return DND.DragMotionResult.CONTINUE;
    }

    _removeActivateTimeout() {
        if (this._dndTimeoutId)
            GLib.source_remove(this._dndTimeoutId);
        this._dndTimeoutId = 0;
        this._dndWindow = null;
    }

    _activateWindow() {
        const [x, y] = global.get_pointer();
        const pickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);

        if (this._dndWindow && this.contains(pickedActor))
            this._dndWindow.activate(global.get_current_time());
        this._dndWindow = null;
        this._dndTimeoutId = 0;
    }

    _onDestroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._clockTimeoutId)
            GLib.source_remove(this._clockTimeoutId);
        this._clockTimeoutId = 0;

        // Stop callbacks before destroying objects they depend on.
        this._disconnectWindowSignals();

        this._stopMonitoringItemDrag();
        this._stopMonitoringXdndDrag();

        this._settings?.disconnectObject(this);
        this._settings = null;

        if (this._ctrlAltTabGroupAdded) {
            Main.ctrlAltTabManager.removeGroup(this);
            this._ctrlAltTabGroupAdded = false;
        }

        this._workspaceIndicator?.destroy();
        this._workspaceIndicator = null;

        const windows = global.get_window_actors();
        for (let i = 0; i < windows.length; i++)
            windows[i].metaWindow.set_icon_geometry(null);
    }
}

class BottomWorkspaceIndicator extends WorkspaceIndicator {
    static {
        GObject.registerClass(this);
    }

    setMenu(menu) {
        super.setMenu(menu);

        if (!menu)
            return;

        this.menu.actor.updateArrowSide(St.Side.BOTTOM);
        this.menu.actor.remove_style_class_name('panel-menu');
    }
}

export default class WindowListExtension extends Extension {
    constructor(metadata) {
        super(metadata);

        this._windowLists = null;
    }

    enable() {
        this._windowLists = [];
        this._keyboardTranslationY = Main.layoutManager.keyboardBox.translation_y;

        this._settings = this.getSettings();
        this._settings.connectObject('changed::show-on-all-monitors',
            () => this._buildWindowLists(), this);

        Main.layoutManager.connectObject('monitors-changed',
            () => this._buildWindowLists(), this);

        this._buildWindowLists();
    }

    _buildWindowLists() {
        this._windowLists.forEach(list => list.destroy());
        this._windowLists = [];

        const showOnAllMonitors = this._settings.get_boolean('show-on-all-monitors');

        Main.layoutManager.monitors.forEach(monitor => {
            if (showOnAllMonitors || monitor === Main.layoutManager.primaryMonitor)
                this._windowLists.push(new WindowList(showOnAllMonitors, monitor, this.getSettings()));
        });
    }

    disable() {
        if (!this._windowLists)
            return;

        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;

        this._windowLists.forEach(windowList => {
            windowList.hide();
            windowList.destroy();
        });
        this._windowLists = null;
        Main.layoutManager.keyboardBox.translation_y = this._keyboardTranslationY;
        this._keyboardTranslationY = null;
    }

    someWindowListContains(actor) {
        return this._windowLists.some(list => list.contains(actor));
    }
}
