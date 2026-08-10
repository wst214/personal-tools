"""Issue 1：操作台骨架与 PERF 同款界面。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def test_shell_files_exist():
    assert (WEB / "index.html").is_file()
    assert (WEB / "style.css").is_file()
    assert (WEB / "app.js").is_file()
    assert (WEB / "server.py").is_file()


def test_ui_has_perf_style_and_tabs():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    case_store = (WEB / "case_store.py").read_text(encoding="utf-8")
    assert "功能测试操作台" in html
    assert 'data-page="env"' in html
    assert 'data-page="cases"' in html
    assert 'data-page="run"' in html
    assert 'data-page="history"' in html
    assert "--accent: #0d6b54" in css
    assert ".page-tab" in css
    assert ".panel" in css
    assert "获取凭证" in html
    assert "当前凭证" in html
    assert "网关根地址" in html
    assert "服务前缀" in html
    assert "判定条件" in case_store
    assert "预警抑制管理" in case_store
    assert "用例文件" in case_store
    assert "模块" in html
    assert "env-layout" in css
    assert 'id="moduleNav"' in html
    assert 'id="caseCardList"' in html


def test_server_serves_index(tmp_path):
    import threading
    import urllib.request
    import sys

    sys.path.insert(0, str(WEB))
    from server import Handler
    from http.server import ThreadingHTTPServer

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as resp:
            body = resp.read().decode("utf-8")
            assert resp.status == 200
            assert "功能测试操作台" in body
            assert "panel" in (WEB / "style.css").read_text(encoding="utf-8")
    finally:
        httpd.shutdown()
