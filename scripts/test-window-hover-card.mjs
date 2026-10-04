// Exercise the real card/button hover methods without a running GNOME Shell.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Signals {
    constructor() {
        this.signals = [];
    }

    connect(name, callback) {
        this.signals.push({name, callback});
    }

    connectObject(...args) {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2)
            this.signals.push({name: args[i], callback: args[i + 1], owner});
    }

    disconnectObject(owner) {
        this.signals = this.signals.filter(signal => signal.owner !== owner);
    }

    emit(name, ...args) {
        let result;
        for (const signal of [...this.signals]) {
            if (signal.name === name && this.signals.includes(signal))
                result = signal.callback(this, ...args);
            if (name === 'captured-event' && result === true)
                return result;
        }
        return result;
    }
}

class Actor extends Signals {
    constructor(properties = {}) {
        super();
        Object.assign(this, {visible: true, mapped: true, allocated: true,
            reactive: false, clip_to_allocation: false, opacity: 255,
            children: [], parent: null, destroyed: false}, properties);
        this.clutter_text = {
            set() {},
            get_layout: () => ({
                get_font_description() {},
                get_context: () => ({
                    get_language() {},
                    get_metrics: () => ({get_ascent: () => 10, get_descent: () => 4}),
                }),
            }),
        };
    }

    add_child(child) {
        assert.equal(child.parent, null, 'an actor must never be reparented');
        this.children.push(child);
        child.parent = this;
    }

    set_child(child) {
        assert.equal(this.children.length, 0, 'previous clone must be released');
        this.add_child(child);
    }

    get_parent() { return this.parent; }
    get_n_children() { return this.children.length; }
    [Symbol.iterator]() { return this.children[Symbol.iterator](); }
    remove_child(child) {
        assert.equal(child.parent, this);
        this.children = this.children.filter(actor => actor !== child);
        child.parent = null;
    }
    contains(actor) {
        return actor === this || this.children.some(child => child.contains(actor));
    }
    add_style_class_name(name) { (this.classes ??= new Set()).add(name); }
    remove_style_class_name(name) { this.classes?.delete(name); }
    add_style_pseudo_class(name) { (this.pseudos ??= new Set()).add(name); }
    remove_style_pseudo_class(name) { this.pseudos?.delete(name); }
    set_style(style) { this.style = style; }
    set_child_above_sibling(child) { assert.equal(child.parent, this); }
    show() {
        assert.equal(this.destroyed, false);
        if (this.style_class === 'window-list-hover-card' &&
            this.parent?.style_class === 'window-list-group-preview-button' && !this.visible) {
            let ancestor = this.parent;
            while (ancestor?.visible)
                ancestor = ancestor.parent;
            assert.ok(ancestor, 'new embedded cards render under an unmapped panel until layout');
        }
        this.visible = true;
    }
    hide() {
        assert.equal(this.destroyed, false);
        this.hideCount = (this.hideCount ?? 0) + 1;
        this.visible = false;
    }
    set(properties) { Object.assign(this, properties); }
    set_size(width, height) { Object.assign(this, {width, height}); }
    set_position(x, y) { Object.assign(this, {x, y}); }
    get_size() { return [this.width, this.height]; }
    has_allocation() { return this.allocated; }
    get_transformed_position() { return [this.x ?? 0, this.y ?? 900]; }
    get_transformed_size() { return [this.width ?? 100, this.height ?? 40]; }
    get_preferred_width() {
        if (this.width >= 0)
            return [0, this.width];
        if (this.style_class === 'window-list-group-preview-button')
            return [0, this.children[0]?.width ?? 0];
        if (this.style_class === 'window-list-group-preview-row')
            return [0, this.children.reduce((w, child) => w + child.get_preferred_width()[1], 0) +
                8 * Math.max(0, this.children.length - 1)];
        if (this.style_class === 'window-list-group-preview-rows')
            return [0, Math.max(0, ...this.children.map(child => child.get_preferred_width()[1])) + 8];
        return [0, Math.max(...this.children.map(child => child.width ?? 0)) + 20];
    }
    get_preferred_height() {
        if (this.height >= 0)
            return [0, this.height];
        if (this.style_class === 'window-list-group-preview-button')
            return [0, this.children[0]?.height ?? 0];
        if (this.style_class === 'window-list-group-preview-row')
            return [0, Math.max(0, ...this.children.map(child => child.get_preferred_height()[1]))];
        if (this.style_class === 'window-list-group-preview-rows')
            return [0, this.children.reduce((h, child) => h + child.get_preferred_height()[1], 0) +
                8 * Math.max(0, this.children.length - 1)];
        const children = this.children.filter(child => child.visible);
        return [0, children.reduce((height, child) => height + (child.height ?? 14), 20) +
            8 * Math.max(0, children.length - 1)];
    }
    allocate() { this.allocated = true; }
    get_theme_node() {
        return {
            get_length: () => 8,
            get_content_box: box => ({
                get_width: () => box.width -
                    (this.style_class === 'window-list-group-preview-rows' ? 8 : 14),
                get_height: () => box.height -
                    (this.style_class === 'window-list-group-preview-rows' ? 0 : 14),
            }),
        };
    }

    destroy() {
        assert.equal(this.destroyed, false, 'an actor must be destroyed only once');
        this.destroyed = true;
        this.emit('destroy');
        for (const child of [...this.children])
            child.destroy();
        if (this.parent) {
            this.parent.children = this.parent.children.filter(child => child !== this);
            this.parent = null;
        }
        for (const emitter of emitters)
            emitter.disconnectObject(this);
    }
}

const emitters = [];
const chrome = new Set();
const uiGroup = new Actor();
const pending = new Map();
const timeouts = new Map();
const deadlines = new Map();
let elapsed = 0;
let nextId = 0;
const laters = {
    add(type, callback) { pending.set(++nextId, callback); return nextId; },
    remove(id) { pending.delete(id); },
};
function redraw() {
    const callbacks = [...pending];
    pending.clear();
    for (const [, callback] of callbacks)
        callback();
}

function expireTimeouts() {
    for (const [id, callback] of [...timeouts]) {
        if (!timeouts.delete(id))
            continue;
        deadlines.delete(id);
        assert.equal(callback(), false, 'hover close checks must never poll');
    }
}

function advanceTime(ms) {
    elapsed += ms;
    for (const [id, callback] of [...timeouts]) {
        if (deadlines.get(id) > elapsed || !timeouts.delete(id))
            continue;
        deadlines.delete(id);
        assert.equal(callback(), false, 'hover checks must be one-shot');
    }
}

class DashItemContainer extends Actor {
    hideLabel() { this.shellLabelVisible = false; }
    showLabel() { this.shellLabelVisible = true; }
}

const settings = new Signals();
settings.width = 240;
settings.get_int = () => settings.width;
settings.get_default_value = () => ({get_int32: () => 240});
settings.settings_schema = {get_key: () => ({
    get_range: () => ({deep_unpack: () => ['range', {deep_unpack: () => [160, 480]}]}),
})};
settings.writes = [];
settings.set_int = (key, value) => {
    assert.equal(key, 'preview-width');
    assert.ok(value >= 160 && value <= 480);
    settings.width = value;
    settings.writes.push(value);
    settings.emit(`changed::${key}`);
};
emitters.push(settings);
class ScrollView extends Actor {
    constructor(properties) {
        super(properties);
        this.vadjustment = {lower: 0, value: 0};
    }

    get_vadjustment() { return this.vadjustment; }
}
class Button extends Actor {
    constructor(properties) {
        // St.Button is interactive by default, unlike a plain St.Widget.
        super({reactive: true, track_hover: true, ...properties});
    }

    destroy() {
        // Unmapping a hovered St.Button can notify before native destruction
        // has finished. Its preview must no longer receive this notification.
        if (this.hover) {
            this.hover = false;
            this.emit('notify::hover');
        }
        super.destroy();
    }
}
const context = vm.createContext({
    St: {BoxLayout: Actor, Label: Actor, Bin: Actor, Button, Widget: Actor,
        ScrollView, PolicyType: {NEVER: 0, AUTOMATIC: 1}, ButtonMask: {ONE: 1}},
    Clutter: {
        EVENT_PROPAGATE: false, EVENT_STOP: true,
        EventType: {SCROLL: 1, KEY_PRESS: 2}, KEY_Escape: 27,
        ModifierType: {CONTROL_MASK: 4},
        ScrollDirection: {UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4},
        FixedLayout: class {},
        Orientation: {VERTICAL: 1}, ActorAlign: {CENTER: 1, START: 2},
        PickMode: {REACTIVE: 1}, get_current_event: () => null,
        Clone: class extends Actor {
            constructor(properties) {
                if (properties.source.cloneUnavailable)
                    throw new Error('Source cannot currently be cloned');
                super(properties);
            }
        },
        ActorBox: class {
            set_origin(x, y) { Object.assign(this, {x, y}); }
            set_size(width, height) { Object.assign(this, {width, height}); }
        },
    },
    Pango: {EllipsizeMode: {END: 1}, WrapMode: {WORD_CHAR: 1}, SCALE: 1},
    Main: {layoutManager: {
        addChrome(actor) {
            assert.ok(actor, 'chrome must always have an actor');
            assert.equal(chrome.has(actor), false);
            chrome.add(actor);
            uiGroup.add_child(actor);
            if (actor.reactive && actor.track_hover) {
                actor.allocated = false;
                const show = actor.show.bind(actor);
                actor.show = () => {
                    assert.equal(actor.allocated, true, 'allocate the panel before mapping it');
                    show();
                };
            }
        },
        removeChrome(actor) { assert.equal(chrome.delete(actor), true); },
        findIndexForActor: button => button.monitorAvailable === false ? -1 : 0,
        getWorkAreaForMonitor: () => ({x: 0, y: 0, width: 1920, height: 1000}),
    }},
    Shell: {ActionMode: {POPUP: 1},
        WindowTracker: {get_default: () => ({get_window_app: () => ({get_name: () => 'App'})})}},
    Meta: {LaterType: {BEFORE_REDRAW: 1}, TabList: {NORMAL: 1}},
    GLib: {
        SOURCE_REMOVE: false, PRIORITY_DEFAULT: 0,
        timeout_add(_priority, delay, callback) {
            assert.ok(delay === 150 || delay === 500);
            timeouts.set(++nextId, callback);
            deadlines.set(nextId, elapsed + delay);
            return nextId;
        },
        source_remove(id) { assert.equal(timeouts.delete(id), true); deadlines.delete(id); },
    },
    GObject: {
        registerClass() {}, TypeFlags: {ABSTRACT: 1},
        ParamSpec: {boolean() {}}, ParamFlags: {READWRITE: 1},
    },
    DashItemContainer,
    _: text => text,
    global: {compositor: {get_laters: () => laters}},
});
const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /get_seat_state/,
    'production must never inspect the opaque Shell 50.1 modal grab');
