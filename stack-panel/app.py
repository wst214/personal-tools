"""Web API for the configurable server deployment panel."""

from __future__ import annotations

import os

from flask import Flask, jsonify, render_template, request

from deployment_manager import DeploymentManager

app = Flask(__name__)
manager = DeploymentManager()


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
    return jsonify(manager.info())


@app.get("/api/environments")
def api_environments():
    return jsonify({"environments": manager.store.list()})


@app.post("/api/environments")
def api_save_environment():
    payload = request.get_json(force=True) or {}
    try:
        return jsonify({"ok": True, "environment": manager.store.save(payload)})
    except (TypeError, ValueError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.delete("/api/environments/<environment_id>")
def api_delete_environment(environment_id: str):
    try:
        manager.store.delete(environment_id)
        return jsonify({"ok": True})
    except KeyError:
        return jsonify({"ok": False, "error": "环境不存在"}), 404


@app.post("/api/deployments")
def api_start_deployment():
    payload = request.get_json(force=True) or {}
    try:
        task = manager.start(
            str(payload.get("environment_id") or ""),
            [str(item) for item in payload.get("services", [])],
            [str(item) for item in payload.get("steps", [])],
        )
        return jsonify({"ok": True, "task": task.to_dict()})
    except KeyError:
        return jsonify({"ok": False, "error": "环境不存在"}), 404
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/tasks/<task_id>")
def api_task(task_id: str):
    task = manager.get_task(task_id)
    if task is None:
        return jsonify({"error": "任务不存在"}), 404
    return jsonify(task.to_dict())


@app.get("/api/tasks")
def api_tasks():
    return jsonify({"tasks": manager.recent_tasks()})


if __name__ == "__main__":
    port = int(os.environ.get("STACK_PANEL_PORT", "5770"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
