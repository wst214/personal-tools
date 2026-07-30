import json
import urllib.request

req = urllib.request.Request(
    "http://127.0.0.1:8100/api/status",
    data=json.dumps({"dialect": "dameng"}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=15) as resp:
    print(resp.read().decode("utf-8", "replace"))