assert.doesNotMatch(source, /\.[vh]scroll/,
    'production must use public ScrollView APIs, never private scrollbar fields');
const scrollApi = new ScrollView();
assert.equal('vscroll' in scrollApi, false);
assert.equal('hscroll' in scrollApi, false);
assert.equal(scrollApi.get_vadjustment(), scrollApi.vadjustment);
const classes = source.slice(source.indexOf('class WindowHoverCard {'), source.indexOf('class AppContextMenu '));
vm.runInContext(`${classes.replaceAll('import.meta.url', "'mock-extension'")}
    this.Button = WindowButton; this.Card = WindowHoverCard;`, context);
const hoverConnection = source.match(/this\._button\.connectObject\('notify::hover', \(\) => \{[\s\S]*?\n        \}, this\);/)[0];
const connectHover = vm.runInContext(`(function() { ${hoverConnection} })`, context);

function makeButtons(count = 8) {
    return Array.from({length: count}, (_, i) => {
        const windowActor = new Actor({width: 0, height: 0, allocated: false, mapped: false});
        for (const method of ['has_allocation', 'get_size', 'get_transformed_size'])
            windowActor[method] = () => assert.fail(`Source ${method} must not gate the preview`);
        Object.defineProperty(windowActor, 'mapped', {
            get: () => assert.fail('Source mapped state must not gate the preview'),
        });
        const window = new Signals();
        Object.assign(window, {title: `Window ${i}`, source: windowActor,
            frame: {width: 1200, height: 800}, activated: false,
            get_frame_rect() { return this.frame; },
            get_compositor_private() { return this.source; }, get_wm_class: () => 'App',
            activate: () => assert.fail('Hover must not activate a window'),
        });
        const button = new Actor({x: 100 * i, allocated: false});
        button.has_allocation = () => assert.fail('Button allocation must not gate the card');
        // Use the real individual-button showLabel/hideLabel/destroy methods.
        Object.setPrototypeOf(button, context.Button.prototype);
        Object.assign(button, {metaWindow: window, _button: new Actor(),
            _monitorIndex: 0, label: new Actor(), _settings: settings,
            _someWindowListContains: () => false});
        connectHover.call(button);
        emitters.push(button, window, windowActor);
        return button;
    });
}

function textVisible(button, window = button.metaWindow) {
    assert.equal(button._hoverCard._actor.visible, true);
    assert.equal(button._hoverCard._actor.opacity, 255);
    assert.equal(button._hoverCard._window, window);
    assert.equal(button._hoverCard._appName.text, 'App');
    assert.equal(button._hoverCard._title.text, window.title);
    assert.equal(button._hoverCard._title.height, 28);
    assert.deepEqual(button._hoverCard._actor.children,
        [button._hoverCard._appName, button._hoverCard._preview, button._hoverCard._title]);
    assert.equal((button.label ?? button.label_actor).destroyed, false,
        'Shell label lifecycle must remain separate');
}

function visible(button, window = button.metaWindow) {
    textVisible(button, window);
    assert.equal(button._hoverCard._clone.source, window.source);
    assert.equal(button._hoverCard._preview.visible, true);
}

const buttons = makeButtons();
const orders = [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [7, 6, 5, 4, 3, 2, 1, 0],
    [0, 7, 2, 5, 1, 6, 3, 4, 0, 2, 0],
];
let randomState = 12345;
orders.push(Array.from({length: 256}, () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState >>> 29;
}));
const order = orders.flat();
let previousButton = null;
function hover(button, entered) {
    button._button.hover = entered;
    button._button.emit('notify::hover');
}
for (const hoverOrder of orders) {
    for (const i of hoverOrder) {
        if (previousButton)
            hover(previousButton, false);
        const button = buttons[i];
        hover(button, true);
        advanceTime(499);
        assert.equal(button._hoverCard?._actor.visible ?? false, false);
        advanceTime(1);
        visible(button);
        assert.equal(button.metaWindow.activated, false);
        assert.equal(pending.size, 1, 'only the current owner needs one refresh');
        previousButton = button;
    }
    redraw();
    visible(previousButton);
}
hover(previousButton, false);
console.log('PASS: A–H, H–A, returns and 256 random hovers wait exactly 500ms without activation');

for (let cycle = 0; cycle < 5; cycle++) {
    for (const i of order) {
        const button = buttons[i];
        button.showLabel();
        visible(button);
        redraw();
        visible(button);
        const card = button._hoverCard;
        const actor = card._actor;
        const clone = card._clone;
        button.hideLabel();
        assert.equal(card._actor, actor);
        assert.equal(actor.destroyed, false);
        assert.equal(chrome.has(actor), true);
        assert.equal(clone.destroyed, true);
        assert.equal(card._clone, null);
        assert.equal(card._window, null);
    }
}
assert.equal(new Set(buttons.map(button => button._hoverCard._actor)).size, 8);
for (const button of buttons)
    button.showLabel();
redraw();
buttons.forEach(button => visible(button));
console.log('PASS: eight independent owners, unallocated/unmapped inactive sources and repeated hovers');

const a = buttons[0];
const b = buttons[1];
a.hideLabel();
for (let i = 0; i < 20; i++) {
    a.showLabel();
    a.hideLabel();
}
redraw();
visible(b);
assert.equal(b.metaWindow.source.destroyed, false);
assert.equal(a._hoverCard._actor.get_parent(), uiGroup);
console.log('PASS: rapid enter/leave cancels only the owning card');

for (const button of buttons) {
    button.hideLabel();
    button.allocated = false; // Chrome/layout invalidation before BEFORE_REDRAW.
    button.monitorAvailable = false; // Use the button's stable monitor index.
    button.get_transformed_size = () => [0, 0];
    button.showLabel();
    visible(button);
    redraw();
    assert.equal(button._hoverCard._window, button.metaWindow,
        'temporary allocation loss must retain the pending hover');
    button.emit('notify::allocation');
    redraw(); // Layout may still be pending; do not spin or discard the hover.
    assert.equal(pending.size, 0);
    button.allocated = true;
    button.emit('notify::allocation');
    redraw();
    visible(button);
}
console.log('PASS: missing button allocation/size never suppresses a card; pending work does not poll');

a.hideLabel();
a.allocated = false;
a.showLabel();
redraw();
a.hideLabel();
a.allocated = true;
a.emit('notify::allocation');
redraw();
assert.equal(a._hoverCard._actor.visible, false);
assert.equal(a._hoverCard._window, null);
visible(b);
console.log('PASS: leaving during pending layout cancels the hover without affecting another owner');

a.showLabel();
const staleSameWindow = pending.get(a._hoverCard._laterId);
a.hideLabel();
a.showLabel();
const currentId = a._hoverCard._laterId;
staleSameWindow(); // Simulate an already-dispatched callback after cancellation.
assert.equal(a._hoverCard._laterId, currentId);
assert.equal(pending.has(currentId), true);
visible(a);
const staleDifferentWindow = pending.get(currentId);
a._hoverCard.show(b.metaWindow);
const replacementId = a._hoverCard._laterId;
staleDifferentWindow();
assert.equal(a._hoverCard._laterId, replacementId);
assert.equal(pending.has(replacementId), true);
visible(a, b.metaWindow);
a.metaWindow.emit('unmanaging'); // The previous window is disconnected.
visible(a, b.metaWindow);
redraw();
visible(a, b.metaWindow);
a._hoverCard.show(a.metaWindow);
for (let i = 0; i < 20; i++) {
    a.metaWindow.emit('size-changed');
    a.metaWindow.emit('notify::title');
    a.metaWindow.source.emit('notify::allocation');
    a.metaWindow.source.emit('notify::mapped');
    a.emit('notify::allocation');
    a._hoverCard._actor.emit('style-changed');
    a.showLabel();
    assert.equal(pending.size, 1);
    visible(a);
}
redraw();
assert.equal(pending.size, 0, 'refresh must not reschedule itself');
visible(a);
console.log('PASS: stale callbacks cannot clear a newer same/different-window request; signals coalesce once');

