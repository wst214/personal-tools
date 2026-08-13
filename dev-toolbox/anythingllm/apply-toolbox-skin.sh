#!/usr/bin/env bash
# Apply DevToolbox mint skin into running AnythingLLM container.
set -e
CONTAINER="${1:-mytools-anythingllm}"
SKIN_SRC="/mnt/d/mytools/dev-toolbox/anythingllm/toolbox-skin.css"

if [ ! -f "$SKIN_SRC" ]; then
  # Windows-side path when run via docker from host mount is better via docker cp
  echo "skin src missing at $SKIN_SRC (use apply-toolbox-skin.ps1 on Windows)"
  exit 1
fi

docker cp "$SKIN_SRC" "${CONTAINER}:/app/server/public/toolbox-skin.css"
docker exec "$CONTAINER" sh -c 'python3 - <<'"'"'PY'"'"'
from pathlib import Path
p = Path("/app/server/public/_index.html")
t = p.read_text(encoding="utf-8")
changed = False
if "toolbox-skin.css" not in t:
    t = t.replace("</head>", '  <link rel="stylesheet" href="/toolbox-skin.css" />\n  </head>')
    changed = True
snippet = """    <script data-toolbox-force-light>
      (function () {
        try {
          var k = "anythingllm_theme_preference";
          if (!localStorage.getItem(k) || localStorage.getItem(k) === "default") {
            localStorage.setItem(k, "light");
          }
          document.documentElement.setAttribute("data-theme", "light");
        } catch (e) {}
      })();
    </script>
"""
if "toolbox-force-light" not in t:
    t = t.replace("</head>", snippet + "  </head>")
    changed = True
if changed:
    p.write_text(t, encoding="utf-8")
print("patched" if changed else "already ok")
PY'
echo "skin applied to $CONTAINER"
