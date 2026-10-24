import json, time, urllib.request, urllib.error, sys, traceback, os

HOOK_TOKEN = open(r"G:\wechat-deepseek\data\workspace\state\hook\native-token.txt", encoding="utf-8").read().strip()
CONSOLE = "http://127.0.0.1:53661"
WAIT_SEC = int(os.environ.get("WAIT_SEC", "1800"))
EXPECT = os.environ.get("EXPECT_ACCOUNT", "wxid_579nqogdaa5n29").lower()


def get(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def hook_health():
    return get("http://127.0.0.1:30001/WeChatAgent/health", {"Authorization": "Bearer " + HOOK_TOKEN}, 8)


def console_token():
    return get(CONSOLE + "/api/info").get("token")


def post(url, data, token, timeout=60):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "x-console-token": token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


deadline = time.time() + WAIT_SEC
accounts = []
while time.time() < deadline:
    try:
        h = hook_health()
        accounts = h.get("databaseAccounts") or []
        if accounts and any(str(a).lower().startswith(EXPECT) for a in accounts):
            print("HOOK_LOGIN_OK", json.dumps(accounts, ensure_ascii=False), flush=True)
            break
        if accounts:
            print("HOOK_ACCOUNT_MISMATCH_WAITING", json.dumps(accounts, ensure_ascii=False), flush=True)
    except Exception as e:
        print("hook poll err:", e, flush=True)
    time.sleep(5)
else:
    print("TIMEOUT_WAITING_PHONE_CONFIRM", flush=True)
    sys.exit(2)

time.sleep(3)
try:
    tok = console_token()
    job = post(CONSOLE + "/api/jobs", {"action": "restart"}, tok)
    jid = (job or {}).get("job", {}).get("id") or (job or {}).get("id")
    print("RESTART_REQUESTED", jid, flush=True)
    end = time.time() + 180
    last = None
    while time.time() < end:
        st = get(CONSOLE + "/api/status", {"x-console-token": tok})
        lj = st.get("latestJob") or {}
        svc = {s.get("id"): s.get("ready") for s in (st.get("services") or [])}
        snapshot = (st.get("ready"), st.get("pendingApply"), json.dumps(svc, ensure_ascii=False), lj.get("state"))
        if snapshot != last:
            print("STATUS", snapshot, flush=True)
            last = snapshot
        if st.get("ready") and all(svc.values() if svc else [True]):
            break
        if lj.get("state") == "failed":
            print("JOB_FAILED", json.dumps(lj, ensure_ascii=False)[:800], flush=True)
            break
        time.sleep(5)
    print("DONE", flush=True)
except Exception:
    traceback.print_exc()
    sys.exit(3)
