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

    emit(name) {
        for (const signal of [...this.signals]) {
            if (signal.name === name)
                signal.callback();
        }
    }
}

class Actor extends Signals {
    constructor(properties = {}) {
        super();
        Object.assign(this, {visible: true, mapped: true, allocated: true,
            opacity: 255, children: [], parent: null, destroyed: false}, properties);
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
    set_child_above_sibling(child) { assert.equal(child.parent, this); }
    show() { assert.equal(this.destroyed, false); this.visible = true; }
    hide() { assert.equal(this.destroyed, false); this.visible = false; }
    set(properties) { Object.assign(this, properties); }
    set_size(width, height) { Object.assign(this, {width, height}); }
    set_position(x, y) { Object.assign(this, {x, y}); }
    get_size() { return [this.width, this.height]; }
    has_allocation() { return this.allocated; }
    get_transformed_position() { return [this.x ?? 0, this.y ?? 900]; }
    get_transformed_size() { return [100, 40]; }
    get_preferred_width() {
        return [0, Math.max(...this.children.map(child => child.width ?? 0)) + 20];
    }
    get_preferred_height() {
        const children = this.children.filter(child => child.visible);
        return [0, children.reduce((height, child) => height + (child.height ?? 14), 20) +
            8 * Math.max(0, children.length - 1)];
    }
    allocate() { this.allocated = true; }

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

class DashItemContainer extends Actor {
    hideLabel() { this.shellLabelVisible = false; }
    showLabel() { this.shellLabelVisible = true; }
}

const settings = new Signals();
settings.width = 240;
settings.get_int = () => settings.width;
emitters.push(settings);
const context = vm.createContext({
    St: {BoxLayout: Actor, Label: Actor, Bin: Actor},
    Clutter: {
        Orientation: {VERTICAL: 1}, ActorAlign: {CENTER: 1},
        Clone: class extends Actor {
            constructor(properties) {
                if (properties.source.cloneUnavailable)
                    throw new Error('Source cannot currently be cloned');
                super(properties);
            }
        },
        ActorBox: class { set_origin() {} set_size() {} },
    },
    Pango: {EllipsizeMode: {END: 1}, WrapMode: {WORD_CHAR: 1}, SCALE: 1},
    Main: {layoutManager: {
        addChrome(actor) { assert.equal(chrome.has(actor), false); chrome.add(actor); uiGroup.add_child(actor); },
        removeChrome(actor) { assert.equal(chrome.delete(actor), true); },
        findIndexForActor: button => button.monitorAvailable === false ? -1 : 0,
        getWorkAreaForMonitor: () => ({x: 0, y: 0, width: 1920, height: 1000}),
    }},
    Shell: {WindowTracker: {get_default: () => ({get_window_app: () => ({get_name: () => 'App'})})}},
    Meta: {LaterType: {BEFORE_REDRAW: 1}},
    GLib: {SOURCE_REMOVE: false},
    GObject: {
        registerClass() {}, TypeFlags: {ABSTRACT: 1},
        ParamSpec: {boolean() {}}, ParamFlags: {READWRITE: 1},
    },
    DashItemContainer,
    Extension: {lookupByURL: () => ({getSettings: () => settings})},
    _: text => text,
    global: {compositor: {get_laters: () => laters}},
});
const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
const classes = source.slice(source.indexOf('class WindowHoverCard {'), source.indexOf('class AppContextMenu '));
vm.runInContext(`${classes.replaceAll('import.meta.url', "'mock-extension'")}\nthis.Button = WindowButton;`, context);
const hoverConnection = source.match(/this\._button\.connect\('notify::hover', \(\) => \{[\s\S]*?\n        \}\);/)[0];
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
            _monitorIndex: 0, label: new Actor()});
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
    assert.equal(button.label.destroyed, false, 'Shell label lifecycle must remain separate');
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
        visible(button); // No redraw, allocation, activation or taskbar exit.
        assert.equal(button.metaWindow.activated, false);
        assert.equal(pending.size, 1, 'only the current owner needs one refresh');
        previousButton = button;
    }
    redraw();
    visible(previousButton);
}
hover(previousButton, false);
console.log('PASS: immediate A–H, H–A, returns and 256 rapid random hovers without activation or taskbar exit');

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
        button._onDestroy();
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
buttons[0]._onDestroy();
assert.equal(otherClone.destroyed, false);
visible(buttons[1]);
assert.equal(buttons[1].metaWindow.source.destroyed, false);
buttons[1].mapped = false;
buttons[1].emit('notify::mapped');
assert.equal(buttons[1]._hoverCard._window, null);
assert.equal(buttons[1]._hoverCard._actor.destroyed, false);
for (const button of buttons)
    button._onDestroy();
assert.equal(chrome.size, 0);
assert.equal(pending.size, 0);
console.log('PASS: source sharing does not share clones or cleanup; unmap and disable release owned resources');
