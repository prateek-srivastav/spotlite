#!/bin/sh
# Build the zip that goes to extensions.gnome.org (or `gnome-extensions install`).
#   ./pack.sh            -> spotlite@prateek-srivastav.shell-extension.zip
#   ./pack.sh --install  -> also installs it for this user (log out and in to load it)
set -eu
cd "$(dirname "$0")"

gnome-extensions pack --force \
  --extra-source=calculator.js --extra-source=facts.js --extra-source=files.js --extra-source=glass.js --extra-source=net.js \
  --extra-source=online.js --extra-source=overlay.js --extra-source=search.js --extra-source=weather.js --extra-source=wolfram.js \
  --extra-source=layout.css --extra-source=stylesheet-dark.css --extra-source=stylesheet-light.css \
  --extra-source=icons --extra-source=LICENSE \
  --schema=schemas/org.gnome.shell.extensions.spotlite.gschema.xml \
  .
echo "built spotlite@prateek-srivastav.shell-extension.zip"

if [ "${1:-}" = "--install" ]; then
  gnome-extensions install --force spotlite@prateek-srivastav.shell-extension.zip
  echo "installed; log out and back in, then: gnome-extensions enable spotlite@prateek-srivastav"
fi
