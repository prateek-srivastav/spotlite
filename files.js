// Files from GNOME's search index (localsearch, queried with TinySPARQL).
// Nothing leaves the computer. If localsearch isn't installed this source
// quietly returns nothing.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

const SKIP_PATHS = ["/.", "/node_modules/", "/site-packages/", "/__pycache__/", "/miniforge3/", "/miniconda3/"];
// filter in the query, not after it: in a home full of node_modules the LIMIT would
// otherwise be used up by files we'd throw away
const SPARQL = word => `
SELECT ?url ?name WHERE {
  ?r a nfo:FileDataObject ; nie:url ?url ; nfo:fileName ?name .
  ?r fts:match "${word}" .
  ${SKIP_PATHS.map(s => `FILTER(!CONTAINS(?url, "${s}"))`).join("\n  ")}
} ORDER BY DESC(fts:rank(?r)) LIMIT 60`;

Gio._promisify(Gio.File.prototype, "query_info_async");
Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.File.prototype, "enumerate_children_async");
Gio._promisify(Gio.FileEnumerator.prototype, "next_files_async");

export class Files {
  constructor() {
    this._connection = null;
    this._Tsparql = undefined;
  }

  async _connect(cancellable) {
    if (this._Tsparql === undefined) {
      try {
        this._Tsparql = (await import("gi://Tsparql?version=3.0")).default;
        Gio._promisify(this._Tsparql.SparqlConnection, "bus_new_async", "bus_new_finish");
        Gio._promisify(this._Tsparql.SparqlConnection.prototype, "query_async");
        Gio._promisify(this._Tsparql.SparqlCursor.prototype, "next_async");
      } catch {
        this._Tsparql = null;
      }
    }
    if (!this._Tsparql)
      return null;
    this._connection ??= await this._Tsparql.SparqlConnection.bus_new_async(
      "org.freedesktop.LocalSearch3", null, null, cancellable);
    return this._connection;
  }

  async search(ctx, text, cancellable) {
    const words = text.match(/[\p{L}\p{N}_]+/gu);
    if (!words)
      return [];
    const connection = await this._connect(cancellable);
    if (!connection)
      return [];
    const cursor = await connection.query_async(SPARQL(words.map(w => `${w}*`).join(" ")), cancellable);
    const found = new Map(); // a file matches once per indexed property
    try {
      while (await cursor.next_async(cancellable)) {
        const [url] = cursor.get_string(0);
        const [name] = cursor.get_string(1);
        if (url.startsWith("file://") && !SKIP_PATHS.some(s => url.includes(s)))
          found.set(url, name);
      }
    } finally {
      cursor.close();
    }

    const low = text.toLowerCase();
    const ranked = [...found].sort(([, a], [, b]) =>
      (b.toLowerCase().startsWith(low) - a.toLowerCase().startsWith(low)) ||
      (b.toLowerCase().includes(low) - a.toLowerCase().includes(low)));
    const home = GLib.get_home_dir();
    const results = [];
    for (const [url, name] of ranked.slice(0, 8)) {
      const file = Gio.File.new_for_uri(url);
      let info;
      try {
        info = await file.query_info_async("standard::content-type,standard::icon,standard::type",
          Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
      } catch {
        continue; // deleted since it was indexed
      }
      const path = file.get_path();
      results.push({
        group: "Files",
        title: name,
        subtitle: path.startsWith(home) ? `~${path.slice(home.length)}` : path,
        icon: info.get_icon(),
        url,
        key: `file:${url}`,
        preview: () => filePreview(file, info, cancellable),
      });
      if (results.length === 5)
        break;
    }
    return results;
  }

  destroy() {
    this._connection?.close();
    this._connection = null;
  }
}

function humanSize(bytes) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} bytes` : `${bytes.toFixed(1)} ${units[i]}`;
}

async function filePreview(file, info, cancellable) {
  const full = await file.query_info_async("standard::*,time::modified",
    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
  const type = full.get_content_type() ?? "application/octet-stream";
  const isDir = full.get_file_type() === Gio.FileType.DIRECTORY;
  const modified = full.get_modification_date_time()?.to_local().format("%e %b %Y, %H:%M").trim() ?? "";
  const path = file.get_path();
  const home = GLib.get_home_dir();
  const preview = {
    title: file.get_basename(),
    subtitle: path.startsWith(home) ? `~${path.slice(home.length)}` : path,
    icon: info.get_icon(),
    body: [{
      type: "meta",
      text: [Gio.content_type_get_description(type), isDir ? "folder" : humanSize(full.get_size()),
        modified && `modified ${modified}`].filter(Boolean).join(" · "),
    }],
    action: "Open",
  };
  if (type.startsWith("image/") && full.get_size() < 40e6) {
    preview.imageFile = path;
  } else if (isDir) {
    const enumerator = await file.enumerate_children_async("standard::name,standard::is-hidden",
      Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const names = (await enumerator.next_files_async(200, GLib.PRIORITY_DEFAULT, cancellable))
      .filter(i => !i.get_is_hidden()).map(i => i.get_name()).sort();
    enumerator.close(null);
    preview.body.push({ type: "mono", text: names.slice(0, 40).join("\n") + (names.length > 40 ? "\n…" : "") });
  } else if (Gio.content_type_is_a(type, "text/plain") && full.get_size() < 2e6) {
    const [contents] = await file.load_contents_async(cancellable);
    preview.body.push({ type: "mono", text: new TextDecoder().decode(contents.slice(0, 4000)) });
  }
  return preview;
}
