"""Stack Panel - local Docker Compose build, restart, and lifecycle manager."""

from __future__ import annotations

from flask import Flask, jsonify, render_template, request

from stack_manager import StackManager

app = Flask(__name__)
manager = StackManager()


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


@app.get("/api/stacks")
def api_stacks():
    return jsonify({"stacks": manager.list_stacks()})


@app.get("/api/stacks/<stack_id>")
def api_stack_detail(stack_id: str):
    try:
        stacks = manager.list_stacks()
        stack = next((item for item in stacks if item["id"] == stack_id), None)
        if stack is None:
            return jsonify({"error": "stack not found"}), 404
        return jsonify(stack)
    except KeyError:
        return jsonify({"error": "stack not found"}), 404


@app.post("/api/stacks/<stack_id>/action")
def api_stack_action(stack_id: str):
    data = request.get_json(force=True) or {}
    action = str(data.get("action", "")).strip().lower()
    services = data.get("services") or []
    build_mode = data.get("build_mode")
    build_mode = str(build_mode).strip() if build_mode else None
    tail = int(data.get("tail") or 120)

    if action not in {"up", "build", "restart", "stop", "down", "logs", "pull", "package"}:
        return jsonify({"ok": False, "error": "unsupported action"}), 400

    if services and not isinstance(services, list):
        return jsonify({"ok": False, "error": "services must be a list"}), 400

    try:
        task = manager.start_action(
            stack_id,
            action,
            services=[str(name) for name in services],
            tail=tail,
            build_mode=build_mode,
        )
        return jsonify({"ok": True, "task": task.to_dict()})
    except KeyError:
        return jsonify({"ok": False, "error": "stack not found"}), 404
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/tasks/<task_id>")
def api_task(task_id: str):
    task = manager.get_task(task_id)
    if task is None:
        return jsonify({"error": "task not found"}), 404
    return jsonify(task.to_dict())


@app.get("/api/tasks")
def api_tasks():
    return jsonify({"tasks": manager.recent_tasks()})


if __name__ == "__main__":
    import os

    port = int(os.environ.get("STACK_PANEL_PORT", "5770"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