settings.width = 320;
settings.emit('changed::preview-width');
a.showLabel();
redraw();
buttons.forEach(button => {
    const card = button._hoverCard;
    assert.equal(card._preview.width, 320);
    assert.equal(card._preview.height, 320 * 800 / 1200);
    assert.equal(card._appName.text, 'App');
    assert.equal(card._title.text, button.metaWindow.title);
    assert.equal(card._title.height, 28);
});
const shell = a._hoverCard._actor;
const oldClone = a._hoverCard._clone;
a.metaWindow.source = null;
oldClone.source.emit('destroy');
redraw();
assert.equal(oldClone.destroyed, true);
assert.equal(a._hoverCard._clone, null);
assert.equal(shell.visible, true);
assert.equal(shell.opacity, 255);
a.metaWindow.source = new Actor({width: 800, height: 600});
emitters.push(a.metaWindow.source);
a.metaWindow.emit('notify::title');
redraw();
visible(a);
assert.equal(a._hoverCard._actor, shell);
console.log('PASS: width, aspect ratio and labels preserved; source replacement keeps the card shell');

// Stable frame geometry controls sizing, regardless of contradictory actor size.
a.metaWindow.frame = {width: 1600, height: 900};
a.metaWindow.source.width = 25;
a.metaWindow.source.height = 700;
a.metaWindow.emit('size-changed');
redraw();
assert.equal(a._hoverCard._preview.height, 180);
assert.equal(a._hoverCard._clone.width, 320);
assert.equal(a._hoverCard._clone.height, 180);
a.metaWindow.frame = {width: 100, height: 10000};
a.metaWindow.emit('size-changed');
redraw();
assert.equal(a._hoverCard._preview.height, 500);
assert.equal(a._hoverCard._clone.width, 5);
assert.equal(a._hoverCard._clone.height, 500);
for (const frame of [
    {width: 0, height: 600}, {width: 800, height: -1},
    {width: NaN, height: 600}, {width: 800, height: Infinity},
]) {
    a.metaWindow.frame = frame;
    a.metaWindow.emit('size-changed');
    redraw();
    textVisible(a);
    assert.equal(a._hoverCard._clone, null);
    assert.equal(a._hoverCard._preview.visible, false);
}
a.metaWindow.frame = {width: 1200, height: 800};
a.metaWindow.emit('size-changed');
redraw();
visible(a);
console.log('PASS: frame_rect controls aspect ratio; tall/invalid geometry is safely bounded or text-only');

a.hideLabel();
const usableSource = a.metaWindow.source;
a.metaWindow.source = null;
a.showLabel();
textVisible(a); // Text is visible before the first deferred recovery.
assert.equal(a._hoverCard._clone, null);
assert.equal(a._hoverCard._preview.visible, false);
const textHeight = a._hoverCard._actor.height;
redraw();
assert.equal(pending.size, 0, 'missing source must not start a retry loop');
a.metaWindow.source = usableSource;
a.metaWindow.emit('shown');
redraw();
visible(a);
assert.ok(a._hoverCard._actor.height > textHeight, 'missing preview reserves no space');
a.hideLabel();
a.metaWindow.source = null;
a.showLabel();
textVisible(a);
a.metaWindow.source = usableSource;
redraw();
visible(a); // A source appearing during the initial layout refresh is recovered.

a.hideLabel();
usableSource.cloneUnavailable = true;
a.showLabel();
textVisible(a);
assert.equal(a._hoverCard._clone, null);
assert.equal(a._hoverCard._preview.visible, false);
redraw();
assert.equal(pending.size, 0);
usableSource.cloneUnavailable = false;
usableSource.emit('notify::allocation');
redraw();
visible(a);
console.log('PASS: missing/failed clones show text immediately, reserve no preview space and recover on events');

a.metaWindow.title = 'Changed title with enough words to span two lines';
a.metaWindow.emit('notify::title');
redraw();
visible(a);
assert.equal(a._hoverCard._actor.children.length, 3, 'no secondary/context UI child');
a.metaWindow.emit('unmanaging');
assert.equal(a._hoverCard._window, null);
assert.equal(a._hoverCard._actor.visible, false);
assert.equal(a.metaWindow.signals.some(signal => signal.owner === shell), false);
assert.equal(usableSource.signals.some(signal => signal.owner === shell), false);
console.log('PASS: two-line title updates, exactly three card children and window cleanup');

// AUTO rebuilds and NEVER rebuilds both destroy/create individual button owners.
for (const mode of ['AUTO rebuild', 'NEVER rebuild']) {
    for (const button of buttons) {
        button._destroy();
        button.destroy();
    }
    assert.equal(chrome.size, 0);
    buttons.splice(0, buttons.length, ...makeButtons());
    for (const i of order) {
        buttons[i].showLabel();
        redraw();
        visible(buttons[i]);
        buttons[i].hideLabel();
    }
    console.log(`PASS: ${mode}, all eight individual owners remain functional`);
}

buttons[0].showLabel();
redraw();
buttons[1].metaWindow.source = buttons[0].metaWindow.source;
buttons[1].showLabel();
redraw();
const otherClone = buttons[1]._hoverCard._clone;
buttons[0]._destroy();
assert.equal(otherClone.destroyed, false);
visible(buttons[1]);
assert.equal(buttons[1].metaWindow.source.destroyed, false);
buttons[1].mapped = false;
buttons[1].emit('notify::mapped');
assert.equal(buttons[1]._hoverCard._window, null);
assert.equal(buttons[1]._hoverCard._actor.destroyed, false);
for (const button of buttons)
    button._destroy();
assert.equal(chrome.size, 0);
assert.equal(pending.size, 0);
console.log('PASS: source sharing does not share clones or cleanup; unmap and disable release owned resources');

// Shell 50.1's DashItemContainer destroy handler runs before our own handler.
// Its child can already be destroyed when the button cleanup releases fields.
const inheritedOwner = makeButtons(1)[0];
const inheritedChild = inheritedOwner._button;
inheritedOwner.child = inheritedChild;
inheritedOwner.add_child(inheritedChild);
inheritedOwner.connect('destroy', () => {
    inheritedOwner.child?.destroy();
    inheritedOwner.label?.destroy();
});
inheritedOwner.connect('destroy', () => inheritedOwner._destroy());
inheritedOwner.showLabel();
redraw();
const inheritedCard = inheritedOwner._hoverCard;
const inheritedCardActor = inheritedCard._actor;
inheritedOwner.destroy();
assert.equal(inheritedChild.destroyed, true);
assert.equal(inheritedCardActor.destroyed, true);
assert.equal(inheritedOwner._button, null);
assert.equal(inheritedOwner.metaWindow, null);
assert.equal(inheritedCard._actor, null);
assert.equal(chrome.size, 0);
assert.equal(pending.size, 0);
console.log('PASS: inherited actor destruction cleans previews and references without destroying the button twice');

// Run the real grouped panel, item and AppButton methods in the same harness.
class Menu extends Signals {
    constructor() {
        super();
        this.actor = new Actor({x: 500, y: 600, width: 250, height: 250});
        this.isOpen = false;
        this.items = [];
        emitters.push(this);
    }
    addMenuItem(item) { this.items.push(item); }
    removeAll() { this.items.forEach(item => item.destroy()); this.items = []; }
    open() { this.isOpen = true; this.emit('open-state-changed', true); }
    close() { this.isOpen = false; this.emit('open-state-changed', false); }
    destroy() {
        this.close();
        this.removeAll();
        this.emit('destroy');
        this.actor.destroy();
        this.signals = [];
    }
}
// Model the public registration API of Shell 50.1's PopupMenuManager.
class ShellMenuManager {
    constructor() { this.menus = []; }
    addMenu(menu, position) {
        if (this.menus.includes(menu))
            return;
        if (position === undefined)
            this.menus.push(menu);
        else
            this.menus.splice(position, 0, menu);
        menu.connectObject(
            'open-state-changed', (_menu, open) => {
                if (open)
                    this.activeMenu = menu;
                else if (this.activeMenu === menu)
                    this.activeMenu = null;
            },
            'destroy', () => this.removeMenu(menu), this);
        menu.actor.connectObject('captured-event', () => {}, this);
    }
    removeMenu(menu) {
        if (!this.menus.includes(menu))
            return;
        menu.disconnectObject(this);
        menu.actor.disconnectObject(this);
        this.menus = this.menus.filter(item => item !== menu);
    }
}
const display = new Signals();
display.focus_window = null;
display.mru = [];
display.get_tab_list = () => display.mru;
emitters.push(display);
const activations = [];
let pickedActor = null;
let grabActor = null;
let keyFocus = null;
let nextModalResult = true;
let modalPushCount = 0;
let modalPopCount = 0;
const modalGrabs = [];
const modalRecords = new WeakMap();
const applicationKeys = [];
let workArea = {x: 0, y: 0, width: 1000, height: 900};
let workspace = 0;
context.global.display = display;
context.global.get_pointer = () => [0, 0];
context.global.get_current_time = () => 123;
context.global.workspace_manager = {get_active_workspace: () => workspace};
context.global.stage = Object.assign(new Signals(), {
    get_actor_at_pos: () => pickedActor,
    get_grab_actor: () => grabActor ?? modalRecords.get(modalGrabs.at(-1))?.actor ?? null,
    get_key_focus: () => keyFocus,
    set_key_focus: actor => { keyFocus = actor; },
});
emitters.push(context.global.stage);
context.Main.pushModal = (actor, {actionMode}) => {
    assert.equal(actor, context.global.stage,
        'the modal owner must allow pointer delivery to other taskbar buttons');
    assert.equal(actionMode, context.Shell.ActionMode.POPUP);
    const result = nextModalResult;
    nextModalResult = true;
    if (!result)
        return result;
    // Shell 50.1 returns an opaque handle. Keep Shell's focus bookkeeping
    // outside the handle, and fail even on an optional unsupported lookup.
    const grab = new Proxy(Object.freeze({}), {
        get(_target, property) {
            assert.fail(`Production accessed opaque modal grab property ${String(property)}`);
        },
    });
    modalRecords.set(grab, {actor, previousFocus: keyFocus});
    modalGrabs.push(grab);
    modalPushCount++;
    // Installed Main.pushModal(stage) clears key focus after saving it.
    context.global.stage.set_key_focus(actor === context.global.stage ? null : actor);
    return grab;
};
context.Main.popModal = grab => {
    const index = modalGrabs.indexOf(grab);
    assert.notEqual(index, -1, 'each modal grab must be released exactly once');
    const record = modalRecords.get(grab);
    const topmost = index === modalGrabs.length - 1;
    // Match Main's focus-chain repair for a modal removed out of order.
    for (let i = modalGrabs.length - 1; i > index; i--)
        modalRecords.get(modalGrabs[i]).previousFocus =
            modalRecords.get(modalGrabs[i - 1]).previousFocus;
    // Dismiss the grab before restoring focus.
    modalGrabs.splice(index, 1);
    modalPopCount++;
    if (topmost) {
        assert.equal(modalGrabs.includes(grab), false);
        context.global.stage.set_key_focus(record.previousFocus?.destroyed ? null : record.previousFocus);
    }
    modalRecords.delete(grab);
};

