"""Tunnel Panel - visual Cloudflare / cpolar quick-tunnel manager."""

from __future__ import annotations

from flask import Flask, jsonify, render_template, request

from tunnel_manager import (
    TunnelManager,
    cpolar_configured,
    find_cloudflared,
    find_cpolar,
)

app = Flask(__name__)
manager = TunnelManager()


@app.after_request
def disable_static_cache(response):
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/info")
def api_info():
    return jsonify(
        {
            "cloudflared": find_cloudflared() is not None,
            "cloudflared_path": find_cloudflared() or "",
            "cpolar": find_cpolar() is not None,
            "cpolar_path": find_cpolar() or "",
            "cpolar_ready": cpolar_configured(),
        }
    )


@app.get("/api/tunnel/status")
def api_status():
    state = manager.state
    return jsonify(
        {
            "status": state.status,
            "provider": state.provider,
            "target": state.target,
            "resolved_addr": state.resolved_addr,
            "public_url": state.public_url,
            "error": state.error,
            "logs": state.logs,
            "pid": state.pid,
        }
    )


@app.post("/api/tunnel/start")
def api_start():
    data = request.get_json(force=True) or {}
    target = str(data.get("target", "")).strip()
    provider = str(data.get("provider", "cloudflare")).strip().lower()
    try:
        state = manager.begin_start(target, provider=provider)
        return jsonify(
            {
                "ok": True,
                "status": state.status,
                "provider": state.provider,
                "target": state.target,
                "resolved_addr": state.resolved_addr,
                "public_url": state.public_url,
                "error": state.error,
            }
        )
    except Exception as exc:  # noqa: BLE001
        state = manager.state
        return (
            jsonify(
                {
                    "ok": False,
                    "error": str(exc),
                    "status": state.status,
                    "public_url": state.public_url,
                    "logs": state.logs[-20:],
                }
            ),
            400,
        )


@app.post("/api/tunnel/stop")
def api_stop():
    state = manager.stop()
    return jsonify(
        {
            "ok": True,
            "status": state.status,
            "public_url": state.public_url,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5760, debug=False, threaded=True)
