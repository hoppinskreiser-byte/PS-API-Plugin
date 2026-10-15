const fs=require('fs'),path=require('path'),vm=require('vm'),Module=require('module');
const root=path.resolve(__dirname,'..');
const release=path.join(root,'dist','DongPS_CEP_v'+(process.env.DONGPS_VERSION||'1.9.27')+'_Protected');
const ext=path.join(release,'com.lx.psai.workbench');
const packed=fs.readFileSync(path.join(ext,'main.js'),'utf8');
let bound=false;
const ctx={require,document:{readyState:'loading',addEventListener(name,fn){if(name==='DOMContentLoaded'&&typeof fn==='function')bound=true;}}};
vm.createContext(ctx);vm.runInContext(packed,ctx,{timeout:10000});
if(!bound)throw Error('Protected panel failed startup');
console.log('PASS: actual protected main.js loads and registers init');
const instrumented=path.join(root,'tools/verification/instrumented.js');
for(const file of ['size-ratio-regression.js','local-repaint-regression.js']){
 const filename=path.join(root,'tests',file);
 let test=fs.readFileSync(filename,'utf8');
 test=test.replace(/fs\.readFileSync\(path\.join\(__dirname,[^;]+?\),\s*["']utf8["']\)/,`fs.readFileSync(${JSON.stringify(instrumented)},'utf8')`);
 // Obfuscated condition cannot be found by source regex; verify original guard separately.
 if(file==='local-repaint-regression.js'){
  test=test.replace('const guard = source.match(',`const guard = fs.readFileSync(${JSON.stringify(path.join(root,'main.js'))},'utf8').match(`);
 }
 const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(test,filename);
}
let hostTest=fs.readFileSync(path.join(root,'tests/ps-roundtrip.jsx'),'utf8');
hostTest=hostTest.replace("root.fsName+'/jsx/host.jsx'",JSON.stringify(path.join(ext,'jsx/host.jsxbin').replace(/\\/g,'/')));
hostTest=hostTest.replace(' $.evalFile(', ' PSAI_exportRef = undefined; PSAI_placeMasked = undefined; PSAI_selBounds = undefined;\n $.evalFile(');
fs.writeFileSync(path.join(root,'tests/ps-protected-roundtrip.jsx'),hostTest);
const names=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,entry.name);if(entry.isDirectory())walk(f);else names.push(path.relative(release,f).replace(/\\/g,'/'));}}walk(release);
const allowed=['Install.bat','install.ps1','安装说明.txt','com.lx.psai.workbench/CSXS/manifest.xml','com.lx.psai.workbench/index.html','com.lx.psai.workbench/style.css','com.lx.psai.workbench/main.js','com.lx.psai.workbench/jsx/host.jsxbin'];
for(const f of ['软件声明.txt','mm_facetoface_collect_qrcode_1789623023799.png','1789623042991.jpg']) allowed.push('com.lx.psai.workbench/assets/sponsor/'+f);
if(JSON.stringify(names.sort())!==JSON.stringify(allowed.sort()))throw Error('Release contains unexpected files');
const original=fs.readFileSync(path.join(root,'main.js'),'utf8');
const defaults=[...original.matchAll(/apikey\s*:\s*(["'])(.*?)\1/g)].map(m=>m[2]).filter(Boolean);
for(const secret of defaults)for(const n of names){const content=fs.readFileSync(path.join(release,n));if(content.includes(Buffer.from(secret)))throw Error('Credential found in release');}
console.log('PASS: release whitelist; no JSX source/config/tests/developer default credentials');
