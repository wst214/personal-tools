#!/usr/bin/env python3
"""Patch running AnythingLLM for DevToolbox embed helpers."""
from pathlib import Path
import re
import sys

SKIN_VER = sys.argv[1] if len(sys.argv) > 1 else "stock2"
HREF = f"/toolbox-skin.css?v={SKIN_VER}"

FORCE = f'''<script data-toolbox-force-light>
              (function () {{
                try {{
                  var keys = ["anythingllm_theme_preference", "THEME_PREFERENCE", "theme", "themePreference"];
                  for (var i = 0; i < keys.length; i++) {{
                    var k = keys[i];
                    var v = localStorage.getItem(k);
                    if (!v || v === "default" || v === "system" || v === "dark") {{
                      localStorage.setItem(k, "light");
                    }}
                  }}
                  document.documentElement.setAttribute("data-theme", "light");
                  document.documentElement.classList.add("light");
                  document.documentElement.classList.remove("dark");
                  // Embed already has DevToolbox nav — collapse AnythingLLM workspace sidebar by default.
                  localStorage.setItem("anythingllm_sidebar_toggle", "closed");
                }} catch (e) {{}}
              }})();
            </script>'''

skin_path = Path("/app/server/public/toolbox-skin.css")
skin = skin_path.read_text(encoding="utf-8")

index_css = Path("/app/server/public/index.css")
css = index_css.read_text(encoding="utf-8", errors="ignore")
start, end = "/* TOOLBOX_SKIN_START */", "/* TOOLBOX_SKIN_END */"
block = f"\n{start}\n{skin}\n{end}\n"
if start in css and end in css:
    pre, rest = css.split(start, 1)
    _mid, post = rest.split(end, 1)
    css = pre.rstrip() + block + post.lstrip()
else:
    css = css.rstrip() + block
index_css.write_text(css, encoding="utf-8")


def patch_htmlish(text: str) -> tuple[str, int]:
    """Update skin href + force-light script. Returns (text, changes)."""
    changes = 0
    if "toolbox-skin.css" not in text:
        needle = '''            <script type="module" crossorigin src="/index.js"></script>
            <link rel="stylesheet" href="/index.css">
          </head>'''
        repl = f'''            <script type="module" crossorigin src="/index.js"></script>
            <link rel="stylesheet" href="/index.css">
            <link rel="stylesheet" href="{HREF}" />
            {FORCE}
          </head>'''
        if needle not in text:
            # looser fallback for _index.html formatting
            needle2 = '<link rel="stylesheet" href="/index.css">'
            if needle2 in text and "toolbox-skin.css" not in text:
                text = text.replace(
                    needle2,
                    f'{needle2}\n    <link rel="stylesheet" href="{HREF}" />\n    {FORCE}',
                    1,
                )
                changes += 1
            else:
                raise SystemExit("inject needle not found")
        else:
            text = text.replace(needle, repl)
            changes += 1
        return text, changes

    text2, n1 = re.subn(
        r'href="/toolbox-skin\.css[^"]*"',
        f'href="{HREF}"',
        text,
        count=1,
    )
    text2, n2 = re.subn(
        r"<script data-toolbox-force-light>[\s\S]*?</script>",
        FORCE,
        text2,
        count=1,
    )
    # _index may have skin link without query; ensure force script has sidebar close
    if n2 == 0 and "toolbox-force-light" in text2:
        text2, n2 = re.subn(
            r"<script data-toolbox-force-light>[\s\S]*?</script>",
            FORCE,
            text2,
            count=1,
            flags=re.I,
        )
    changes += n1 + n2
    return text2, changes


meta = Path("/app/server/utils/boot/MetaGenerator.js")
mt, n_meta = patch_htmlish(meta.read_text(encoding="utf-8"))
meta.write_text(mt, encoding="utf-8")

index_html = Path("/app/server/public/_index.html")
n_index = 0
if index_html.exists():
    ht, n_index = patch_htmlish(index_html.read_text(encoding="utf-8", errors="ignore"))
    index_html.write_text(ht, encoding="utf-8")

print("css_injected")
print("meta_changes", n_meta)
print("index_changes", n_index)
print("href", HREF)
print("has_sidebar_closed", "anythingllm_sidebar_toggle" in mt)
