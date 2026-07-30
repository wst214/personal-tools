import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    "192.168.1.41",
    username="leidian",
    password="ld@2026#ubuntu",
    timeout=20,
    allow_agent=False,
    look_for_keys=False,
)
cmd = r"""
echo '=== procs ==='
ps -eo pid,etime,cmd | grep -E '[r]un_load|[p]ython.*(bench|server)' | head -20 || echo none
echo
echo '=== dm sessions ==='
export DM_HOME=/opt/dmdbms
export PATH=/opt/dmdbms/bin:$PATH
export LD_LIBRARY_PATH=/opt/dmdbms/bin
PW='Leidian@2026!'
disql -S "LEIDIAN_APP/\"${PW}\"@localhost:5236" <<'EOF'
SET SCHEMA PERF;
SELECT COUNT(*) AS sess_cnt FROM V$SESSIONS;
SELECT SESS_ID, STATE, SUBSTR(SQL_TEXT,1,120) AS sql_preview
FROM V$SESSIONS
WHERE SQL_TEXT IS NOT NULL AND ROWNUM <= 20;
EXIT;
EOF
"""
stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
print(stdout.read().decode("utf-8", "replace"))
err = stderr.read().decode("utf-8", "replace")
if err.strip():
    print("--- STDERR ---")
    print(err[-3000:])
client.close()
