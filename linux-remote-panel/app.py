"""Linux Remote Panel - SSH terminal, quick commands, and file manager."""

from __future__ import annotations

import os
import webbrowser
from io import BytesIO
from pathlib import Path
from threading import Timer
from flask import Flask, jsonify, render_template, request, send_file

from ssh_manager import (
    ConnectionConfig,
    SSHSession,
    join_remote_path,
    load_commands,
    load_profiles,
    load_wsl_defaults,
    normalize_remote_path,
    save_profiles,
    save_user_commands,
)
from wsl_client import call_helper

app = Flask(__name__)
session = SSHSession()


@app.after_request
def disable_static_cache(response):
    if request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/commands")
def api_commands():
    return jsonify(load_commands())


@app.post("/api/commands")
def api_save_commands():
    data = request.get_json(force=True)
    save_user_commands(data)
    return jsonify({"ok": True})


@app.get("/api/profiles")
def api_profiles():
    return jsonify(load_profiles())


@app.post("/api/profiles")
def api_save_profile_list():
    profiles = request.get_json(force=True)
    if not isinstance(profiles, list):
        return jsonify({"ok": False, "error": "无效的配置列表"}), 400
    save_profiles(profiles)
    return jsonify({"ok": True})


@app.get("/api/status")
def api_status():
    alive = session.ping()
    cfg = session.config
    return jsonify(
        {
            "connected": alive and cfg is not None,
            "host": cfg.host if cfg else "",
            "username": cfg.username if cfg else "",
            "port": cfg.port if cfg else 22,
            "cwd": session.cwd if alive else "/",
        }
    )


@app.post("/api/reconnect")
def api_reconnect():
    try:
        session.reconnect()
        cfg = session.config
        return jsonify(
            {
                "ok": True,
                "message": f"已重新连接 {cfg.username}@{cfg.host}" if cfg else "已重新连接",
                "cwd": session.cwd,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/connect")
def api_connect():
    data = request.get_json(force=True)
    try:
        config = ConnectionConfig.from_dict(data)
        if not config.host:
            raise ValueError("请填写主机地址")
        session.connect(config)
        return jsonify(
            {
                "ok": True,
                "message": f"已连接 {config.username}@{config.host}",
                "cwd": session.cwd,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/disconnect")
def api_disconnect():
    session.disconnect()
    return jsonify({"ok": True})


@app.get("/api/wsl/health")
def api_wsl_health():
    try:
        return jsonify(call_helper("/health"))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 503


@app.get("/api/wsl/info")
def api_wsl_info():
    try:
        return jsonify(call_helper("/wsl/info"))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/wsl/defaults")
def api_wsl_defaults():
    defaults = load_wsl_defaults()
    return jsonify({"ok": True, "defaults": defaults})


@app.post("/api/wsl/prepare")
def api_wsl_prepare():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(call_helper("/wsl/prepare", "POST", data))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/execute")
def api_execute():
    data = request.get_json(force=True)
    command = (data.get("command") or "").strip()
    if not command:
        return jsonify({"ok": False, "error": "命令不能为空"}), 400
    try:
        result = session.execute(command)
        if command.startswith("cd "):
            path = command[3:].strip() or "~"
            if path == "~":
                home = session.execute("cd ~ && pwd")["stdout"].strip()
                session.cwd = normalize_remote_path(home)
            else:
                session.cwd = normalize_remote_path(path)
        return jsonify({"ok": True, **result, "cwd": session.cwd})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/system")
def api_system():
    try:
        return jsonify({"ok": True, "snapshot": session.system_snapshot(), "cwd": session.cwd})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/files")
def api_list_files():
    path = request.args.get("path", session.cwd)
    try:
        listing = session.list_directory(path)
        return jsonify({"ok": True, **listing})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/files/download")
def api_download_file():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"ok": False, "error": "缺少 path 参数"}), 400
    try:
        content, filename = session.read_file(path)
        return send_file(
            BytesIO(content),
            as_attachment=True,
            download_name=filename,
            mimetype="application/octet-stream",
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/files/upload")
def api_upload_file():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "未选择文件"}), 400
    upload = request.files["file"]
    if not upload.filename:
        return jsonify({"ok": False, "error": "文件名为空"}), 400
    target_dir = normalize_remote_path(request.form.get("path", session.cwd))
    try:
        remote_path = join_remote_path(target_dir, upload.filename)
        session.write_file(remote_path, upload.read())
        listing = session.list_directory(target_dir)
        return jsonify({"ok": True, "path": remote_path, **listing})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/files/delete")
def api_delete_file():
    data = request.get_json(force=True)
    path = data.get("path", "")
    if not path:
        return jsonify({"ok": False, "error": "缺少 path 参数"}), 400
    try:
        parent = normalize_remote_path(str(Path(path).parent)) or "/"
        session.delete_path(path)
        listing = session.list_directory(parent)
        return jsonify({"ok": True, **listing})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 400


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5757))
    if os.environ.get("OPEN_BROWSER") == "1":
        Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    app.run(host="0.0.0.0", port=port, debug=False)
