(function(){
var d=app.activeDocument, a=[];
a.push('document='+d.name+' '+d.width.as('px')+'x'+d.height.as('px'));
try{a.push('selection='+d.selection.bounds.toString())}catch(e){a.push('selection=none')}
a.push('active='+d.activeLayer.name);
for(var i=0;i<Math.min(8,d.layers.length);i++){var l=d.layers[i];a.push('layer='+l.name+' visible='+l.visible+' bounds='+l.bounds.toString())}
var r=new ActionReference();r.putEnumerated(stringIDToTypeID('layer'),stringIDToTypeID('ordinal'),stringIDToTypeID('targetEnum'));
var desc=executeActionGet(r);
if(desc.hasKey(stringIDToTypeID('smartObjectMore'))){var s=desc.getObjectValue(stringIDToTypeID('smartObjectMore'));a.push('smartObject='+s.toStream().length);var k=stringIDToTypeID('transform');if(s.hasKey(k)){var t=s.getList(k),v=[];for(var j=0;j<t.count;j++)v.push(t.getDouble(j));a.push('transform='+v.join(','));}k=stringIDToTypeID('size');if(s.hasKey(k)){var z=s.getObjectValue(k);a.push('source='+z.getDouble(stringIDToTypeID('width'))+'x'+z.getDouble(stringIDToTypeID('height')))}}
return a.join('\n');
})();