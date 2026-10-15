"use strict";
// Offline behavioral tests: real panel functions, fake CEP/file boundaries; no API calls.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main.js"), "utf8");
const exposed = source.replace(/\}\)\(\);\s*$/, 'globalThis.api = {exportRef, planUploadRect, searchPatch};})();');
let sent = null;
const raw = {left: 400, top: 600, right: 1410, bottom: 1600};
const context = {
  Buffer, console,
  document: {readyState: "loading", addEventListener() {}, getElementById() {return {}; }},
  require(name) {
    if (name === "fs") return {readFileSync() {return Buffer.from("offline-fixture");}, unlinkSync() {}};
    return require(name);
  },
  window: {__adobe_cep__: {evalScript(code, cb) {
    if (code.includes('PSAI_docInfo("selection")')) return cb(JSON.stringify({ok:true, hadSel:true, ...raw}));
    if (code.includes('PSAI_docInfo("doc")')) return cb(JSON.stringify({ok:true, w:2048,h:3072}));
    const a = JSON.parse("[" + code.slice(code.indexOf("(")+1, -1) + "]");
    sent = a.slice(1);
    cb(JSON.stringify({ok:true, path:"fixture.png", left:sent[0],top:sent[1],right:sent[2],bottom:sent[3],w:sent[2]-sent[0],h:sent[3]-sent[1]}));
  }}}
};
vm.createContext(context); vm.runInContext(exposed, context);
(async () => {
  const plan = context.api.planUploadRect(raw, 2048, 3072);
  await context.api.exportRef("selection", plan);
  assert.deepStrictEqual(sent, [plan.left,plan.top,plan.right,plan.bottom], "exported rectangle must equal placement plan");
  console.log("PASS: actual export uses planned rectangle (near-square selection)");
  // A flat unchanged image has no measurable displacement. Old matcher picks the first
  // candidate (-maxShift) on ties, incorrectly reporting displacement with zero error.
  const image = {w:40,h:40,g:new Float32Array(1600).fill(128)};
  const match = context.api.searchPatch(image,image,10,10,20,20,4,2);
  assert.strictEqual(match.dx,0,"unchanged flat image must not shift horizontally");
  assert.strictEqual(match.dy,0,"unchanged flat image must not shift vertically");
  console.log("PASS: unchanged flat content does not generate a false displacement");
  // Exercise the actual alignment guard with the same UI values for both paths.
  const guard = source.match(/if \((\$\("autoAlign"\).*imageUris\.length[^\n]*)\) \{/)[1];
  const enabled = new Function("$", "imageUris", "uploadRect", "return " + guard);
  const checked = () => ({checked:true});
  assert.strictEqual(Boolean(enabled(checked,["reference"],plan)),false,"local repaint must not re-align changed content");
  assert.strictEqual(Boolean(enabled(checked,["reference"],null)),true,"non-rectangle guard remains available");
  console.log("PASS: local placement skips secondary alignment");
  for (const box of [
    {left:0,top:0,right:500,bottom:800},
    {left:1500,top:2600,right:2048,bottom:3072},
    {left:459,top:668,right:1393,bottom:1081}
  ]) {
    const p = context.api.planUploadRect(box,2048,3072);
    await context.api.exportRef("selection",p);
    assert.deepStrictEqual(sent,[p.left,p.top,p.right,p.bottom]);
  }
  console.log("PASS: edge and wide-selection export coordinates stay consistent");
})().catch(e => { console.error("FAIL: " + e.message); process.exitCode = 1; });
