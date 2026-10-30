import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { Overlay } from "./overlay.js";
import { Searcher } from "./search.js";

// GNOME's own keyboard-layout switch is on Super+Space by default, and it wins
const INPUT_SOURCE_KEYS = ["switch-input-source", "switch-input-source-backward"];
const sameKeys = (a, b) => a.toLowerCase().replace(/<mod4>/g, "<super>") === b.toLowerCase().replace(/<mod4>/g, "<super>");

export default class SpotliteExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._searcher = new Searcher(this, this._settings);
    this._overlay = new Overlay(this._searcher, this._settings);
    // SYSTEM_MODAL is Spotlite's own modal mode, so the shortcut also closes it
    Main.wm.addKeybinding("toggle-spotlite", this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.SYSTEM_MODAL,
      () => this._toggle());
    this._warnIfShortcutTaken();
  }

  _toggle() {
    if (this._overlay.isOpen) {
      this._overlay.close();
      return;
    }
    // don't open over someone else's modal dialog (password prompts, end-session, ...)
    if (!(Main.actionMode & (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)))
      return;
    if (Main.overview.visible)
      Main.overview.hide();
    this._overlay.open();
  }

  // On a fresh install Super+Space still switches keyboard layout and Spotlite never
  // sees it. Say so once per login, with a way to the preferences' "Free It" button.
  _warnIfShortcutTaken() {
    const ours = this._settings.get_strv("toggle-spotlite");
    const wm = new Gio.Settings({ schema_id: "org.gnome.desktop.wm.keybindings" });
    const taken = INPUT_SOURCE_KEYS.some(key => wm.get_strv(key).some(a => ours.some(o => sameKeys(a, o))));
    if (!taken)
      return;
    const source = MessageTray.getSystemSource();
    const notification = new MessageTray.Notification({
      source,
      title: "Spotlite can’t use its shortcut yet",
      body: `GNOME also uses ${ours[0]} to switch keyboard layout. Open Spotlite’s settings and press “Free It”, or pick another shortcut.`,
    });
    notification.addAction("Open Settings", () => this.openPreferences());
    source.addNotification(notification);
  }

  disable() {
    Main.wm.removeKeybinding("toggle-spotlite");
    this._overlay.destroy();
    this._overlay = null;
    this._searcher.destroy();
    this._searcher = null;
    this._settings = null;
  }
}