function dispatchKey(symbol) {
    // Wayland sends application keys straight to the client without a Shell
    // modal grab. Directly emitting a stage signal would hide that regression.
    if (!modalGrabs.length) {
        applicationKeys.push(symbol);
        return false;
    }
    const event = {type: () => context.Clutter.EventType.KEY_PRESS,
        get_key_symbol: () => symbol};
    if (context.global.stage.emit('captured-event', event) === true)
        return true;
    const path = [];
    for (let actor = keyFocus; actor && actor !== context.global.stage; actor = actor.parent)
        path.unshift(actor);
    return path.some(actor => actor.emit('captured-event', event) === true);
}
context.Main.layoutManager.getWorkAreaForMonitor = () => workArea;
context.Main.activateWindow = window => activations.push(window);
context.Main.uiGroup = uiGroup;
context.WindowTitle = class extends Actor {
    constructor() { super(); this.label_actor = new Actor(); this.add_child(this.label_actor); }
};
context.WindowContextMenu = Menu;
context.AppContextMenu = Menu;
context.PopupMenu = {
    PopupBaseMenuItem: Actor,
    PopupMenuManager: ShellMenuManager,
    PopupAnimation: {NONE: 0},
};
vm.runInContext(source.slice(source.indexOf('class WindowListMenuManager '),
    source.indexOf('class TitleWidget ')) + '\nthis.MenuManager = WindowListMenuManager;', context);
for (const open of [false, true]) {
    const manager = new context.MenuManager(new Actor());
    const first = new Menu();
    const second = new Menu();
    manager.addMenu(first);
    manager.addMenu(first);
    manager.addMenu(second, 0);
    assert.deepEqual(manager.menus, [second, first], 'duplicate registration stays harmless');
    first.destroy();
    assert.equal(manager._ownedMenus.has(first), false, 'destroyed menus leave the registry');
    if (open)
        second.open();
    manager.destroy();
    manager.destroy();
    assert.equal(second.isOpen, false, 'cleanup closes an active menu');
    assert.equal(manager.menus.length, 0);
    assert.equal(manager._ownedMenus, null);
    assert.equal(manager.activeMenu, null);
    assert.equal(second.signals.some(signal => signal.owner === manager), false);
    assert.equal(second.actor.signals.some(signal => signal.owner === manager), false);
    assert.equal(second.actor.destroyed, false, 'manager cleanup leaves menu destruction to its owner');
    second.destroy();
}
console.log('PASS: menu managers release open/closed registrations and signals; repeated cleanup is harmless');
const groupedSource = source.slice(source.indexOf('class GroupedWindowMenuItem '),
    source.indexOf('class WindowList '));
vm.runInContext(`${groupedSource.replaceAll('import.meta.url', "'mock-extension'")}
    this.App = AppButton; this.Item = GroupedWindowMenuItem;`, context);

function makeGroup(count) {
    const windows = makeButtons(count).map(button => button.metaWindow);
    windows.forEach((window, i) => Object.assign(window, {
        workspace: 0, monitor: 0, skip_taskbar: false,
        frame: {width: 1200 + 100 * i, height: 700 + 200 * i},
        located_on_workspace(ws) { return this.workspace === ws; },
        get_monitor() { return this.monitor; },
        activate(time) { assert.equal(time, 123); activations.push(this); },
        minimize() { this.minimized = true; },
    }));
    const group = new Actor();
    Object.setPrototypeOf(group, context.App.prototype);
    Object.assign(group, {
        app: Object.assign(new Signals(), {get_windows: () => windows, is_on_workspace: () => true}),
        _settings: settings, _someWindowListContains: () => false,
        _button: new Actor({x: 400, y: 910, width: 100, height: 40, hover: true}),
        _monitorIndex: 0, _perMonitor: true, _ignoreWorkspace: false,
        _singleWindowMode: count === 1,
        _menu: new Menu(), _contextMenu: new Menu(), label: new Actor(),
        _contextMenuManager: new context.MenuManager(group),
        _menuManager: new context.MenuManager(group),
    });
    group._contextMenuManager.addMenu(group._contextMenu);
    group._menuManager.addMenu(group._menu);
    group._button.child = new Actor();
    group._createTitleActor = () => new context.WindowTitle();
    group._menu.connect('open-state-changed', (_menu, open) => {
        if (open)
            group._groupHoverPanel?.hide();
    });
    connectHover.call(group);
    emitters.push(group, group._button);
    return {group, windows};
}

function settle() {
    for (let i = 0; pending.size && i < 10; i++)
        redraw();
    assert.equal(pending.size, 0, 'event refreshes must settle, never poll');
}

function cardPointerTarget(entry, leaf) {
    // Model Clutter reactive picking before dispatching to St.Button. Emitting
    // 'clicked' alone would incorrectly pass even with a non-reactive button.
    let actor = leaf;
    while (actor && !actor.reactive)
        actor = actor.get_parent();
    assert.equal(actor, entry.button, 'every card surface must pick its own button');
    return actor;
}

function scrollPointerTarget(panel, entry) {
    // St.Viewport's adjustment translates the actor by -value. A generic
    // allocation clip consequently moves with it; the viewport clip instead
    // stays at the visible scroll lane. Model both, rather than emitting a
    // button signal for an offscreen card unconditionally.
    const rowIndex = panel._rows.indexOf(entry.button.get_parent());
    const rowHeight = panel._rows[rowIndex].height;
    const contentY = rowIndex * (rowHeight + 8) + entry.card._actor.height / 2;
    const offset = panel._scroll.get_vadjustment().value;
    const viewportY = contentY - offset;
    assert.ok(viewportY >= 0 && viewportY < panel._scroll.height,
        'pointer must land inside the scroll viewport');
    if (panel._content.clip_to_allocation) {
        assert.ok(contentY < panel._scroll.height,
            'allocation clipping incorrectly excludes a scrolled later row');
    }
    assert.ok(panel._panel.y + 7 + viewportY < panel._bridge.y,
        'the bridge cannot intercept a card in the visible scroll lane');
    return cardPointerTarget(entry, entry.card._preview);
}

// Inspect the actual scoped CSS as well as the actor state. The harness cannot
// render Shell themes, but can catch lost contrast, MRU cascade and size shifts.
function cssRules(css) {
    const rules = new Map();
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of selectors.split(','))
            rules.set(selector.trim(), body);
    }
    return rules;
}

