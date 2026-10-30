# Spotlite

A macOS-style Spotlight for GNOME. Press **Super+Space**, type, press **Enter**.

- **Apps**: GNOME's own app search, ranked by how often you use each app
- **Files**: from GNOME's search index (localsearch)
- **Sums**: `12*(3+4)^2` → 588; Enter copies the result
- **Meanings**: type a word (`serendipity`, `meaning of ephemeral`) to see its definitions
- **Topics**: `taj mahal` shows the Wikipedia article with a picture and summary
- **Answers**: `srk age`, `who directed inception`, `eiffel tower height`, `virat kohli wife`,
  `india population` show the answer itself as the Top Hit. There is no list of question
  patterns: the subject is found by trying the query's words as Wikipedia titles, the fact
  by Wikidata's own property search, and failing that, the best-matching sentence of the article
- **Weather**: `weather`, `weather in paris`, `delhi weather tomorrow` (from Open-Meteo)
- **Wolfram|Alpha** (optional): add your own free AppID in the preferences and questions
  Wikidata can't answer (`10 usd in inr`, `distance from delhi to mumbai`) get Wolfram|Alpha's
  answer; Space shows its full result. It's only asked when Wikidata has no answer, to spare the quota
- **Web**: a "Search the web" row, plus prefixes that jump to a site: `g`, `ddg`, `yt`, `tr`, `map`, `so`, `gh`, `wiki`, `def`

### Quick Look

Select a result with **↑/↓** and press **Space** for a card with the details: the
Wikipedia summary and picture, every meaning of a word with examples, an image or
the start of a text file. **↑/↓** flips through results with the card open,
**Enter** opens the source, **Esc** or **Space** closes it. **Shift+Space** opens
the card without selecting first. Plain Space types a space while you're still
typing, which is why it needs the arrow keys first.

## Install

From [extensions.gnome.org](https://extensions.gnome.org) (search "Spotlite"), or from source:

```sh
git clone https://github.com/prateek-srivastav/spotlite
cd spotlite
./pack.sh --install
```

Log out and back in, then enable it in the Extensions app (or `gnome-extensions enable spotlite@prateek-srivastav`).

Needs GNOME Shell 50. File results need localsearch (installed by default on Fedora and Ubuntu).

### Super+Space doesn't open it?

GNOME also uses Super+Space to switch keyboard layout. If you have more than one
input source, open Spotlite's preferences and press **Free It**, or pick another shortcut there.

## Privacy

Apps, files and sums never leave your computer. Wikipedia results and answers send
what you type to `wikipedia.org` and `wikidata.org`; definitions send single words
to `dictionaryapi.dev` and `wiktionary.org`; weather sends the city to `open-meteo.com`
(a bare "weather" uses your home city from the preferences, or your time zone's city;
never your IP address); with an AppID set, questions Wikidata can't answer go to `wolframalpha.com`. Each source can be switched off in the preferences. Nothing is
sent until you pause typing for a moment, and nothing is logged.

## Development

On Wayland, GNOME Shell only loads extension changes at login. Test in a nested
shell instead (needs `mutter-devkit`):

```sh
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/spotlite@prateek-srivastav
glib-compile-schemas schemas/
env GSETTINGS_BACKEND=memory dbus-run-session -- gnome-shell --devkit --wayland
# then, in a terminal inside the nested shell:
gnome-extensions enable spotlite@prateek-srivastav
```

Keep `GSETTINGS_BACKEND=memory`, and set it *before* `dbus-run-session`. Without
it the nested session's own settings service writes into your real settings
file: your enabled extensions, colour scheme and more change under your desktop.

## License

GPL-2.0-or-later
