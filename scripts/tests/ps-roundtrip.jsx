(function(){
var original=app.activeDocument, test=null, res=null;
var root=File($.fileName).parent.parent;
var dir=new Folder(root.fsName+'/tests/artifacts');dir.create();
var out=[];
try {
 $.evalFile(new File(root.fsName+'/jsx/host.jsx'));
 test=app.open(new File('E:/tool/Hermes Agent CN Desktop/data/hermes-home/images/upload_20260917_124820_2.png'));
 test.resizeCanvas(new UnitValue(649,'px'),new UnitValue(492,'px'),AnchorPosition.MIDDLECENTER);
 test.selection.select([[100,100],[549,100],[549,392],[100,392]]);
 var png=new PNGSaveOptions();
 test.saveAs(new File(dir.fsName+'/before.png'),png,true);
 var ref=eval('('+PSAI_exportRef('selection',100,100,549,392)+')');
 if(!ref.ok)throw Error(ref.err);
 res=app.open(new File(ref.path));
 // Deliberately emulate an API normalizing output to a different aspect ratio.
 // Identity case: retain the exported pixels and their original dimensions.
 var result=new File(dir.fsName+'/api-resized-fixture.png');
 res.saveAs(result,png,true);res.close(SaveOptions.DONOTSAVECHANGES);res=null;
 new File(ref.path).remove(); app.activeDocument=test;
 var placed=eval('('+PSAI_placeMasked(result.fsName,0,0,0,'stretch',1,1,100,100,449,292)+')');
 if(!placed.ok)throw Error(placed.err);
 test.saveAs(new File(dir.fsName+'/after.png'),png,true);
 var r=new ActionReference();r.putEnumerated(stringIDToTypeID('layer'),stringIDToTypeID('ordinal'),stringIDToTypeID('targetEnum'));
 var sm=executeActionGet(r).getObjectValue(stringIDToTypeID('smartObjectMore'));
 var t=sm.getList(stringIDToTypeID('transform'));
 var w=t.getDouble(2)-t.getDouble(0),h=t.getDouble(5)-t.getDouble(1);
 out.push('target=449x292 actual='+w+'x'+h);
 if(Math.abs(w-449)>1||Math.abs(h-292)>1)throw Error('RETURN_RECTANGLE_MISMATCH');
 var sb=PSAI_selBounds(test);if(!sb||sb.left!==100||sb.bottom!==392)throw Error('SELECTION_NOT_RESTORED');
 out.push('PASS: Photoshop placement dimensions and selection restored');
} catch(e){out.push('FAIL: '+e);} finally {
 try{if(res)res.close(SaveOptions.DONOTSAVECHANGES)}catch(e){}
 try{if(test)test.close(SaveOptions.DONOTSAVECHANGES)}catch(e){}
 app.activeDocument=original;
}
return out.join('\n');
})();