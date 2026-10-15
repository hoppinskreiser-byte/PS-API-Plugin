const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'../../src/main.js'),'utf8');
const c={require,document:{readyState:'loading',addEventListener(){}}};vm.createContext(c);
vm.runInContext(s.replace(/\}\)\(\);\s*$/,'globalThis.api={clampSize,buildBody};})();'),c);
try{
for(const [w,h] of [[1036,444],[444,1036],[449,292],[400,400],[6240,6240],[8000,4000]]){
 const size=c.api.clampSize(w,h), [x,y]=size.split('x').map(Number);
 const err=Math.abs((x/y)/(w/h)-1);
 console.log(`${w}x${h} -> ${size}, ratio error ${(err*100).toFixed(2)}%`);
 assert(err<0.02,'request must preserve crop ratio');
 assert(x>=720&&y>=720&&x<=6240&&y<=6240&&x*y>=921600&&x*y<=16777216,'API limits');
 const b=c.api.buildBody({endpoint:'https://apihub.agnes-ai.com/v1/images/generations',model:'agnes-image-2.5-flash'},'fixture',[],size);
 if(w===1036)assert.strictEqual(b.ratio,'21:9','wide crop must not become 16:9');
}
console.log('PASS: aspect ratio and API size limits');
}catch(e){console.error('FAIL: '+e.message);process.exitCode=1;}
