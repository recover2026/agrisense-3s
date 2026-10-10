#!/usr/bin/env python3
"""经 GitHub REST API 推送（绕过 git 智能协议）。

背景：本机 HTTP_PROXY 到 github.com 的 CONNECT 隧道持续 502
（实测连推 22 次全失败），而 api.github.com 稳定 200。
git 推送走 github.com，REST 也走 github.com 的 /repos 接口但落在
api.github.com 上 —— 两者主机不同，这就是可绕过的原因。

流程（GitHub git data API）：
  1. 取远端 main 的 ref 与 commit
  2. 用本地 commit 的 tree 建 blob（只传变动的文件）
  3. 建 commit → 更新 ref
用法：python3 tools/push_via_api.py
"""
import base64, hashlib, json, os, subprocess, sys, time, urllib.request, urllib.error

REPO = "recover2026/agrisense-3s"
BRANCH = "main"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.github.com"


def cred():
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                         capture_output=True, text=True, timeout=30).stdout
    d = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v
    if "password" not in d:
        sys.exit("取不到 GitHub 凭据")
    return d["password"]


TOKEN = cred()


def api(method, path, body=None, raw=False, timeout=40):
    url = path if path.startswith("http") else API + path
    data = None
    headers = {"Authorization": "Bearer " + TOKEN,
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "agrisense-push"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last = None
    for attempt in range(5):                    # 退避重试：代理抖动是常态
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
                return payload if raw else (json.loads(payload) if payload else {})
        except urllib.error.HTTPError as e:
            body_txt = e.read()[:400].decode("utf-8", "replace")
            if e.code in (502, 503, 504):        # 代理/网关抖动 → 退避重试
                last = "HTTP %s %s" % (e.code, body_txt)
                time.sleep(3 * (attempt + 1))
                continue
            sys.exit("API 失败 %s %s\n%s" % (method, path, body_txt))
        except Exception as e:                   # 网络层失败 → 退避重试
            last = str(e)
            time.sleep(3 * (attempt + 1))
    sys.exit("API 重试 5 次仍失败：%s %s（%s）" % (method, path, last))


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=ROOT, timeout=60).stdout.strip()


def main():
    print("本地 HEAD:", sh("git", "rev-parse", "HEAD")[:12])
    # ⚠️ 一律以【API 查到的远端真实 SHA】为基线，不能用本地的 origin/main：
    #    git fetch 走 github.com，本机代理持续 502，本地 origin/main 长期陈旧
    #    （实测据此建 commit 会得到 422 "Update is not a fast forward"）。
    remote = api("GET", "/repos/%s/git/ref/heads/%s" % (REPO, BRANCH))
    remote_sha = remote["object"]["sha"]
    print("远端 main(API):", remote_sha[:12], " 本地 origin/main:", sh("git", "rev-parse", "origin/main")[:12])
    if remote_sha == sh("git", "rev-parse", "HEAD"):
        print("已是最新，无需推送"); return

    base_tree = api("GET", "/repos/%s/git/commits/%s" % (REPO, remote_sha))["tree"]["sha"]

    # 2. 建 blob：上传所有变更文件（相对 origin/main）
    changed = sh("git", "diff", "--name-only", remote_sha + "..HEAD").splitlines() \
        if sh("git", "cat-file", "-e", remote_sha + "^{commit}") else \
        sh("git", "diff", "--name-only", "HEAD~1..HEAD").splitlines()
    changed = [f for f in changed if f]
    print("变更文件数:", len(changed))
    tree_entries = []
    for f in changed:
        p = os.path.join(ROOT, f)
        if not os.path.exists(p):
            tree_entries.append({"path": f, "mode": "100644", "type": "blob", "sha": None})
            continue
        data = open(p, "rb").read()
        blob = api("POST", "/repos/%s/git/blobs" % REPO,
                   {"content": base64.b64encode(data).decode(), "encoding": "base64"})
        tree_entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("  ✓ blob", f, len(data), "B")

    # 3. 建 tree：以远端 tree 为基底，叠加变更
    tree = api("POST", "/repos/%s/git/trees" % REPO,
               {"base_tree": base_tree, "tree": tree_entries})
    # 4. 建 commit
    msg = sh("git", "log", "-1", "--format=%B").strip()
    commit = api("POST", "/repos/%s/git/commits" % REPO,
                 {"message": msg, "tree": tree["sha"], "parents": [remote_sha]})
    print("新 commit:", commit["sha"][:12])
    # 5. 更新 ref
    ref = api("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
              {"sha": commit["sha"], "force": False})
    print("PUSH_OK · 远端 main =", ref["object"]["sha"][:12])


if __name__ == "__main__":
    main()
