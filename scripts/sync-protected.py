# -*- coding: utf-8 -*-
# 按版本号同步保护版到 PS 安装目录：备份 → 覆盖 → MD5 校验 → 发布件复制到项目根
import os, sys, shutil, hashlib, datetime

ver = sys.argv[1] if len(sys.argv) > 1 else "1.9.10"
BUILD = r"D:\D\PS插件\dist\DongPS_CEP_v%s_Protected\com.lx.psai.workbench" % ver
DEST  = r"C:\Users\Administrator\AppData\Roaming\Adobe\CEP\extensions\com.lx.psai.workbench"
ROOT  = r"D:\D\PS插件"
DIST  = r"D:\D\PS插件\dist"

files = [
    "main.js", "index.html", "style.css",
    r"CSXS\manifest.xml", r"jsx\host.jsxbin",
    r"assets\sponsor\软件声明.txt",
    r"assets\sponsor\mm_facetoface_collect_qrcode_1789623023799.png",
    r"assets\sponsor\1789623042991.jpg",
]

def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

out = []
ts = datetime.datetime.now().strftime("%Y%m%d-%H%M")
bak = os.path.join(os.path.dirname(DEST), "backup_com.lx.psai.workbench_" + ts)
if os.path.exists(bak):
    bak = bak + "_b"
shutil.copytree(DEST, bak)
out.append("BACKUP: " + bak)

for rel in files:
    src = os.path.join(BUILD, rel)
    dst = os.path.join(DEST, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)

ok = True
for rel in files:
    a = md5(os.path.join(BUILD, rel))
    b = md5(os.path.join(DEST, rel))
    if a != b:
        ok = False
    out.append(("OK  " if a == b else "DIFF") + " " + rel + " " + a[:8])

for name in ["DongPS_CEP_v%s_Protected.zip" % ver, "DongPS_CEP_v%s_Protected.zip.sha256" % ver]:
    shutil.copy2(os.path.join(DIST, name), os.path.join(ROOT, "releases", name))
    out.append("PUBLISH: " + os.path.join(ROOT, "releases", name))

out.append("ALL_MATCH" if ok else "MISMATCH_FOUND")
with open(r"D:\D\PS插件\tools\dev\sync_result.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("DONE")
