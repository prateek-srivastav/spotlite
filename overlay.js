// The Spotlite window: a search panel near the top of the current monitor and,
// on Space, a Quick Look card in the middle. It covers the monitor and holds a
// modal grab while open, so a click anywhere outside the panel closes it.

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Animation from "resource:///org/gnome/shell/ui/animation.js";
import { ensureActorVisibleInScrollView } from "resource:///org/gnome/shell/misc/animationUtils.js";

import { Glass } from "./glass.js";
import { GROUP_ORDER, parse } from "./search.js";

const PANEL_TOP = 0.18; // fraction of the monitor's height
const CARD_MAX_HEIGHT = 0.8;
const OPEN_MS = 130;
const CARD_MS = 160;
const CARD_EXTRA_OPACITY = 0.08;
const SLOW_ORDER = ["weather", "answer", "dictionary", "wikipedia", "files"];
const ENTER_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];
const MODIFIER_KEYS = [Clutter.KEY_Control_L, Clutter.KEY_Control_R, Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
  Clutter.KEY_Alt_L, Clutter.KEY_Alt_R, Clutter.KEY_Super_L, Clutter.KEY_Super_R, Clutter.KEY_ISO_Level3_Shift];

function wrappingLabel(text, styleClass) {
  const label = new St.Label({ text, style_class: styleClass, x_expand: true });
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  return label;
}

// card text: selectable with the mouse, copied with Ctrl+C (see the key handler)
function cardLabel(text, styleClass) {
  const label = wrappingLabel(text, styleClass);
  label.clutter_text.reactive = true;
  label.clutter_text.selectable = true;
  label.clutter_text.editable = false;
  return label;
}

