// What to search for, and where. The overlay asks for instant() results on
// every keystroke and runs the slow() sources (network, file index) after a
// short pause in typing.
//
// A result is a plain object:
//   { group, title, subtitle, icon (Gio.Icon), thumb (image URL), key,
//     app (Shell.App) | url | copy (text): what Enter does,
//     preview: Quick Look data, or an async function returning it }
// Quick Look data:
//   { title, subtitle, icon, image (URL) | imageFile (path), action (button label),
//     body: [{type: "paragraph" | "heading" | "meta" | "mono", text}
//            | {type: "definition", n, text, example}] }

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";

import { calculate } from "./calculator.js";
import { answer } from "./facts.js";
import { Files } from "./files.js";
import { Net } from "./net.js";
import * as Online from "./online.js";
import { parseWeather, weather } from "./weather.js";
import { wolfram } from "./wolfram.js";

export const GROUP_ORDER = ["Top Hit", "Answer", "Applications", "Calculator", "Definition", "Wikipedia", "Files", "Search the Web"];

const ENGINES = {
  google: ["Google", "https://www.google.com/search?q="],
  duckduckgo: ["DuckDuckGo", "https://duckduckgo.com/?q="],
  bing: ["Bing", "https://www.bing.com/search?q="],
  brave: ["Brave Search", "https://search.brave.com/search?q="],
  ecosia: ["Ecosia", "https://www.ecosia.org/search?q="],
  startpage: ["Startpage", "https://www.startpage.com/do/search?q="],
  youtube: ["YouTube", "https://www.youtube.com/results?search_query=", "video-x-generic-symbolic"],
  translate: ["Google Translate", "https://translate.google.com/?sl=auto&tl=en&text=", "preferences-desktop-locale-symbolic"],
  maps: ["OpenStreetMap", "https://www.openstreetmap.org/search?query=", "mark-location-symbolic"],
  stackoverflow: ["Stack Overflow", "https://stackoverflow.com/search?q="],
  github: ["GitHub", "https://github.com/search?q="],
};
// "yt lofi", "def serendipity", ...: the prefixed engine goes to the top
const PREFIXES = {
  g: "google", ddg: "duckduckgo", yt: "youtube", tr: "translate", map: "maps",
  so: "stackoverflow", gh: "github", wiki: "wiki", def: "define", define: "define",
};
const DEFINE_BEFORE = /^(?:meaning of|definition of|what does)\s+(\p{L}[\p{L}'-]*)(?:\s+mean)?\??$/iu;
const DEFINE_AFTER = /^(\p{L}[\p{L}'-]*)\s+(?:meaning|definition)\??$/iu;
const WORD = /^[a-z][a-z'-]{2,}$/i;
// how long typing must pause before asking each source; short, since results are cached
const SLOW_DELAY_MS = { files: 60, weather: 120, answer: 120, dictionary: 120, wikipedia: 120 };
const CACHE_SIZE = 200;

/** { text, mode: null | "define" | "wiki" | engine id, term } */
export function parse(input) {
  const text = input.trim();
  const space = text.indexOf(" ");
  if (space > 0) {
    const mode = PREFIXES[text.slice(0, space).toLowerCase()];
    const rest = text.slice(space + 1).trim();
    if (mode && rest)
      return { text, mode, term: rest };
  }
  const m = text.match(DEFINE_BEFORE) ?? text.match(DEFINE_AFTER);
  if (m)
    return { text, mode: "define", term: m[1] };
  return { text, mode: null, term: text };
}

function words(name) {
  return name.toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
}

export class Searcher {
  constructor(extension, settings) {
    this._settings = settings;
    this._cache = new Map(); // "source\nquery" -> results, oldest first
    const file = name => Gio.FileIcon.new(extension.dir.get_child("icons").get_child(name));
    this._icons = {
      dictionary: file("dictionary.svg"),
      wikipedia: file("wikipedia.svg"),
      web: file("web.svg"),
      calculator: Gio.ThemedIcon.new("accessories-calculator-symbolic"),
    };
    this.net = new Net(GLib.build_filenamev([GLib.get_user_cache_dir(), "spotlite", "images"]));
    this._files = new Files();
  }

  get _ctx() {
    return {
      net: this.net,
      icons: this._icons,
      settings: this._settings,
      wikipediaLanguage: this._settings.get_string("wikipedia-language").trim() || "en",
      webSearch: text => this._webUrl(text),
    };
  }

  instant(query) {
    return [...this._apps(query), ...this._calculator(query), ...this._web(query)];
  }

  /** [{name, delay, run(cancellable) -> Promise<results>}] worth running for this query */
  slow(query) {
    const sources = [];
    const add = (name, run) => {
      // answers seen before (Backspace, reopening Spotlite) come back at once
      const key = `${name}\n${query.text}`;
      const cached = this._cache.get(key);
      sources.push(cached
        ? { name, delay: 0, run: () => Promise.resolve(cached) }
        : { name, delay: SLOW_DELAY_MS[name], run: c => run(c).then(results => this._remember(key, results)) });
    };
    const isSum = calculate(query.text) !== null;

    // "weather in delhi": the forecast is the answer; a dictionary or article for it isn't
    const forecast = query.mode === null ? parseWeather(query.text) : null;
    if (forecast) {
      if (this._settings.get_boolean("search-weather"))
        add("weather", c => weather(this._ctx, forecast, c));
      return sources;
    }
    // any query of two or more words may be a question ("srk age", "who directed inception");
    // facts.js works out from Wikipedia and Wikidata whether it is, and returns [] if not
    const wikipedia = this._settings.get_boolean("search-wikipedia");
    const wolframOn = this._settings.get_string("wolfram-appid").trim() !== "";
    if (query.mode === null && /\s/.test(query.text) && !isSum && (wikipedia || wolframOn)) {
      add("answer", async c => {
        const found = wikipedia ? await answer(this._ctx, query.text, c) : [];
        if (found.topic)
          return []; // "taj mahal" names an article: that article is the answer, not a computation
        if (found.length && !found[0].rich?.sentence)
          return found; // a fact from Wikidata: free, and no need to spend Wolfram|Alpha's quota
        // no fact: Wolfram|Alpha's answer (if set up) beats the best-matching sentence
        const computed = wolframOn ? await wolfram(this._ctx, query.text, c) : [];
        return computed.length ? computed : found;
      });
    }

    let word = null;
    if (query.mode === "define")
      word = query.term;
    else if (query.mode === null && WORD.test(query.text))
      word = query.text;
    if (word && this._settings.get_boolean("search-dictionary"))
      add("dictionary", c => Online.dictionary(this._ctx, word, c));

    let topic = null;
    if (query.mode === "wiki")
      topic = query.term;
    else if ((query.mode === null || query.mode === "define") && query.term.length >= 4 && !isSum)
      topic = query.term;
    if (topic && this._settings.get_boolean("search-wikipedia"))
      add("wikipedia", c => Online.wikipedia(this._ctx, topic, c));

    if (query.mode === null && query.text.length >= 2 && !isSum && this._settings.get_boolean("search-files"))
      add("files", c => this._files.search(this._ctx, query.text, c));
    return sources;
  }

  // GNOME's own app search (the one the Activities overview uses), ranked by how
  // well the name matches, then by how often you use each app
  _apps(query) {
    if (query.mode !== null && query.mode !== "define")
      return [];
    const appSystem = Shell.AppSystem.get_default();
    const usage = Shell.AppUsage.get_default();
    const typed = query.text.toLowerCase();
    const nameLength = id => appSystem.lookup_app(id)?.get_name().length ?? Infinity;
    // on a usage tie (never-used apps), the shorter name wins: "ter" -> Terminal, not Terminal Preferences
    const ids = Shell.AppSystem.search(query.text)
      .flatMap(group => group.sort((a, b) => usage.compare(a, b) || nameLength(a) - nameLength(b)));
    const results = [];
    for (const id of ids) {
      const app = appSystem.lookup_app(id);
      if (!app)
        continue;
      const top = results.length === 0 && words(app.get_name()).some(w => w.startsWith(typed));
      results.push({
        group: top ? "Top Hit" : "Applications",
        title: app.get_name(),
        subtitle: app.get_description() ?? "",
        icon: app.get_icon() ?? Gio.ThemedIcon.new("application-x-executable"),
        app,
        key: `app:${id}`,
        preview: () => appPreview(app),
      });
      if (results.length === 6)
        break;
    }
    return results;
  }

  _calculator(query) {
    if (!this._settings.get_boolean("search-calculator"))
      return [];
    const value = calculate(query.text);
    if (value === null)
      return [];
    return [{
      group: "Calculator",
      title: value,
      subtitle: `${query.text}  ·  Enter copies the result`,
      icon: this._icons.calculator,
      copy: value.replace(/,/g, ""),
      key: "calc",
    }];
  }

  _web(query) {
    const rows = [];
    const row = (group, id, text) => {
      const [name, base, icon] = ENGINES[id];
      rows.push({
        group,
        title: `Search ${name} for “${text}”`,
        subtitle: "Opens in your browser",
        icon: icon ? Gio.ThemedIcon.new(icon) : this._icons.web,
        url: base + encodeURIComponent(text),
        key: `web:${id}`,
      });
    };
    if (ENGINES[query.mode])
      row("Top Hit", query.mode, query.term);
    const engine = this._settings.get_string("web-engine");
    if (query.text && query.mode !== engine)
      row("Search the Web", ENGINES[engine] ? engine : "google", query.text);
    return rows;
  }

  _remember(key, results) {
    this._cache.delete(key);
    this._cache.set(key, results);
    if (this._cache.size > CACHE_SIZE)
      this._cache.delete(this._cache.keys().next().value);
    return results;
  }

  _webUrl(text) {
    const engine = ENGINES[this._settings.get_string("web-engine")] ?? ENGINES.google;
    return engine[1] + encodeURIComponent(text);
  }

  destroy() {
    this._files.destroy();
    this.net.destroy();
  }
}

function appPreview(app) {
  const info = app.get_app_info();
  const body = [];
  if (app.get_description())
    body.push({ type: "paragraph", text: app.get_description() });
  if (info?.get_commandline())
    body.push({ type: "mono", text: info.get_commandline() });
  return {
    title: app.get_name(),
    subtitle: info?.get_generic_name?.() ?? "Application",
    icon: app.get_icon(),
    body,
    action: "Open",
  };
}
