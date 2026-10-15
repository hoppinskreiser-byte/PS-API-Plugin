from pathlib import Path
import zipfile, hashlib
import os, sys
root=Path(__file__).resolve().parents[1]
ver=(sys.argv[1] if len(sys.argv)>1 else os.environ.get('DONGPS_VERSION','1.9.2'))
folder=root/'dist'/('DongPS_CEP_v'+ver+'_Protected')
archive=folder.parent/(folder.name+'.zip')
if archive.exists():
    raise SystemExit('Archive exists; refusing overwrite')
files=sorted(p for p in folder.rglob('*') if p.is_file())
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in files:z.write(p,Path(folder.name)/p.relative_to(folder))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert len(z.infolist())==12   # 8 插件文件 + install.ps1 + Install.bat + 安装说明.txt + 使用说明.txt
    for name in ['软件声明.txt','mm_facetoface_collect_qrcode_1789623023799.png','1789623042991.jpg']:
        assert z.read(folder.name+'/com.lx.psai.workbench/assets/sponsor/'+name)==(root/'src'/'assets'/'sponsor'/name).read_bytes()
    for p in files:
        name=(Path(folder.name)/p.relative_to(folder)).as_posix()
        assert z.read(name)==p.read_bytes()
    bat=z.read(folder.name+'/Install.bat')
    assert b'\r\n' in bat and b'\n' not in bat.replace(b'\r\n',b'')
    assert z.read(folder.name+'/com.lx.psai.workbench/jsx/host.jsxbin').startswith(b'@JSXBIN@')
    assert b'./jsx/host.jsxbin' in z.read(folder.name+'/com.lx.psai.workbench/CSXS/manifest.xml')
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(digest+'  '+archive.name+'\n',encoding='ascii')
print(f'ZIP VERIFIED: {archive}')
print(f'Files: {len(files)}; size: {archive.stat().st_size:,} bytes')
print('SHA256: '+digest)