export const Overlay = GObject.registerClass(
class SpotliteOverlay extends St.Widget {
  constructor(searcher, settings) {
    // not reactive and not modal: only the panel and the card take the pointer, so the
    // windows underneath keep scrolling and clicking; Spotlite holds just the keyboard
    super({ style_class: "spotlite-overlay", reactive: false, visible: false });
    this._searcher = searcher;
    this._settings = settings;
    this._drag = null;           // while the bar or the card is being moved: which, and where the press started
    this._isOpen = false;
    this._gen = 0;               // bumped per keystroke; late results for older text are dropped
    this._cancellable = new Gio.Cancellable();
    this._timers = new Map();    // slow source name -> GLib timeout id
    this._pending = new Set();
    this._query = parse("");
    this._instant = [];
    this._slow = new Map();      // slow source name -> results
    this._rows = [];
    this._selected = -1;
    this._navigated = false;     // Up/Down pressed since the last keystroke: Space previews
    this._selectedKey = null;
    this._card = null;
    this._cardFrame = null;      // the card plus its frosted glass, placed together
    this._cardResult = null;
    this._images = new Map();    // image URL -> Promise<Gio.File>

    this._buildPanel();

    // while dragging, the grab sends motion and release here even off the panel
    this.connect("destroy", () => this._onDestroy());

    Main.layoutManager.modalDialogGroup.add_child(this);
  }

  _buildPanel() {
    this._panel = new St.BoxLayout({
      style_class: "spotlite-panel", orientation: Clutter.Orientation.VERTICAL, reactive: true,
    });
    // frosted glass under the panel, sharing its box; the frame is what gets placed
    this._glass = new Glass({ radius: 18 });
    this._frame = new St.Widget({ layout_manager: new Clutter.BinLayout() });
    // centred until the user drags it somewhere (then _placeFrame positions it)
    this._centre = new Clutter.AlignConstraint({ source: this, align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5 });
    this._frame.add_constraint(this._centre);
    this._frame.add_child(this._glass);
    this._frame.add_child(this._panel);
    this._frame.connect("notify::allocation", () => this._glass.sync());
    this._panel.connect("button-press-event", (_a, event) =>
      this._onFramePress(event, this._panel, this._frame, "panel-position"));
    this.add_child(this._frame);

    const searchRow = new St.BoxLayout({ style_class: "spotlite-search-row" });
    searchRow.add_child(new St.Icon({
      icon_name: "edit-find-symbolic", style_class: "spotlite-search-icon", y_align: Clutter.ActorAlign.CENTER,
    }));
    this._entry = new St.Entry({
      style_class: "spotlite-entry", hint_text: "Spotlite Search", can_focus: true,
      x_expand: true, y_align: Clutter.ActorAlign.CENTER,
      // inline, because inline style beats every stylesheet: GNOME's focus ring is
      // !important, and extensions like Blur my Shell reload the theme in an order
      // that lets it win over layout.css
      style: "background-color: transparent; box-shadow: none; border-width: 0;",
    });
    this._entry.clutter_text.connect("text-changed", () => this._onTextChanged());
    this._entry.clutter_text.connect("key-press-event", (_actor, event) => this._onKeyPress(event));
    searchRow.add_child(this._entry);
    this._spinner = new Animation.Spinner(16, { hideOnStop: true });
    this._spinner.y_align = Clutter.ActorAlign.CENTER;
    searchRow.add_child(this._spinner);
    this._panel.add_child(searchRow);

    this._separator = new St.Widget({ style_class: "spotlite-separator", visible: false });
    this._panel.add_child(this._separator);
    this._list = new St.BoxLayout({ style_class: "spotlite-results", orientation: Clutter.Orientation.VERTICAL });
    this._scroll = new St.ScrollView({
      style_class: "spotlite-scroll", child: this._list, visible: false,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
      overlay_scrollbars: true,
    });
    this._panel.add_child(this._scroll);
  }

  get isOpen() {
    return this._isOpen;
  }

  // The panel and card tint over the frosted glass, from the Transparency setting; inline,
  // so it follows the setting without reloading the stylesheet. The card stays a little
  // more solid, since it is for reading.
  _tint(actor, extra = 0) {
    const alpha = Math.min(1, 1 - this._settings.get_int("transparency") / 100 + extra);
    const [r, g, b] = Main.getStyleVariant() === "light" ? [248, 248, 250] : [30, 30, 34];
    actor.style = `background-color: rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)});`;
  }

  _applyTint() {
    this._tint(this._panel);
    if (this._card)
      this._tint(this._card, CARD_EXTRA_OPACITY);
  }

  // Every event on screen while open passes here first (the stage's captured-event), and
  // goes on: a press outside the card closes it; outside the panel too, Spotlite, while the
  // click still reaches whatever was clicked, as on macOS.
  _onCapturedEvent(event) {
    const type = event.type();
    // a drag in progress: the pressed button keeps sending the pointer's moves our way, and
    // they are taken here, before text under the pointer could take them to select
    if (this._drag && (type === Clutter.EventType.MOTION || type === Clutter.EventType.BUTTON_RELEASE)) {
      if (type === Clutter.EventType.MOTION)
        this._dragTo(event);
      else
        this._endDrag();
      return Clutter.EVENT_STOP;
    }
    if (type === Clutter.EventType.KEY_PRESS)
      return this._onCardKey(event);
    if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
      return Clutter.EVENT_PROPAGATE;
    const target = global.stage.get_event_actor(event);
    const inside = actor => actor !== null && (target === actor || actor.contains(target));
    if (this._card && inside(this._card))
      return Clutter.EVENT_PROPAGATE;
    if (inside(this._panel))
      this._closeCard();
    else
      this.close();
    return Clutter.EVENT_PROPAGATE;
  }

  _dragTo(event) {
    const [x, y] = event.get_coords();
    const d = this._drag;
    if (!d.moved && Math.hypot(x - d.x, y - d.y) < 4)
      return; // a click, not yet a drag
    d.moved = true;
    this.set_cursor_type(Clutter.CursorType.MOVE);
    if (d.frame === this._frame)
      this._placeFrame(d.frameX + x - d.x, d.frameY + y - d.y);
    else
      this._placeCard(d.frameX + x - d.x, d.frameY + y - d.y);
  }

  _endDrag() {
    const { frame, key, moved } = this._drag;
    this._drag = null;
    this.set_cursor_type(Clutter.CursorType.DEFAULT);
    if (moved && frame.get_stage()) {
      // remembered as fractions of the screen, so it lands in the same spot on any monitor
      const centre = (frame.x + frame.width / 2) / this.width;
      this._settings.set_value(key, new GLib.Variant("ad", [centre, frame.y / this.height]));
    }
    this._entry.grab_key_focus();
  }

  // A press that reached the panel or the card itself: on its frame, start moving it (macOS
  // moves Spotlight and Quick Look the same way).
  _onFramePress(event, root, frame, key) {
    if (event.type() !== Clutter.EventType.BUTTON_PRESS || !this._isDragHandle(global.stage.get_event_actor(event), root))
      return Clutter.EVENT_PROPAGATE;
    const [x, y] = event.get_coords();
    // where it really is: while centred, frame.x still holds an old fixed position
    const box = frame.get_allocation_box();
    this._drag = { frame, key, x, y, frameX: box.x1, frameY: box.y1, moved: false };
    return Clutter.EVENT_STOP;
  }

  // Keys while card text has the focus (after selecting some): Ctrl+C copies the selection,
  // anything else goes back to the search, a typed letter included.
  _onCardKey(event) {
    const focus = global.stage.get_key_focus();
    if (!(focus instanceof Clutter.Text) || focus === this._entry.clutter_text || !this.contains(focus))
      return Clutter.EVENT_PROPAGATE;
    const key = event.get_key_symbol();
    if (MODIFIER_KEYS.includes(key))
      return Clutter.EVENT_PROPAGATE; // Ctrl on its own: wait for the key it goes with
    if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) && (key === Clutter.KEY_c || key === Clutter.KEY_C)) {
      const selected = focus.get_selection();
      if (selected)
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selected);
      return Clutter.EVENT_STOP;
    }
    this._entry.grab_key_focus();
    if (this._onKeyPress(event) === Clutter.EVENT_STOP)
      return Clutter.EVENT_STOP;
    const char = Clutter.keysym_to_unicode(key);
    if (char && !(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
      this._entry.clutter_text.insert_unichar(String.fromCodePoint(char));
    return Clutter.EVENT_STOP;
  }

  // keyboard focus moved somewhere else (another window, the overview): close, like macOS
  _onKeyFocusChanged() {
    const focus = global.stage.get_key_focus();
    if (!this._drag && (focus === null || !this.contains(focus)))
      this.close();
  }

  // a frame to drag by: padding, the search icon, headings, the card's body; not the
  // search text, a result, a button or a scroll bar
  _isDragHandle(target, root) {
    for (let a = target; a && a !== root; a = a.get_parent()) {
      if (a === this._entry || a instanceof St.Button || a instanceof St.ScrollBar ||
          (a instanceof Clutter.Text && a.selectable)) // dragging on text selects it
        return false;
    }
    return true;
  }

  // move the panel, kept fully on the monitor (its height changes with the results)
  _placeFrame(x, y) {
    const [, width] = this._frame.get_preferred_width(-1);
    this._centre.enabled = false;
    this._frame.set_position(
      Math.round(Math.max(0, Math.min(x, this.width - width))),
      Math.round(Math.max(0, Math.min(y, this.height - 120))));
    this._fitResults(this._frame.y);
  }

  // move the Quick Look card, kept fully on the monitor
  _placeCard(x, y) {
    const [, width] = this._cardFrame.get_preferred_width(-1);
    const [, height] = this._cardFrame.get_preferred_height(width);
    this._cardCentre.enabled = false;
    this._cardFrame.set_position(
      Math.round(Math.max(0, Math.min(x, this.width - width))),
      Math.round(Math.max(0, Math.min(y, this.height - height))));
  }

  // the results list scrolls rather than run off the bottom of the screen when the bar sits low
  _fitResults(top) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const room = Math.floor((this.height - top) / scale) - 100; // the search row and a margin
    this._scroll.style = `max-height: ${Math.max(120, Math.min(480, room))}px;`;
  }

  // ------------------------------------------------------------ open / close

  open() {
    if (this._isOpen)
      return;
    this._isOpen = true;
    const monitor = Main.layoutManager.currentMonitor;
    this.set_position(monitor.x, monitor.y);
    this.set_size(monitor.width, monitor.height);
    const saved = this._settings.get_value("panel-position").deep_unpack();
    if (saved.length === 2) {
      const [, width] = this._frame.get_preferred_width(-1);
      this._placeFrame(saved[0] * monitor.width - width / 2, saved[1] * monitor.height);
    } else {
      // centring adds to the fixed position, so clear the one a drag left behind
      this._frame.x = 0;
      this._centre.enabled = true;
      this._frame.y = Math.round(monitor.height * PANEL_TOP);
      this._fitResults(this._frame.y);
    }
    this._cardMaxHeight = Math.round(monitor.height * CARD_MAX_HEIGHT);

    this._navigated = false;
    this.remove_all_transitions();
    this.visible = true;
    this.opacity = 0;
    this._frame.set_pivot_point(0.5, 0.5);
    this._frame.set_scale(0.96, 0.96);
    this.ease({ opacity: 255, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    this._frame.ease({ scale_x: 1, scale_y: 1, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    this._applyTint();
    this._entry.grab_key_focus();
    this._entry.clutter_text.set_selection(0, -1); // like Spotlight, the last query comes back selected
    global.stage.connectObject(
      "captured-event", (_stage, event) => this._onCapturedEvent(event),
      "notify::key-focus", () => this._onKeyFocusChanged(), this);
    this._settings.connectObject("changed::transparency", () => this._applyTint(), this);
    global.display.connectObject("notify::focus-window", () => {
      if (global.display.focus_window)
        this.close(); // Alt+Tab or a click gave a window the focus
    }, this);
  }

  close() {
    if (!this._isOpen)
      return;
    this._isOpen = false;
    this._closeCard();
    this._stopWatching();
    // give the keyboard back to the window that had it
    const focus = global.stage.get_key_focus();
    if (focus && this.contains(focus))
      global.stage.set_key_focus(null);
    this.ease({
      opacity: 0, duration: OPEN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        if (!this._isOpen)
          this.visible = false;
      },
    });
  }

  _stopWatching() {
    global.stage.disconnectObject(this);
    global.display.disconnectObject(this);
    this._settings.disconnectObject(this);
    this._drag = null;
  }

  toggle() {
    if (this._isOpen)
      this.close();
    else
      this.open();
  }

  // ------------------------------------------------------------ searching

  _onTextChanged() {
    // "taj " and "taj  mahal " ask the same as "taj" and "taj mahal": keep the results
    const typed = this._entry.get_text().trim().replace(/\s+/g, " ");
    if (typed === this._typed)
      return;
    this._typed = typed;
    this._navigated = false;
    this._selectedKey = null;
    this._closeCard();
    this._cancelSlow();
    const gen = ++this._gen;
    const cancellable = this._cancellable;
    this._query = parse(typed);
    this._instant = this._query.text ? this._searcher.instant(this._query) : [];
    this._slow = new Map();

    for (const source of this._query.text ? this._searcher.slow(this._query) : []) {
      this._pending.add(source.name);
      this._timers.set(source.name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, source.delay, () => {
        this._timers.delete(source.name);
        this._spinner.play();
        source.run(cancellable)
          .then(results => this._deliver(gen, source.name, results))
          .catch(e => {
            if (!cancellable.is_cancelled())
              console.warn(`Spotlite: ${source.name} search failed: ${e.message}`);
            this._deliver(gen, source.name, []);
          });
        return GLib.SOURCE_REMOVE;
      }));
    }
    this._updateSpinner();
    this._render();
  }

  _cancelSlow() {
    for (const id of this._timers.values())
      GLib.source_remove(id);
    this._timers.clear();
    this._pending.clear();
    this._cancellable.cancel();
    this._cancellable = new Gio.Cancellable();
  }

  _deliver(gen, name, results) {
    if (gen !== this._gen || this._destroyed)
      return;
    this._slow.set(name, results);
    this._pending.delete(name);
    this._updateSpinner();
    this._render();
  }

  _updateSpinner() {
    if (this._pending.size === 0)
      this._spinner.stop();
  }

  // The answer worth showing large at the top, like Spotlight's Top Hit, or null.
  // A strong app match or a prefixed engine ("yt …") already leads, so it wins.
  _topHit(all) {
    const direct = all.find(r => r.answer); // weather or a fact: the answer to a question beats an app
    if (direct)
      return direct;
    if (all.some(r => r.group === "Top Hit"))
      return null;
    const definition = all.find(r => r.group === "Definition");
    const article = all.find(r => r.group === "Wikipedia" && r.goodMatch);
    if (this._query.mode === "define" || definition?.source === "dictionaryapi")
      return definition ?? article ?? null; // an everyday word: its meaning first
    return article ?? null;                // a place, person or thing: its article
  }

  _results() {
    let all = [...this._instant, ...SLOW_ORDER.flatMap(name => this._slow.get(name) ?? [])];
    const top = this._topHit(all);
    if (top) {
      // an app that had the top spot ("weather" -> the Weather app) moves down to Applications
      all = all.filter(r => r !== top).map(r => r.group === "Top Hit" && r.app ? { ...r, group: "Applications" } : r);
      all = [{ ...top, group: "Top Hit", large: true }, ...all];
    }
    const order = [...GROUP_ORDER];
    if (this._query.mode === "define") {
      order.splice(order.indexOf("Definition"), 1);
      order.unshift("Definition");
    }
    // stable sort: each source keeps its own ranking inside its group
    return all.map((result, i) => [result, i])
      .sort(([a, i], [b, j]) => order.indexOf(a.group) - order.indexOf(b.group) || i - j)
      .map(([result]) => result);
  }

  _render() {
    this._list.destroy_all_children();
    this._rows = [];
    this._selected = -1;
    const results = this._results();
    // a misspelling was corrected for the leading result: say what was searched instead
    const fix = results[0]?.fix;
    if (fix) {
      const corrected = this._query.text.replace(new RegExp(fix[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), fix[1]);
      this._list.add_child(new St.Label({ text: `Showing results for “${corrected}”`, style_class: "spotlite-corrected" }));
    }
    let group = null;
    for (const result of results) {
      if (result.group !== group) {
        group = result.group;
        this._list.add_child(new St.Label({ text: group.toUpperCase(), style_class: "spotlite-group" }));
      }
      const row = this._makeRow(result);
      this._list.add_child(row);
      this._rows.push(row);
    }
    const any = results.length > 0;
    this._separator.visible = this._scroll.visible = any;
    if (!any)
      return;
    const kept = this._navigated ? results.findIndex(r => r.key === this._selectedKey) : -1;
    this._select(Math.max(kept, 0));
  }

  _makeRow(result) {
    if (result.large && result.rich)
      return this._makeTopHitRow(result);
    const box = new St.BoxLayout({ style_class: "spotlite-row-box", x_expand: true });
    const icon = new St.Icon({
      gicon: result.icon ?? Gio.ThemedIcon.new("system-search-symbolic"),
      icon_size: 32, style_class: "spotlite-row-icon", y_align: Clutter.ActorAlign.CENTER,
    });
    if (result.thumb)
      this._withImage(result.thumb, icon, file => (icon.gicon = Gio.FileIcon.new(file)));
    box.add_child(icon);

    const text = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
    });
    text.add_child(new St.Label({ text: result.title, style_class: "spotlite-row-title" }));
    if (result.subtitle)
      text.add_child(new St.Label({ text: result.subtitle, style_class: "spotlite-row-subtitle" }));
    box.add_child(text);

    const row = new St.Button({ style_class: "spotlite-row", child: box, x_expand: true, can_focus: false });
    row.connect("clicked", () => this._activate(result));
    row._spotliteResult = result;
    return row;
  }

  // The large first row: picture, big title, and the answer itself (the article's
  // opening lines, or the first meanings of a word) without opening anything.
  _makeTopHitRow(result) {
    const box = new St.BoxLayout({ style_class: "spotlite-top-box", x_expand: true });
    const image = new St.Icon({
      gicon: result.icon ?? Gio.ThemedIcon.new("system-search-symbolic"),
      icon_size: 72, style_class: "spotlite-top-image", y_align: Clutter.ActorAlign.START,
    });
    if (result.thumb)
      this._withImage(result.thumb, image, file => (image.gicon = Gio.FileIcon.new(file)));
    box.add_child(image);

    const text = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    // a sentence from an article wraps; a short fact is one big line
    text.add_child(result.rich.sentence
      ? wrappingLabel(result.title, "spotlite-top-sentence")
      : new St.Label({ text: result.title, style_class: "spotlite-top-title" }));
    if (result.rich.subtitle)
      text.add_child(new St.Label({ text: result.rich.subtitle, style_class: "spotlite-top-subtitle" }));
    if (result.rich.text)
      text.add_child(wrappingLabel(result.rich.text, "spotlite-top-text"));
    box.add_child(text);

    const row = new St.Button({ style_class: "spotlite-row spotlite-top", child: box, x_expand: true, can_focus: false });
    row.connect("clicked", () => this._activate(result));
    row._spotliteResult = result;
    return row;
  }

  // Download (or reuse) an image, then hand the file to `use` if `actor` still exists.
  _withImage(url, actor, use) {
    if (!this._images.has(url))
      this._images.set(url, this._searcher.net.cachedFile(url, null));
    let alive = true;
    actor.connect("destroy", () => (alive = false));
    this._images.get(url)
      .then(file => alive && file && use(file))
      .catch(e => {
        this._images.delete(url);
        console.warn(`Spotlite: image ${url}: ${e.message}`);
      });
  }

  // ------------------------------------------------------------ selection and keys

  _select(index) {
    if (!this._rows.length)
      return;
    index = Math.max(0, Math.min(index, this._rows.length - 1));
    this._rows[this._selected]?.remove_style_pseudo_class("selected");
    this._selected = index;
    const row = this._rows[index];
    // highlighted only once the arrow keys are used: a highlight while typing looked like
    // a selection Space would preview, but Space only previews after ↑/↓ (Enter still
    // opens the first result either way)
    if (this._navigated)
      row.add_style_pseudo_class("selected");
    ensureActorVisibleInScrollView(this._scroll, row);
  }

  get _selectedResult() {
    return this._rows[this._selected]?._spotliteResult ?? null;
  }

  _move(step) {
    if (!this._rows.length)
      return;
    this._navigated = true;
    this._select(this._selected + step);
    this._selectedKey = this._selectedResult.key;
    if (this._card)
      this._showCard(this._selectedResult); // Quick Look follows the selection
  }

  _onKeyPress(event) {
    const key = event.get_key_symbol();
    const state = event.get_state();
    const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
    const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

    if (key === Clutter.KEY_Escape) {
      if (this._card)
        this._closeCard();
      else if (this._entry.get_text())
        this._entry.set_text("");
      else
        this.close();
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
      this._move(key === Clutter.KEY_Down ? 1 : -1);
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Page_Down || key === Clutter.KEY_Page_Up) {
      this._move(key === Clutter.KEY_Page_Down ? 5 : -5);
      return Clutter.EVENT_STOP;
    }
    if (ENTER_KEYS.includes(key)) {
      this._activate(this._cardResult ?? this._selectedResult);
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_space && !ctrl) {
      if (this._card) {
        this._closeCard();
        return Clutter.EVENT_STOP;
      }
      const result = this._selectedResult;
      if (result?.preview && (this._navigated || shift)) {
        this._showCard(result);
        return Clutter.EVENT_STOP;
      }
    }
    if (this._card && Clutter.keysym_to_unicode(key) && !ctrl)
      this._closeCard(); // typing goes back to the search
    return Clutter.EVENT_PROPAGATE;
  }

  _activate(result) {
    if (!result)
      return;
    this.close(); // first, so the app or browser gets the focus
    try {
      if (result.app)
        result.app.activate();
      else if (result.copy !== undefined)
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, result.copy);
      else if (result.url)
        Gio.AppInfo.launch_default_for_uri(result.url, global.create_app_launch_context(0, -1));
    } catch (e) {
      Main.notifyError("Spotlite", `Couldn’t open “${result.title}”: ${e.message}`);
    }
  }

  // ------------------------------------------------------------ Quick Look

  _closeCard() {
    this._cardResult = null;
    this._cardFrame?.destroy();
    this._cardFrame = null;
    this._card = null;
    if (this._isOpen)
      this._entry.grab_key_focus();
  }

  async _showCard(result) {
    if (!result?.preview) {
      this._closeCard();
      return;
    }
    this._cardResult = result;
    let data = result.preview;
    if (typeof data === "function") {
      try {
        data = await data();
      } catch (e) {
        data = { title: result.title, body: [{ type: "meta", text: e.message }] };
      }
      if (this._cardResult !== result || this._destroyed)
        return; // selection moved on while it loaded
    }

    const replacing = this._card !== null; // flipping through results with ↑↓: no zoom-in each time
    this._cardFrame?.destroy();
    const card = new St.BoxLayout({
      style_class: "spotlite-card", orientation: Clutter.Orientation.VERTICAL, reactive: true,
    });
    this._tint(card, CARD_EXTRA_OPACITY);
    // frosted glass under the card, like the bar; the frame is what gets placed and dragged
    const glass = new Glass({ radius: 22 });
    const frame = new St.Widget({ layout_manager: new Clutter.BinLayout() });
    this._cardCentre = new Clutter.AlignConstraint({ source: this, align_axis: Clutter.AlignAxis.BOTH, factor: 0.5 });
    frame.add_constraint(this._cardCentre);
    frame.add_child(glass);
    frame.add_child(card);
    frame.connect("notify::allocation", () => glass.sync());
    card.connect("button-press-event", (_a, event) => this._onFramePress(event, card, frame, "card-position"));

    // a Quick Look toolbar: close on the left, open the source on the right
    const toolbar = new St.BoxLayout({ style_class: "spotlite-card-toolbar" });
    const close = new St.Button({
      style_class: "spotlite-card-close", accessible_name: "Close", y_align: Clutter.ActorAlign.CENTER,
      child: new St.Icon({ icon_name: "window-close-symbolic", icon_size: 14 }),
    });
    close.connect("clicked", () => this._closeCard());
    toolbar.add_child(close);
    toolbar.add_child(new St.Widget({ x_expand: true }));
    if (result.app || result.url || result.copy !== undefined) {
      const open = new St.Button({ style_class: "spotlite-card-open", y_align: Clutter.ActorAlign.CENTER });
      const label = new St.BoxLayout({ style_class: "spotlite-card-open-box" });
      label.add_child(new St.Label({ text: data.action ?? "Open", y_align: Clutter.ActorAlign.CENTER }));
      label.add_child(new St.Icon({ icon_name: "go-next-symbolic", icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
      open.set_child(label);
      open.connect("clicked", () => this._activate(result));
      toolbar.add_child(open);
    }
    card.add_child(toolbar);

    const content = new St.BoxLayout({ style_class: "spotlite-card-content", orientation: Clutter.Orientation.VERTICAL });
    if (data.image || data.imageFile) {
      const hero = new St.Widget({ style_class: "spotlite-hero", x_expand: true });
      const show = file => (hero.style = `background-image: url("${file.get_uri()}");`);
      if (data.imageFile)
        show(Gio.File.new_for_path(data.imageFile));
      else
        this._withImage(data.image, hero, show);
      content.add_child(hero);
    }

    const head = new St.BoxLayout({ style_class: "spotlite-card-head" });
    head.add_child(new St.Icon({
      gicon: data.icon ?? result.icon, icon_size: 48, style_class: "spotlite-card-icon",
      y_align: Clutter.ActorAlign.START,
    }));
    const titles = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    titles.add_child(cardLabel(data.title ?? result.title, "spotlite-card-title"));
    if (data.subtitle)
      titles.add_child(cardLabel(data.subtitle, "spotlite-card-subtitle"));
    head.add_child(titles);
    content.add_child(head);
    for (const block of data.body ?? [])
      content.add_child(this._cardBlock(block));

    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const scroll = new St.ScrollView({
      style_class: "spotlite-card-scroll", child: content,
      hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
      overlay_scrollbars: true,
      style: `max-height: ${Math.round((this._cardMaxHeight - 80 * scale) / scale)}px;`,
    });
    card.add_child(scroll);

    this._card = card;
    this._cardFrame = frame;
    this.add_child(frame);
    // where it was dragged to last time, else the middle of the screen
    const saved = this._settings.get_value("card-position").deep_unpack();
    if (saved.length === 2) {
      const [, width] = frame.get_preferred_width(-1);
      this._placeCard(saved[0] * this.width - width / 2, saved[1] * this.height);
    }
    if (!replacing) {
      frame.set_pivot_point(0.5, 0.5);
      frame.set_scale(0.94, 0.94);
      frame.opacity = 0;
      frame.ease({ scale_x: 1, scale_y: 1, opacity: 255, duration: CARD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }
    this._entry.grab_key_focus();
  }

  _cardBlock(block) {
    switch (block.type) {
    case "heading":
      return new St.Label({ text: block.text, style_class: "spotlite-card-heading" });
    case "meta":
      return cardLabel(block.text, "spotlite-card-meta");
    case "mono":
      return cardLabel(block.text, "spotlite-card-mono");
    case "columns": {
      // a table row: fixed-width cells so rows line up under each other
      const row = new St.BoxLayout({ style_class: "spotlite-card-columns" });
      block.cells.forEach((text, i) =>
        row.add_child(new St.Label({ text, style_class: `spotlite-card-cell spotlite-card-cell-${i}` })));
      return row;
    }
    case "definition": {
      const row = new St.BoxLayout({ style_class: "spotlite-card-definition" });
      row.add_child(new St.Label({ text: `${block.n}`, style_class: "spotlite-card-number" }));
      const column = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
      column.add_child(cardLabel(block.text, "spotlite-card-paragraph"));
      if (block.example)
        column.add_child(cardLabel(`“${block.example}”`, "spotlite-card-example"));
      row.add_child(column);
      return row;
    }
    default:
      return cardLabel(block.text, "spotlite-card-paragraph");
    }
  }

  _onDestroy() {
    this._destroyed = true;
    this._cancelSlow();
    this._cancellable.cancel();
    this._stopWatching();
  }
});
