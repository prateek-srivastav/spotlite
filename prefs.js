import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const ENGINES = [
  ["google", "Google"], ["duckduckgo", "DuckDuckGo"], ["bing", "Bing"],
  ["brave", "Brave Search"], ["ecosia", "Ecosia"], ["startpage", "Startpage"],
];
// GNOME also uses these to switch keyboard layout; with several layouts set up,
// that wins over an extension's shortcut on the same keys
const INPUT_SOURCE_KEYS = ["switch-input-source", "switch-input-source-backward"];

function normalize(accelerator) {
  const [ok, key, mods] = Gtk.accelerator_parse(accelerator);
  return ok ? Gtk.accelerator_name(key, mods) : accelerator;
}

export default class SpotlitePreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();
    window.add(page);
    page.add(this._shortcutGroup(window, settings));
    page.add(this._sourcesGroup(settings));
    page.add(this._weatherGroup(settings));
    page.add(this._wolframGroup(settings));
    page.add(this._webGroup(settings));
  }

  _shortcutGroup(window, settings) {
    const group = new Adw.PreferencesGroup({ title: "Shortcut" });
    const row = new Adw.ActionRow({ title: "Open Spotlite", subtitle: "Click to change", activatable: true });
    const label = new Gtk.ShortcutLabel({ disabled_text: "Disabled", valign: Gtk.Align.CENTER });
    row.add_suffix(label);
    row.connect("activated", () => this._captureShortcut(window, settings));
    group.add(row);

    const wm = new Gio.Settings({ schema_id: "org.gnome.desktop.wm.keybindings" });
    const clash = new Adw.ActionRow({
      title: "Also switches keyboard layout",
      subtitle: "GNOME uses this shortcut to change input source too, so Spotlite may not open. "
        + "Free it to use it for Spotlite only.",
    });
    clash.add_css_class("warning");
    const free = new Gtk.Button({ label: "Free It", valign: Gtk.Align.CENTER, css_classes: ["suggested-action"] });
    free.connect("clicked", () => {
      const ours = settings.get_strv("toggle-spotlite").map(normalize);
      for (const key of INPUT_SOURCE_KEYS)
        wm.set_strv(key, wm.get_strv(key).filter(a => !ours.includes(normalize(a))));
    });
    clash.add_suffix(free);
    group.add(clash);

    const update = () => {
      const accelerators = settings.get_strv("toggle-spotlite");
      label.accelerator = accelerators[0] ?? "";
      const ours = accelerators.map(normalize);
      clash.visible = INPUT_SOURCE_KEYS.some(key => wm.get_strv(key).some(a => ours.includes(normalize(a))));
    };
    settings.connect("changed::toggle-spotlite", update);
    for (const key of INPUT_SOURCE_KEYS)
      wm.connect(`changed::${key}`, update);
    update();

    // the bar can be dragged anywhere (by its frame); this puts it back
    const position = new Adw.ActionRow({ title: "Search bar position", subtitle: "Drag the bar by its edge to move it" });
    const reset = new Gtk.Button({ label: "Reset", valign: Gtk.Align.CENTER });
    reset.connect("clicked", () => settings.reset("panel-position"));
    position.add_suffix(reset);
    const moved = () => (reset.sensitive = settings.get_value("panel-position").n_children() > 0);
    settings.connect("changed::panel-position", moved);
    moved();
    group.add(position);
    return group;
  }

  _captureShortcut(window, settings) {
    const dialog = new Adw.AlertDialog({
      heading: "Press the New Shortcut",
      body: "Esc cancels, Backspace disables the shortcut",
    });
    dialog.add_response("cancel", "Cancel");
    const keys = new Gtk.EventControllerKey({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
    keys.connect("key-pressed", (_controller, keyval, keycode, state) => {
      const mods = state & Gtk.accelerator_get_default_mod_mask();
      const key = Gdk.keyval_to_lower(keyval);
      if (!mods && key === Gdk.KEY_Escape) {
        dialog.close();
        return Gdk.EVENT_STOP;
      }
      if (!mods && key === Gdk.KEY_BackSpace) {
        settings.set_strv("toggle-spotlite", []);
        dialog.close();
        return Gdk.EVENT_STOP;
      }
      // wait for a real key with at least one modifier (a bare letter would be unusable)
      if (!mods || !Gtk.accelerator_valid(key, mods))
        return Gdk.EVENT_STOP;
      settings.set_strv("toggle-spotlite", [Gtk.accelerator_name_with_keycode(null, key, keycode, mods)]);
      dialog.close();
      return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);
    dialog.present(window);
  }

  _sourcesGroup(settings) {
    const group = new Adw.PreferencesGroup({
      title: "Results",
      description: "Online results send what you type to that service. Apps, files and sums stay on this computer.",
    });
    const toggle = (key, title, subtitle) => {
      const row = new Adw.SwitchRow({ title, subtitle });
      settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
      group.add(row);
      return row;
    };
    const wikipedia = toggle("search-wikipedia", "Wikipedia and answers", "Articles, and facts like “age of rihanna” · wikipedia.org, wikidata.org");
    const language = new Adw.EntryRow({ title: "Wikipedia language code (en, de, hi, …)", show_apply_button: true });
    language.text = settings.get_string("wikipedia-language");
    language.connect("apply", () => settings.set_string("wikipedia-language", language.text.trim() || "en"));
    wikipedia.bind_property("active", language, "sensitive", 0);
    language.sensitive = wikipedia.active;
    group.add(language);
    toggle("search-dictionary", "Dictionary", "English definitions for single words · dictionaryapi.dev, wiktionary.org");
    toggle("search-files", "Files", "From GNOME's search index (localsearch)");
    toggle("search-calculator", "Calculator", "Results of sums like 12*(3+4)^2");
    return group;
  }

  _weatherGroup(settings) {
    const group = new Adw.PreferencesGroup({
      title: "Weather",
      description: "Answers “weather”, “weather in paris”, “delhi weather tomorrow”",
    });
    const on = new Adw.SwitchRow({ title: "Weather answers", subtitle: "Sends the city to open-meteo.com" });
    settings.bind("search-weather", on, "active", Gio.SettingsBindFlags.DEFAULT);
    group.add(on);
    const city = new Adw.EntryRow({ title: "Home city (empty: the city of your time zone)", show_apply_button: true });
    city.text = settings.get_string("weather-location");
    city.connect("apply", () => settings.set_string("weather-location", city.text.trim()));
    group.add(city);
    const units = ["celsius", "fahrenheit"];
    const unit = new Adw.ComboRow({ title: "Temperature", model: Gtk.StringList.new(["Celsius", "Fahrenheit"]) });
    unit.selected = Math.max(0, units.indexOf(settings.get_string("temperature-unit")));
    unit.connect("notify::selected", () => settings.set_string("temperature-unit", units[unit.selected]));
    group.add(unit);
    for (const row of [city, unit])
      on.bind_property("active", row, "sensitive", GObject.BindingFlags.SYNC_CREATE);
    return group;
  }

  _wolframGroup(settings) {
    const group = new Adw.PreferencesGroup({
      title: "Wolfram|Alpha",
      description: "Answers what Wikipedia and Wikidata can't (“10 usd in inr”, “distance from delhi to mumbai”). "
        + "Needs your own free AppID from developer.wolframalpha.com (Short Answers and Full Results APIs). "
        + "Asked only when Wikidata has no answer; sends the query to wolframalpha.com.",
    });
    const appid = new Adw.EntryRow({ title: "AppID (empty: off)", show_apply_button: true });
    appid.text = settings.get_string("wolfram-appid");
    appid.connect("apply", () => settings.set_string("wolfram-appid", appid.text.trim()));
    group.add(appid);
    const link = new Adw.ActionRow({ title: "Get an AppID", subtitle: "developer.wolframalpha.com", activatable: true });
    link.add_suffix(new Gtk.Image({ icon_name: "adw-external-link-symbolic" }));
    link.connect("activated", () => Gio.AppInfo.launch_default_for_uri("https://developer.wolframalpha.com/access", null));
    group.add(link);
    return group;
  }

  _webGroup(settings) {
    const group = new Adw.PreferencesGroup({
      title: "Web Search",
      description: "Prefixes jump to a site: g, ddg, yt, tr (translate), map, so, gh, wiki, def",
    });
    const row = new Adw.ComboRow({
      title: "Search engine",
      model: Gtk.StringList.new(ENGINES.map(([, name]) => name)),
    });
    const ids = ENGINES.map(([id]) => id);
    row.selected = Math.max(0, ids.indexOf(settings.get_string("web-engine")));
    row.connect("notify::selected", () => settings.set_string("web-engine", ids[row.selected]));
    group.add(row);
    return group;
  }
}
