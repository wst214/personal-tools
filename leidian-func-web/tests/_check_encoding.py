from pathlib import Path

web = Path(__file__).resolve().parents[1] / "web"
test = Path(__file__).resolve().parent / "test_shell.py"
text = test.read_text(encoding="utf-8")
cs = (web / "case_store.py").read_text(encoding="utf-8")
html = (web / "index.html").read_text(encoding="utf-8")
print("获取凭证 in html", "获取凭证" in html)
print("判定条件 in cs", "判定条件" in cs)
print("预警抑制管理 in cs", "预警抑制管理" in cs)
print("line29", text.splitlines()[28])