function luminance(hex) {
    const rgb = hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

const darkCss = readFileSync(new URL('../stylesheet-dark.css', import.meta.url), 'utf8');
const lightCss = readFileSync(new URL('../stylesheet-light.css', import.meta.url), 'utf8');
const titleSelector = '.window-list-group-preview-button .window-list-group-preview-title';
const cardSelector = '.window-list-group-preview-button .window-list-hover-card';
for (const [theme, css] of [['dark', darkCss], ['light', `${darkCss}\n${lightCss}`]]) {
    const rules = cssRules(css);
    const title = rules.get(titleSelector);
    const foreground = title.match(/(?:^|\s)color:\s*(#[\da-f]{6})/i)[1];
    const background = title.match(/background-color:\s*(#[\da-f]{6})/i)[1];
    const lightness = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    const contrast = (lightness[0] + 0.05) / (lightness[1] + 0.05);
    assert.ok(contrast >= 7, `${theme} title contrast must stay clearly readable`);
    assert.match(rules.get(cardSelector), /background-color:\s*#[\da-f]{6};/i);
    assert.match(rules.get(`${cardSelector}:last-active:hover`), /border-color:\s*-st-accent-color/);
    assert.match(rules.get(`${cardSelector}:last-active:hover`), /box-shadow:.*-st-accent-color/);
    assert.match(rules.get(`${cardSelector}:hover`), /background-color:/);
    assert.match(rules.get(`${cardSelector}:hover`), /border-color:/);
    assert.doesNotMatch(rules.get(`${cardSelector}:hover`),
        /(?:padding|margin|border-width|font-size|height|width|transition):/);
    assert.doesNotMatch(title, /(?:padding|margin|height|font-size|line-height):/);
    console.log(`PASS: ${theme} grouped title solid surface (${contrast.toFixed(1)}:1 contrast), hover without size shift and accent MRU + hover cascade`);
}

function assertGroup(group, windows) {
    const panel = group._groupHoverPanel;
    assert.equal(panel._actor.visible, true);
    assert.equal(panel._actor.allocated, true);
    assert.equal(panel._entries.size, windows.length);
    assert.equal(chrome.has(panel._actor), true);
    assert.ok(panel._actor.x >= workArea.x);
    assert.ok(panel._actor.x + panel._actor.width <= workArea.x + workArea.width);
    assert.ok(panel._actor.y >= workArea.y);
    assert.equal(panel._actor.y + panel._actor.height, group._button.y,
        'the reactive panel bottom touches button top, including the work-area bridge');
    assert.ok(panel._actor.y + panel._panel.height <= workArea.y + workArea.height);
    const contentWidth = panel._content.get_preferred_width(-1)[1];
    const scrollbarGutter = 24;
    assert.equal(panel._scroll.hscrollbar_policy, context.St.PolicyType.NEVER);
    assert.equal(panel._scroll.vscrollbar_policy, context.St.PolicyType.AUTOMATIC);
    assert.equal(panel._scroll.overlay_scrollbars, false);
    assert.equal(panel._scroll.reactive, true);
    assert.deepEqual(panel._scroll.children, [panel._content]);
    assert.equal(panel._content.clip_to_allocation, false);
    assert.equal(panel._content.clip_to_view, true);
    assert.equal(panel._panel.clip_to_allocation, true);
    const referenceColumns = Math.min(3, windows.length);
    const viewportWidth = Math.min(workArea.width - 14,
        referenceColumns * 260 + (referenceColumns - 1) * 8 + 8 + scrollbarGutter);
    assert.equal(panel._scroll.width, viewportWidth);
    if (contentWidth + scrollbarGutter <= workArea.width - 14) {
        assert.ok(panel._rows.every(row => row.get_preferred_width(-1)[1] <=
            panel._scroll.width - 14 - 8),
        'cards leave room for the non-overlay scrollbar plus the content padding');
    }
    const columns = Math.max(1, Math.min(windows.length, Math.floor(
        (viewportWidth - 8 - scrollbarGutter + 8) / (settings.width + 20 + 8))));
    assert.equal(panel._rows.length, Math.ceil(windows.length / columns));
    assert.ok(panel._rows.every(row => row.children.length <= columns));
    const rowHeight = Math.max(...[...panel._entries.values()].map(entry => entry.card._actor.height));
    assert.ok(panel._rows.every(row => row.height === rowHeight));
    const referenceHeight = rowHeight - Math.min(settings.width * 9 / 16, workArea.height / 2) +
        Math.min(240 * 9 / 16, workArea.height / 2);
    const availableHeight = Math.min(group._button.y, workArea.y + workArea.height) - workArea.y;
    assert.equal(panel._scroll.height, Math.min(availableHeight - 14,
        3 * referenceHeight + 2 * 8,
        panel._rows.length * rowHeight + (panel._rows.length - 1) * 8),
    'viewport uses three default row slots and reveals more rows as cards shrink');
    assert.deepEqual(panel._actor.children, [panel._panel, panel._bridge]);
    assert.equal(panel._actor.height, panel._panel.height + panel._bridge.height);
    assert.ok(panel._actor.layout_manager instanceof context.Clutter.FixedLayout);
    assert.equal(panel._actor.clip_to_allocation, true);
    assert.equal(panel._panel.x, 0);
    assert.equal(panel._panel.y, 0);
    assert.equal(panel._bridge.x, 0);
    assert.equal(panel._bridge.y, panel._panel.height,
        'bridge has an explicit allocation below the panel and cannot cover cards');
    assert.equal(panel._bridge.width, panel._actor.width);
    assert.equal(panel._bridge.height,
        Math.max(0, group._button.y - (workArea.y + workArea.height)));
    assert.equal(panel._bridge.clip_to_allocation, true);
    let highlighted = 0;
    for (const window of windows) {
        const entry = panel._entries.get(window);
        const card = entry.card;
        assert.equal(card._window, window);
        assert.equal(card._clone.source, window.source);
        assert.equal(card._preview.width, settings.width);
        assert.equal(card._preview.height,
            Math.min(settings.width * 9 / 16, workArea.height / 2));
        assert.equal(card._title.height, 28);
        assert.equal(card._title.text, window.title);
        assert.equal(card._appName.text, 'App');
        assert.equal(card._title.classes.has('window-list-group-preview-title'), true);
        assert.equal(card._actor.opacity, 255);
        assert.equal(entry.button.opacity, 255);
        assert.equal(entry.button.reactive, true);
        assert.equal(entry.button.track_hover, true);
        for (const leaf of [card._actor, card._appName, card._title, card._preview, card._clone])
            cardPointerTarget(entry, leaf);
        assert.equal(card._actor.get_parent(), entry.button);
        assert.equal(chrome.has(card._actor), false, 'only the panel owns chrome');
        assert.equal(card._actor.pseudos?.has('last-active') ?? false,
            window === group._getLastActiveWindow(group.getWindowList()));
        highlighted += Number(card._actor.pseudos?.has('last-active') ?? false);
    }
    assert.equal(highlighted, 1);
    assert.equal(group.label.destroyed, false);
    assert.equal(panel._rows.reduce((count, row) => count + row.children.length, 0), windows.length);
}

settings.width = 240;
for (const count of [2, 3, 4, 5, 8, 9, 10, 17]) {
    const {group, windows} = makeGroup(count);
    display.mru = [new Signals(), ...windows.toReversed()];
    pickedActor = group._button;
    hover(group, true);
    advanceTime(500);
    settle();
    assertGroup(group, windows);
    const panel = group._groupHoverPanel;
    if (count === 2) {
        for (const window of windows) {
            const individual = new context.Card(group, settings);
            individual.show(window);
            const embedded = panel._entries.get(window).card;
            for (const name of ['_actor', '_preview', '_title', '_appName']) {
                assert.equal(embedded[name].width, individual[name].width);
            }
            assert.ok(embedded._preview.height < individual._preview.height);
            assert.ok(embedded._clone.width <= embedded._preview.width);
            assert.ok(embedded._clone.height <= embedded._preview.height);
            assert.ok(Math.abs(embedded._clone.width / embedded._clone.height -
                window.frame.width / window.frame.height) < 1e-12);
            individual.destroy();
        }
    }
    assert.equal(panel._rows.length, Math.ceil(count / 3));
    if (count > 9) {
        assert.ok(panel._rows.length > 1);
        assert.ok(panel._content.get_preferred_height()[1] > panel._scroll.height);
        const adjustment = panel._scroll.get_vadjustment();
        const maxOffset = panel._content.get_preferred_height()[1] - panel._scroll.height;
        for (const window of windows) {
            const entry = panel._entries.get(window);
            const rowIndex = panel._rows.indexOf(entry.button.get_parent());
            adjustment.value = Math.min(maxOffset, rowIndex * (panel._rows[rowIndex].height + 8));
            assert.equal(scrollPointerTarget(panel, entry), entry.button,
                'every row must become visible and interactive after scrolling');
        }
        adjustment.value = 0;
    }

    // Button leave is delivered before panel enter; picking still preserves it.
    pickedActor = panel._bridge;
    hover(group, false);
    assert.equal(panel._actor.visible, true);
    pickedActor = panel._entries.get(windows[0]).button;
    panel.syncHover();
    assert.equal(panel._actor.visible, true);
    for (const window of windows) {
        const hovered = panel._entries.get(window);
        const size = [hovered.card._actor.width, hovered.card._actor.height];
        hovered.button.hover = true;
        hovered.button.emit('notify::hover');
        assert.equal(hovered.card._actor.pseudos.has('hover'), true);
        assert.equal(panel._entries.get(windows.at(-1)).card._actor.pseudos.has('last-active'), true,
            'MRU persists while any card, including MRU itself, is hovered');
        assert.deepEqual([hovered.card._actor.width, hovered.card._actor.height], size);
        hovered.button.hover = false;
        hovered.button.emit('notify::hover');
        assert.equal(hovered.card._actor.pseudos.has('hover'), false);
    }

    display.mru = [...windows];
    display.emit('notify::focus-window');
    assertGroup(group, windows);
    display.mru = [];
    display.emit('notify::focus-window');
    assertGroup(group, windows); // Exact windows[0] fallback also matches click.

    const clones = [...panel._entries.values()].map(entry => entry.card._clone);
    const adjustment = panel._scroll.get_vadjustment();
    adjustment.value = 100;
    pickedActor = null;
    panel.syncHover();
    assert.equal(panel._actor.visible, true, 'leave must wait for enter/picking to settle');
    expireTimeouts();
    assert.equal(panel._actor.visible, false);
    clones.forEach(clone => assert.equal(clone.destroyed, true));
    assert.equal(adjustment.value, adjustment.lower);
    assert.equal(pending.size, 0);
    pickedActor = group._button;
    hover(group, true);
    advanceTime(500);
    settle();
    for (const [i, target] of windows.entries()) {
        group.showLabel();
        settle();
        const entry = panel._entries.get(target);
        const surfaces = [entry.card._appName, entry.card._title, entry.card._preview, entry.card._clone];
        const before = activations.length;
        cardPointerTarget(entry, surfaces[i % surfaces.length]).emit('clicked');
        assert.equal(activations.length, before + 1);
        assert.equal(activations.at(-1), target);
        assert.equal(panel._actor.visible, false);
        assert.equal(panel._entries.size, 0);
    }
    const ownedActors = [panel._actor, panel._scroll, panel._content, panel._bridge];
    group._destroy();
    ownedActors.forEach(actor => assert.equal(actor.destroyed, true));
    assert.equal(chrome.size, 0);
}
console.log('PASS: 2/3/4/5/8/9/10/17 cards, 3-column/3-row viewport, separate scrollbar lane, reactive surfaces, hover + MRU, gapless bridge and exact activation');

const transition = makeGroup(8);
pickedActor = transition.group._button;
transition.group.showLabel();
settle();
const transitionPanel = transition.group._groupHoverPanel;
transition.group._button.hover = false;
pickedActor = null;
transitionPanel.syncHover();
assert.equal(timeouts.size, 1, 'a transient missing pick schedules one close check');
transitionPanel.syncHover();
assert.equal(timeouts.size, 1, 'repeated leave notifications must coalesce');
const delayedClose = timeouts.get(transitionPanel._hideId);
transitionPanel._actor.hover = true;
transitionPanel._actor.emit('notify::hover');
assert.equal(timeouts.size, 0, 'panel enter cancels the close check');
delayedClose();
assert.equal(transitionPanel._actor.visible, true, 'a cancelled callback cannot close the panel');
transitionPanel._actor.hover = false;

// A scrollbar owns a native stage grab. The cursor may leave the panel during
// a drag; picking there must not destroy the bar or any embedded card.
const scrollbar = new Actor({reactive: true});
transitionPanel._scroll.add_child(scrollbar);
grabActor = scrollbar;
transitionPanel.syncHover();
expireTimeouts();
assert.equal(transitionPanel._actor.visible, true);
const beforeLayoutHideCount = transitionPanel._actor.hideCount;
transitionPanel._queueLayout();
settle();
assert.equal(transitionPanel._actor.hideCount, beforeLayoutHideCount,
    'layout must not unmap a panel while the scrollbar/button owns a grab');
assert.equal(transitionPanel._entries.size, 8);
grabActor = null;
scrollbar.destroy();

// Click a later-row card after scrolling to the bottom, while a leave check
// is pending. The real handler must activate that exact window and cancel it.
transitionPanel.syncHover();
assert.equal(timeouts.size, 1);
const lastEntry = transitionPanel._entries.get(transition.windows.at(-1));
transitionPanel._scroll.get_vadjustment().value =
    transitionPanel._content.get_preferred_height()[1] - transitionPanel._scroll.height;
const beforeLaterRowClick = activations.length;
scrollPointerTarget(transitionPanel, lastEntry).emit('clicked');
assert.equal(activations.length, beforeLaterRowClick + 1);
assert.equal(activations.at(-1), transition.windows.at(-1));
assert.equal(timeouts.size, 0);
assert.equal(transitionPanel._entries.size, 0);
transition.group._button.hover = true;
transition.group.showLabel();
settle();
transition.group._button.hover = false;
transitionPanel.syncHover();
assert.equal(timeouts.size, 1);
transition.group._destroy();
assert.equal(timeouts.size, 0, 'disable must cancel pending hover-close timers');
assert.equal(pending.size, 0);
assert.equal(chrome.size, 0);
console.log('PASS: all later rows remain pickable, delayed enter/click races, stale close callback, scrollbar grab outside panel, mapped relayout and timer cleanup');

assert.equal(modalGrabs.length, 0, 'pointer leave, clicks and disable release all modal grabs');
const restoredFocus = new Actor();
keyFocus = restoredFocus;
for (const result of [null, undefined, false]) {
    const failed = makeGroup(3);
    nextModalResult = result;
    const popsBeforeFailure = modalPopCount;
    failed.group.showLabel();
    const failedPanel = failed.group._groupHoverPanel;
    assert.equal(failedPanel._actor.visible, false,
        'a panel must not stay open when keyboard capture fails');
    assert.equal(failedPanel._entries.size, 0);
    assert.equal(failedPanel._modalGrab, null, 'failed acquisition must leave no stale handle');
    assert.equal(modalGrabs.length, 0);
    assert.equal(modalPopCount, popsBeforeFailure, 'failed acquisition must not pop a missing grab');
    assert.equal(keyFocus, restoredFocus);
    failed.group._destroy();
}
restoredFocus.destroy();
keyFocus = null;
console.log('PASS: falsey modal acquisition hides the panel, preserves focus and leaves no stale handle');

// Exercise the same panel repeatedly, including the usual null Shell key focus
// when the previously focused target is an application rather than a Shell actor.
for (const previousFocus of [new Actor(), null]) {
    keyFocus = previousFocus;
    const cycling = makeGroup(3);
    const pushesBeforeCycles = modalPushCount;
    const popsBeforeCycles = modalPopCount;
    for (let i = 0; i < 6; i++) {
        pickedActor = cycling.group._button;
        hover(cycling.group, true);
        advanceTime(499);
        assert.equal(cycling.group._groupHoverPanel?._actor.visible ?? false, false);
        advanceTime(1);
        settle();
        const cyclingPanel = cycling.group._groupHoverPanel;
        assert.equal(cyclingPanel._modalGrab, modalGrabs.at(-1));
        assert.equal(keyFocus, cyclingPanel._actor);
        const keysBeforeClose = applicationKeys.length;
        const focusedWindow = display.focus_window;
        assert.equal(dispatchKey(context.Clutter.KEY_Escape), true);
        assert.equal(applicationKeys.length, keysBeforeClose, 'ESC cannot reach the application');
        assert.equal(display.focus_window, focusedWindow, 'ESC cannot change the focused application');
        assert.equal(cyclingPanel._actor.visible, false);
        assert.equal(cyclingPanel._modalGrab, null);
        assert.equal(keyFocus, previousFocus);
        assert.equal(modalGrabs.length, 0);
        assert.equal(modalPopCount, popsBeforeCycles + i + 1);
        cyclingPanel.hide();
        assert.equal(modalPopCount, popsBeforeCycles + i + 1, 'repeated hide cannot release twice');
        dispatchKey(65);
        assert.equal(applicationKeys.at(-1), 65, 'application receives input again after ESC');
        hover(cycling.group, false);
    }
    assert.equal(modalPushCount, pushesBeforeCycles + 6);
    cycling.group._destroy();
    assert.equal(modalPopCount, popsBeforeCycles + 6, 'destroy after ESC cannot release twice');
    previousFocus?.destroy();
}
keyFocus = null;
console.log('PASS: repeated open/ESC/open, exact 500ms delay, actor/null focus restoration, application input resumes and handles release once');

// A source button can disappear while a second group is open. Shell owns the
// saved focus chain: removing the older grab must not focus its dying panel.
const focusBeforeGroups = new Actor();
keyFocus = focusBeforeGroups;
const olderGroup = makeGroup(3);
const newerGroup = makeGroup(3);
const popsBeforeGroups = modalPopCount;
olderGroup.group.showLabel();
newerGroup.group.showLabel();
settle();
assert.equal(modalGrabs.length, 2);
assert.equal(keyFocus, newerGroup.group._groupHoverPanel._actor);
olderGroup.group._destroy();
assert.equal(modalPopCount, popsBeforeGroups + 1);
assert.equal(modalGrabs.length, 1);
assert.equal(keyFocus, newerGroup.group._groupHoverPanel._actor,
    'destroying an underlying panel cannot steal focus from the current modal');
assert.equal(dispatchKey(context.Clutter.KEY_Escape), true);
assert.equal(modalPopCount, popsBeforeGroups + 2);
assert.equal(modalGrabs.length, 0);
assert.equal(keyFocus, focusBeforeGroups, 'Shell repairs the saved focus chain on out-of-order close');
newerGroup.group._destroy();
assert.equal(modalPopCount, popsBeforeGroups + 2);
focusBeforeGroups.destroy();
keyFocus = null;
console.log('PASS: switching groups and destroying an underlying open panel preserves current focus and leaks no grabs');

const {group, windows} = makeGroup(8);
display.mru = [...windows.toReversed()];
group.showLabel();
settle();
const panel = group._groupHoverPanel;
const oldCards = [...panel._entries.values()].map(entry => entry.card);
settings.width = 480;
settings.emit('changed::preview-width');
settle();
assertGroup(group, windows);
assert.deepEqual([...panel._entries.values()].map(entry => entry.card), oldCards);
const added = makeGroup(1);
windows.push(added.windows[0]);
added.group._destroy();
group._windowsChanged();
settle();
assertGroup(group, windows);
for (const x of [0, 950]) {
    group._button.x = x;
    group.emit('notify::allocation');
    settle();
    assertGroup(group, windows);
}
group._button.y = 910.5;
group.emit('notify::allocation');
settle();
assertGroup(group, windows);
group._button.y = 850; // Within the work area: panel touches the button without a bridge.
group.emit('notify::allocation');
settle();
assertGroup(group, windows);
assert.equal(panel._bridge.height, 0);
pickedActor = panel._entries.get(windows[0]).button;
hover(group, false);
assert.equal(panel._actor.visible, true);
hover(group, true);
group._button.y = 910;
workArea.width = 300; // Even a monitor narrower than one card keeps card size.
group.emit('notify::allocation');
settle();
assertGroup(group, windows);
assert.ok(panel._content.get_preferred_width()[1] > panel._scroll.width);
workArea.width = 1000;
windows[1].workspace = 1;
windows[1].emit('workspace-changed');
assert.equal(panel._entries.has(windows[1]), false);
windows[2].skip_taskbar = true;
windows[2].emit('notify::skip-taskbar');
assert.equal(panel._entries.has(windows[2]), false);
windows[3].monitor = 1;
group._windowsChanged();
assert.equal(panel._entries.has(windows[3]), false);
const closing = windows[0];
const closingClone = panel._entries.get(closing).card._clone;
closing.emit('unmanaging'); // ShellApp may still contain the unmanaging window.
assert.equal(closingClone.destroyed, true);
assert.equal(panel._entries.has(closing), false);
windows.splice(windows.indexOf(closing), 1);
group._windowsChanged();
settle();
assertGroup(group, group.getWindowList());
windows.splice(0, windows.length, windows.at(-1));
group._windowsChanged();
assert.equal(panel._actor.visible, false);
assert.equal(panel._entries.size, 0);
assert.equal(group._singleWindowMode, true);
group.showLabel();
visible(group, windows[0]);
group._destroy();
assert.equal(chrome.size, 0);
assert.equal(pending.size, 0);
console.log('PASS: live 480px width, edge clamps, narrow-monitor clipping without horizontal scrolling, workspace/monitor/skip filtering, window close and group-to-single cleanup');

// Rapid passes must not map any preview or retain a stale opening callback.
settings.width = 240;
const fastSingle = makeButtons(1)[0];
hover(fastSingle, true);
const staleOpen = timeouts.get(fastSingle._showLabelId);
advanceTime(499);
assert.equal(fastSingle._hoverCard, undefined);
hover(fastSingle, false);
assert.equal(timeouts.size, 0);
hover(fastSingle, true);
const newOpenId = fastSingle._showLabelId;
staleOpen();
assert.equal(fastSingle._showLabelId, newOpenId);
assert.equal(fastSingle._hoverCard, undefined);
advanceTime(500);
visible(fastSingle);
hover(fastSingle, false);
hover(fastSingle, true);
fastSingle._destroy();
assert.equal(timeouts.size, 0, 'disable cancels an opening timer before a card exists');

for (const state of ['unmapped', 'dragging', 'menu']) {
    const guarded = makeButtons(1)[0];
    hover(guarded, true);
    if (state === 'unmapped')
        guarded.mapped = false;
    else if (state === 'dragging')
        guarded._hoverDragging = true;
    else
        guarded._contextMenu = Object.assign(new Signals(), {isOpen: true, destroy() {}});
    advanceTime(500);
    assert.equal(guarded._hoverCard, undefined, `${state} must suppress pending preview`);
    guarded._destroy();
}

const fastGroups = Array.from({length: 4}, () => makeGroup(10));
for (const {group: owner} of fastGroups) {
    pickedActor = owner._button;
    hover(owner, true);
    advanceTime(300);
    hover(owner, false);
    assert.equal(owner._groupHoverPanel, undefined);
}
fastGroups.forEach(({group: owner}) => owner._destroy());
assert.equal(timeouts.size, 0);
console.log('PASS: rapid single/group passes never open previews; stale open callback, unmap/drag/menu guards and pending-open disable cleanup');

const zoomCase = makeGroup(17);
const priorKeyFocus = new Actor();
keyFocus = priorKeyFocus;
pickedActor = zoomCase.group._button;
hover(zoomCase.group, true);
advanceTime(499);
assert.equal(zoomCase.group._groupHoverPanel, undefined);
advanceTime(1);
settle();
const zoomPanel = zoomCase.group._groupHoverPanel;
assertGroup(zoomCase.group, zoomCase.windows);
const initialPanelSize = [zoomPanel._actor.width, zoomPanel._actor.height];
const initialClones = [...zoomPanel._entries.values()].map(entry => entry.card._clone);
const initialHideCount = zoomPanel._actor.hideCount ?? 0;
const initialModalPushCount = modalPushCount;
assert.equal(modalGrabs.length, 1);
assert.equal(keyFocus, zoomPanel._actor, 'opening the panel must focus its keyboard actor');
zoomPanel._scroll.get_vadjustment().value = 30;
for (let i = 0; i < 5; i++) {
    zoomCase.group.showLabel();
    zoomPanel.refresh();
    hover(zoomCase.group, true);
    display.emit('notify::focus-window');
}
settle();
assert.equal(zoomPanel._actor.hideCount ?? 0, initialHideCount,
    'repeat hover/show/refresh must never unmap a visible panel');
assert.equal(zoomPanel._scroll.get_vadjustment().value, 30);
assert.equal(modalPushCount, initialModalPushCount,
    'refreshing a mapped panel must not stack additional modal grabs');

const scrollEvent = (direction, control = true, dy = 0) => ({
    type: () => context.Clutter.EventType.SCROLL,
    get_state: () => control ? context.Clutter.ModifierType.CONTROL_MASK : 0,
    get_scroll_direction: () => context.Clutter.ScrollDirection[direction],
    get_scroll_delta: () => [0, dy],
});
const wheel = (direction, control = true, dy = 0) =>
    zoomPanel._actor.emit('captured-event', scrollEvent(direction, control, dy));
const writesBeforeZoom = settings.writes.length;
assert.equal(wheel('DOWN', false), false, 'ordinary wheel reaches ScrollView');
assert.equal(wheel('LEFT'), false, 'horizontal wheel keeps its native behavior');
assert.equal(settings.writes.length, writesBeforeZoom);
for (let i = 0; i < 4; i++)
    assert.equal(wheel('DOWN'), true, 'Ctrl+wheel is captured before native scrolling');
settle();
assert.equal(settings.width, 160);
assert.equal(settings.writes.at(-1), 160);
assertGroup(zoomCase.group, zoomCase.windows);
assert.equal(zoomPanel._rows[0].children.length, 4);
assert.equal(zoomPanel._rows.length, 5);
assert.deepEqual([zoomPanel._actor.width, zoomPanel._actor.height], initialPanelSize,
    'zoom reveals more cards inside the same viewport');
assert.equal(zoomPanel._scroll.get_vadjustment().value, 30,
    'Ctrl+wheel must not change the ordinary scroll offset');
assert.deepEqual([...zoomPanel._entries.values()].map(entry => entry.card._clone), initialClones);
assert.equal(zoomPanel._actor.hideCount ?? 0, initialHideCount);
const limitWrites = settings.writes.length;
wheel('DOWN');
assert.equal(settings.writes.length, limitWrites, 'no redundant writes at the lower bound');
for (let i = 0; i < 16; i++)
    wheel('UP');
settle();
assert.equal(settings.width, 480);
assertGroup(zoomCase.group, zoomCase.windows);
assert.equal(zoomPanel._rows[0].children.length, 1);
wheel('UP');
assert.equal(settings.writes.length, limitWrites + 16, 'upper bound also avoids redundant writes');
wheel('SMOOTH', true, 0.02);
assert.equal(settings.width, 480);
wheel('SMOOTH', true, 0.02);
assert.equal(settings.width, 480);
wheel('SMOOTH', true, 0.02);
assert.equal(settings.width, 479, 'fractional smooth deltas accumulate rather than getting lost');
settle();

// A new panel reads the persisted width rather than resetting it to the default.
const remembered = makeGroup(10);
pickedActor = remembered.group._button;
remembered.group.showLabel();
settle();
assertGroup(remembered.group, remembered.windows);
assert.equal(remembered.group._groupHoverPanel._entries.values().next().value.card._preview.width, 479);
assert.equal(dispatchKey(context.Clutter.KEY_Escape), true);
assert.equal(remembered.group._groupHoverPanel._actor.visible, false);
assert.equal(zoomPanel._actor.visible, true, 'ESC affects only the focused panel');
assert.equal(zoomCase.group._hoverDismissed ?? false, false);
assert.equal(modalGrabs.length, 1);
remembered.group._destroy();
pickedActor = zoomCase.group._button;

const focusBeforeEscape = display.focus_window;
const activationsBeforeEscape = activations.length;
const keysBeforeEscape = applicationKeys.length;
assert.equal(keyFocus, zoomPanel._actor, 'closing a nested panel restores the underlying panel focus');
assert.equal(dispatchKey(65), false);
// ESC must also be captured when a card has keyboard focus.
keyFocus = zoomPanel._entries.values().next().value.button;
assert.equal(dispatchKey(context.Clutter.KEY_Escape), true);
assert.equal(zoomPanel._actor.visible, false);
assert.equal(zoomPanel._entries.size, 0);
assert.equal(display.focus_window, focusBeforeEscape);
assert.equal(activations.length, activationsBeforeEscape);
assert.equal(applicationKeys.length, keysBeforeEscape,
    'keys while the panel is open must not reach the active application');
assert.equal(modalGrabs.length, 0, 'ESC must release the Shell modal grab');
assert.equal(keyFocus, priorKeyFocus, 'ESC restores the previous Shell keyboard focus');
assert.equal(dispatchKey(65), false);
assert.equal(applicationKeys.at(-1), 65, 'application keyboard input resumes after closing');
hover(zoomCase.group, true);
zoomCase.group.showLabel();
zoomPanel.show();
advanceTime(2000);
assert.equal(zoomPanel._actor.visible, false, 'Escape locks reopening until a new leave/enter cycle');
assert.equal(timeouts.size, 0);
hover(zoomCase.group, false);
hover(zoomCase.group, true);
advanceTime(499);
assert.equal(zoomPanel._actor.visible, false);
advanceTime(1);
settle();
assertGroup(zoomCase.group, zoomCase.windows);
zoomCase.group._destroy();
assert.equal(modalGrabs.length, 0, 'disable with an open panel releases the keyboard grab');
assert.equal(keyFocus, priorKeyFocus);
priorKeyFocus.destroy();
keyFocus = null;
assert.equal(timeouts.size, 0);
assert.equal(pending.size, 0);
assert.equal(chrome.size, 0);
console.log('PASS: exact group delay, mapped refresh without flicker, persistent bounded discrete/smooth zoom, 4-column reflow, unchanged viewport/scroll/clones, Escape lock and delayed re-entry');

const groups = Array.from({length: 8}, () => makeGroup(3));
let previousGroup = null;
for (let i = 0; i < 64; i++) {
    const current = groups[i % groups.length].group;
    pickedActor = current._button;
    if (previousGroup)
        hover(previousGroup, false);
    hover(current, true);
    advanceTime(500);
    assertGroup(current, current.getWindowList());
    previousGroup = current;
}
const rapidPanel = previousGroup._groupHoverPanel;
const stalePanelCallback = pending.get(rapidPanel._laterId);
rapidPanel.hide();
previousGroup.mapped = true;
previousGroup.showLabel();
const currentPanelId = rapidPanel._laterId;
stalePanelCallback();
assert.equal(rapidPanel._laterId, currentPanelId);
assert.equal(pending.has(currentPanelId), true);
previousGroup.mapped = false;
previousGroup.emit('notify::mapped');
assert.equal(previousGroup._groupHoverPanel._entries.size, 0);
groups.forEach(({group: owner}) => owner._destroy());
assert.equal(chrome.size, 0);
assert.equal(pending.size, 0);
console.log('PASS: rapid group changes, owner unmap and disable release all clones/chrome/later callbacks');

const clickCase = makeGroup(3);
display.focus_window = null;
display.mru = clickCase.windows.toReversed();
clickCase.group.showLabel();
const clickTarget = clickCase.group._getLastActiveWindow(clickCase.group.getWindowList());
clickCase.group._onClicked(null, 1);
assert.equal(activations.at(-1), clickTarget);
assert.equal(clickCase.group._menu.isOpen, false);
display.focus_window = clickCase.windows[0];
clickCase.group._onClicked(null, 1);
const menu = clickCase.group._menu;
menu.actor.x = 0;
assert.equal(menu.isOpen, true);
assert.equal(menu.items.length, 3);
const beforeListClick = activations.length;
clickCase.group._onMenuActivate(menu, menu.items[1]);
assert.equal(activations.length, beforeListClick + 1);
assert.equal(activations.at(-1), clickCase.windows[1]);

menu.items[0]._window.title = 'Short';
menu.items[1]._window.title = 'Long window title '.repeat(30);
for (const item of menu.items) {
    item.hover = true;
    item.emit('notify::hover');
    visible(item, item._window);
    assert.ok(item._hoverCard._actor.x >= menu.actor.x + menu.actor.width,
        'card is next to the menu at the hovered item');
    assert.equal(item._hoverCard._preview.width, settings.width);
    item.hover = false;
    item.emit('notify::hover');
    assert.equal(item._hoverCard._window, null);
    assert.equal(item._hoverCard._clone, null);
}
menu.actor.x = 800;
// A new enter before the old leave must still remove the old preview immediately.
menu.items[1].hover = true;
menu.items[1].emit('notify::hover');
menu.items[0].hover = true;
menu.items[0].emit('notify::hover');
assert.equal(menu.items[1]._hoverCard._window, null);
assert.equal(menu._windowPreviewItem, menu.items[0]);
menu.items[1].hover = false;
menu.items[1].emit('notify::hover');
assert.equal(menu._windowPreviewItem, menu.items[0]);
assert.ok(menu.items[0]._hoverCard._actor.x + menu.items[0]._hoverCard._actor.width <= menu.actor.x);
menu.close();
assert.equal(menu._windowPreviewItem, null);
menu.items.forEach(item => assert.equal(item._hoverCard._window, null));
menu.open();
menu.items[0]._window.emit('unmanaging');
assert.equal(menu.items[0]._hoverCard._window, null);
menu.items[0].emit('notify::allocation');
assert.equal(menu.items[0]._hoverCard._window, null, 'a closing item cannot resurrect its card');
menu.close();
clickCase.group._onClicked(null, 3);
assert.equal(clickCase.group._contextMenu.isOpen, true);
clickCase.group._contextMenu.close();
menu.open();
menu.items[2].hover = true;
menu.items[2].emit('notify::hover');
const popupCloneOnDisable = menu.items[2]._hoverCard._clone;
clickCase.group._destroy();
assert.equal(popupCloneOnDisable.destroyed, true);
assert.equal(chrome.size, 0);
assert.equal(pending.size, 0);
console.log('PASS: unchanged MRU click/popup/list activation/context-menu branches; every short/long item, left/right adjacency, leave/close/unmanaging cleanup');

const single = makeGroup(1);
display.focus_window = single.windows[0];
single.group._onClicked(null, 1);
assert.equal(single.windows[0].minimized, true);
display.focus_window = null;
single.group._onClicked(null, 1);
assert.equal(activations.at(-1), single.windows[0]);
single.group._destroy();
for (const emitter of emitters) {
    assert.equal(emitter.signals.some(signal => signal.owner?.destroyed), false,
        'destroyed owners leave no signal connections');
}
assert.equal(timeouts.size, 0, 'all grouped hover-close timers are released');
assert.equal(modalGrabs.length, 0, 'all grouped modal grabs are released');
assert.equal(modalPopCount, modalPushCount, 'every acquired opaque handle was released exactly once');
console.log('PASS: unchanged single-window minimize/activate and no destroyed-owner signal leaks');

// Exercise the real workspace-menu cleanup against the distinction in Shell's
// signalTracker: Clutter actors auto-disconnect; plain JS menus do not.
const workspaceSource = readFileSync(new URL('../workspaceIndicator.js', import.meta.url), 'utf8');
const workspaceSignals = new Signals();
Object.assign(workspaceSignals, {
    nWorkspaces: 0,
    get_active_workspace_index: () => 0,
});
context.global.workspace_manager = context.global.workspaceManager = workspaceSignals;
emitters.push(workspaceSignals);
const desktopSettings = [];
context.Gio = {Settings: class extends Signals {
    constructor() {
        super();
        desktopSettings.push(this);
        emitters.push(this);
    }
}};
context.PopupMenu.PopupMenu = class extends Menu {
    addAction(_label, callback) {
        this.preferencesAction = callback;
        const item = new Actor();
        this.addMenuItem(item);
        return item;
    }
};
context.PopupMenu.PopupMenuSection = class {
    constructor() { this.box = this.actor = new Actor(); }
    destroy() { this.actor.destroy(); }
};
context.PopupMenu.PopupSeparatorMenuItem = Actor;
context.St.ScrollView = class extends ScrollView {
    constructor(properties) {
        super(properties);
        if (properties.child)
            this.set_child(properties.child);
    }
};
context.St.Side = {TOP: 0};
context.baseStyleClassName = 'window-list-workspace-indicator';
context.Meta.prefs_get_workspace_name = () => 'Workspace';
vm.runInContext(workspaceSource.slice(workspaceSource.indexOf('class WorkspacesMenu '),
    workspaceSource.indexOf('export class WorkspaceIndicator ')) +
    '\nthis.WorkspacesMenu = WorkspacesMenu;', context);
let preferencesOpened = 0;
for (let i = 0; i < 8; i++) {
    const menu = new context.WorkspacesMenu(new Actor(), () => preferencesOpened++);
    const settingsEmitter = desktopSettings.at(-1);
    const menuActor = menu.actor;
    menu.preferencesAction();
    settingsEmitter.emit('changed::workspace-names');
    assert.equal(settingsEmitter.signals.length, 1);
    assert.equal(workspaceSignals.signals.length, 2);
    menu.destroy();
    assert.equal(menuActor.destroyed, true);
    assert.equal(menu._desktopSettings, null);
    assert.equal(menu._workspacesSection, null);
    assert.equal(settingsEmitter.signals.length, 0);
    assert.equal(workspaceSignals.signals.length, 0);
    // These would call methods on destroyed section actors in the old code.
    settingsEmitter.emit('changed::workspace-names');
    workspaceSignals.emit('notify::n-workspaces');
    workspaceSignals.emit('workspace-switched');
}
assert.equal(preferencesOpened, 8, 'Settings action uses the injected callback');
console.log('PASS: eight workspace-menu lifetimes release settings/workspace signals and references; Settings action stays functional');
