#!/usr/bin/env bash
# Apply DevToolbox visual skin into the installed OpenAcme web assets.
set -e
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH"

SKIN_SRC="/mnt/d/mytools/dev-toolbox/openacme/toolbox-skin.css"
WEB_DIR=""

if command -v openacme >/dev/null 2>&1; then
  BIN="$(command -v openacme)"
  if [ -L "$BIN" ]; then
    BIN="$(readlink -f "$BIN")"
  fi
  CAND="$(dirname "$BIN")/../lib/node_modules/@openacme/cli/node_modules/@openacme/server/web"
  if [ -d "$CAND" ]; then
    WEB_DIR="$(cd "$CAND" && pwd)"
  fi
fi

if [ -z "$WEB_DIR" ] || [ ! -d "$WEB_DIR" ]; then
  WEB_DIR="$HOME/.hermes/node/lib/node_modules/@openacme/cli/node_modules/@openacme/server/web"
fi

if [ ! -d "$WEB_DIR" ]; then
  echo "openacme web dir not found"
  exit 1
fi
if [ ! -f "$SKIN_SRC" ]; then
  echo "skin source missing: $SKIN_SRC"
  exit 1
fi

cp "$SKIN_SRC" "$WEB_DIR/toolbox-skin.css"
INDEX="$WEB_DIR/index.html"

python3 - <<PY
from pathlib import Path
p = Path(r"$INDEX")
t = p.read_text(encoding="utf-8")
changed = False
if "toolbox-skin.css" not in t:
    t = t.replace("</head>", '  <link rel="stylesheet" href="/toolbox-skin.css" />\n  </head>')
    changed = True
snippet = '''    <script data-toolbox-force-light>
      (function () {
        try {
          if (!localStorage.getItem("openacme.theme")) {
            localStorage.setItem("openacme.theme", "light");
          }
          if (localStorage.getItem("openacme.theme") === "light") {
            document.documentElement.classList.remove("dark");
          }
        } catch (e) {}
      })();
    </script>
'''
if "toolbox-force-light" not in t:
    t = t.replace("</head>", snippet + "  </head>")
    changed = True
if changed:
    p.write_text(t, encoding="utf-8")
print("skin applied ->", r"$WEB_DIR/toolbox-skin.css")
print("index", "patched" if changed else "already ok")
PY
