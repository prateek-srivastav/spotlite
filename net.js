import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

Gio._promisify(Soup.Session.prototype, "send_and_read_async");
Gio._promisify(Gio.File.prototype, "replace_contents_bytes_async", "replace_contents_finish");

// Wikimedia asks for a descriptive User-Agent; dictionaryapi.dev refuses some generic ones
const USER_AGENT = "Spotlite/1.0 (GNOME Shell extension; https://github.com/prateek-srivastav/spotlite)";

/** HTTP for the online sources, plus an on-disk cache for thumbnails. */
export class Net {
  constructor(cacheDir) {
    this._session = new Soup.Session({ user_agent: USER_AGENT, timeout: 6 });
    // for slow, optional services that have a fallback
    this._quick = new Soup.Session({ user_agent: USER_AGENT, timeout: 3 });
    this._cacheDir = Gio.File.new_for_path(cacheDir);
  }

  /** Response body as GLib.Bytes, or null on 404. */
  async getBytes(url, cancellable, { quick = false } = {}) {
    const message = Soup.Message.new("GET", url);
    const session = quick ? this._quick : this._session;
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.get_status();
    if (status === Soup.Status.NOT_FOUND)
      return null;
    if (status !== Soup.Status.OK) {
      const error = new Error(`HTTP ${status} from ${GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host()}`);
      error.status = status;
      throw error;
    }
    return bytes;
  }

  async getText(url, cancellable, options) {
    const bytes = await this.getBytes(url, cancellable, options);
    return bytes ? new TextDecoder().decode(bytes.toArray()) : null;
  }

  async getJson(url, cancellable, options) {
    const bytes = await this.getBytes(url, cancellable, options);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes.toArray())) : null;
  }

  /** A local copy of an image URL (downloaded once), for St to load. */
  async cachedFile(url, cancellable) {
    const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
    const file = this._cacheDir.get_child(name);
    if (file.query_exists(null))
      return file;
    const bytes = await this.getBytes(url, cancellable);
    if (!bytes)
      return null;
    GLib.mkdir_with_parents(this._cacheDir.get_path(), 0o700);
    await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, cancellable);
    return file;
  }

  destroy() {
    this._session.abort();
    this._quick.abort();
  }
}
