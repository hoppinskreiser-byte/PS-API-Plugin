"use strict";
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const src=path.join(root,'src');
const obfuscator=require(path.join(root,'tools/node_modules/javascript-obfuscator'));
const jsxbin=require(path.join(root,'tools/node_modules/jsxbin'));
const version=process.env.DONGPS_VERSION||'1.9.2';
const output=path.join(root,'dist',`DongPS_CEP_v${version}_Protected`);
const ext=path.join(output,'com.lx.psai.workbench');
const options={target:'browser',compact:true,identifierNamesGenerator:'hexadecimal',renameGlobals:false,
 stringArray:true,stringArrayEncoding:['base64'],stringArrayThreshold:0.8,splitStrings:true,splitStringsChunkLength:12,
 controlFlowFlattening:false,deadCodeInjection:false,debugProtection:false,selfDefending:false,
 disableConsoleOutput:false,sourceMap:false,seed:191};
(async()=>{
 if(fs.existsSync(output))throw Error('Output exists; preserve prior release or move it before rebuilding: '+output);
 fs.mkdirSync(path.join(ext,'CSXS'),{recursive:true});fs.mkdirSync(path.join(ext,'jsx'),{recursive:true});
 let main=fs.readFileSync(path.join(src,'main.js'),'utf8');
 // Never distribute a developer credential, even obfuscated. Match only literal default values.
 main=main.replace(/(apikey\s*:\s*)(["'])(.*?)\2/g,'$1""');
 new vm.Script(main);
 const packed=obfuscator.obfuscate(main,options).getObfuscatedCode();new vm.Script(packed);
 fs.writeFileSync(path.join(ext,'main.js'),packed,'utf8');
 await jsxbin(path.join(src,'jsx/host.jsx'),path.join(ext,'jsx/host.jsxbin'));
 const bin=fs.readFileSync(path.join(ext,'jsx/host.jsxbin'),'utf8');
 if(!bin.startsWith('@JSXBIN@'))throw Error('JSXBIN conversion failed');
 let manifest=fs.readFileSync(path.join(src,'CSXS/manifest.xml'),'utf8')
  .replace(/ExtensionBundleVersion="[^"]+"/,`ExtensionBundleVersion="${version}"`)
  .replace('./jsx/host.jsx','./jsx/host.jsxbin');
 fs.writeFileSync(path.join(ext,'CSXS/manifest.xml'),manifest);
 const html=fs.readFileSync(path.join(src,'index.html'),'utf8').replace('v1.9</span>',`v${version} 保护版</span>`);
 fs.writeFileSync(path.join(ext,'index.html'),html);
 fs.copyFileSync(path.join(src,'style.css'),path.join(ext,'style.css'));
 const sponsorFiles=['软件声明.txt','mm_facetoface_collect_qrcode_1789623023799.png','1789623042991.jpg'];
 fs.mkdirSync(path.join(ext,'assets/sponsor'),{recursive:true});
 for(const f of sponsorFiles) fs.copyFileSync(path.join(src,'assets/sponsor',f),path.join(ext,'assets/sponsor',f));
 // Installer and documentation only: no recursive copying of source/config/tests.
 const installer=fs.readFileSync(path.join(__dirname,'install-protected.ps1'),'utf8');
 fs.writeFileSync(path.join(output,'install.ps1'),'\ufeff'+installer.replace(/\r?\n/g,'\r\n'),'utf8');
 fs.writeFileSync(path.join(output,'Install.bat'),[
 '@echo off','setlocal','powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"',
 'set "code=%errorlevel%"','if not "%code%"=="0" echo Installation failed.','pause','exit /b %code%',''].join('\r\n'),'ascii');
 fs.writeFileSync(path.join(output,'安装说明.txt'),[
 'DongPS v'+version+' 源码保护版（Windows Photoshop CEP）',
 '1. 完整解压到任意目录；保存文档后退出 Photoshop。',
 '2. 双击 Install.bat，成功后重新打开 Photoshop。',
 '3. 菜单：窗口 → 扩展（旧版）→ DongPS。',
 '4. 首次使用自行配置 API 端点 / Key / 模型；旧用户配置与预设保持不变。',
 '',
 '安装位置：%APPDATA%\\Adobe\\CEP\\extensions\\com.lx.psai.workbench',
 '如已安装旧版，安装器会移至 %APPDATA%\\DongPS\\plugin-backups 备份后安装。',
 '此包未签名，安装器会为当前用户开启 CSXS.9~13 PlayerDebugMode；需要信任此插件。',
 '保护：面板 JavaScript 混淆 + Adobe JSXBIN 脚本编译。不是不可逆加密，不承诺无法反编译。',
 '赞助区（软件声明 + 收款码）已内嵌在面板内，赞助自愿、不影响功能。',
 '不含明文业务源码、开发者 Key、用户配置、测试图片。',
 'API 调用可能产生费用，图像会发送到你配置的图像服务商。',
 '功能说明、配置步骤与常见报错处理：见同目录「使用说明.txt」。',''].join('\r\n'),'utf8');
 const manual=fs.readFileSync(path.join(root,'docs/使用说明.txt'),'utf8');
 fs.writeFileSync(path.join(output,'使用说明.txt'),'\ufeff'+manual.replace(/\r?\n/g,'\r\n'),'utf8');
 // Build test-only instrumented copy OUTSIDE the release to exercise protected functions.
 const injected=main.replace(/\}\)\(\);\s*$/,'globalThis.api = {exportRef, planUploadRect, searchPatch, clampSize, buildBody};})();');
 fs.mkdirSync(path.join(root,'tools/verification'),{recursive:true});
 fs.writeFileSync(path.join(root,'tools/verification/instrumented.js'),obfuscator.obfuscate(injected,options).getObfuscatedCode());
 console.log('BUILD OK: '+output);console.log('JS obfuscated; JSXBIN header verified; release whitelist applied');
})().catch(e=>{console.error(e.message);process.exitCode=1});
