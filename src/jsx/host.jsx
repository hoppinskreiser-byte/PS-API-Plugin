// AI 改图工作台 - ExtendScript host (CEP ScriptPath 自动加载)
// 注意：ExtendScript 为 ES3 引擎，无原生 JSON，所有返回用手工拼接的 JSON 字符串
// JSON 规范要求"键名"也必须带双引号，PSAI_jsstr 用于值的转义，键名直接以 \" 写死
// 入口：PSAI_docInfo / PSAI_exportRef / PSAI_place / PSAI_placeAt
//       PSAI_listGroups / PSAI_exportGroup（导出图层组为图片）
// 返回：{"ok":true,...} 或 {"ok":false,"err":"..."}（JSON 字符串）
//
// 定位要点（避免偏移）：
//  1) translate 必须显式带 px 单位，否则按文档标尺单位解释
//  2) 文档存在选区时 placeEvent 会吸附/裁剪置入内容，故置入前临时取消选区，完成后恢复
//  3) 缩放用等比，避免拉伸顶偏

function PSAI_jsstr(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c == "\\") out += "\\\\";
        else if (c == "\"") out += "\\\"";
        else if (c == "\n") out += "\\n";
        else if (c == "\r") out += "\\r";
        else if (c == "\t") out += "\\t";
        else out += c;
    }
    return "\"" + out + "\"";
}

function PSAI_err(e) {
    return "{\"ok\":false,\"err\":" + PSAI_jsstr(String(e)) + "}";
}

// 取选区边界（像素整数；无选区返回 null）
function PSAI_selBounds(doc) {
    try {
        var b = doc.selection.bounds;
        return {
            left: Math.round(b[0].as("px")),
            top: Math.round(b[1].as("px")),
            right: Math.round(b[2].as("px")),
            bottom: Math.round(b[3].as("px"))
        };
    } catch (e) {
        return null;
    }
}

// 临时取消选区；返回被取消的选区信息（无选区返回 null）
function PSAI_clearSel(doc) {
    var b = PSAI_selBounds(doc);
    if (b) {
        try { doc.selection.deselect(); } catch (e) {}
    }
    return b;
}

// 恢复选区
function PSAI_restoreSel(doc, b) {
    if (!b) return;
    try {
        doc.selection.select([
            [new UnitValue(b.left, "px"), new UnitValue(b.top, "px")],
            [new UnitValue(b.right, "px"), new UnitValue(b.top, "px")],
            [new UnitValue(b.right, "px"), new UnitValue(b.bottom, "px")],
            [new UnitValue(b.left, "px"), new UnitValue(b.bottom, "px")]
        ]);
    } catch (e) {}
}

function PSAI_docInfo(mode) {
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var w = doc.width.as("px");
        var h = doc.height.as("px");
        var out = "";
        if (mode == "selection") {
            var b = PSAI_selBounds(doc);
            if (b) {
                w = b.right - b.left;
                h = b.bottom - b.top;
                out = ",\"left\":" + b.left + ",\"top\":" + b.top +
                      ",\"right\":" + b.right + ",\"bottom\":" + b.bottom + ",\"hadSel\":true";
            } else {
                out = ",\"hadSel\":false";
            }
        }
        return "{\"ok\":true,\"w\":" + Math.round(w) + ",\"h\":" + Math.round(h) + out + "}";
    } catch (e) {
        return PSAI_err(e);
    }
}

// mode: doc / layer / selection
// selection 模式可传 4 个额外参数 rl, rt, rr, rb（面板算好的裁切矩形，像素），
// 不传则用当前选区边界
function PSAI_exportRef(mode, rl, rt, rr, rb) {
    var tmp = null;
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var stamp = (new Date()).getTime();
        tmp = Folder.temp.fsName + "\\" + "psai_ref_" + stamp + ".png";

        if (mode == "layer") {
            var lyr = doc.activeLayer;
            if (!lyr) return "{\"ok\":false,\"err\":\"no-layer\"}";
            var nd = app.documents.add(doc.width, doc.height, doc.resolution, "psai_ref", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            lyr.duplicate(nd, ElementPlacement.PLACEATBEGINNING);
            var po1 = new PNGSaveOptions();
            po1.compression = 6;
            nd.saveAs(File(tmp), po1, true);
            nd.close(SaveOptions.DONOTSAVECHANGES);
            return "{\"ok\":true,\"path\":" + PSAI_jsstr(tmp) +
                   ",\"w\":" + Math.round(doc.width.as("px")) +
                   ",\"h\":" + Math.round(doc.height.as("px")) + "}";
        }

        // doc / selection 模式：复制文档后导出，避免动原文档
        var rect = null;
        var extra = "";
        if (mode == "selection") {
            // 优先用面板传入的裁切矩形；否则用当前选区
            if (rl !== null && rl !== undefined && rr !== null && rr !== undefined) {
                rect = {
                    left: Math.round(Number(rl)), top: Math.round(Number(rt)),
                    right: Math.round(Number(rr)), bottom: Math.round(Number(rb))
                };
            } else {
                var sb = PSAI_selBounds(doc);
                if (sb) rect = sb;
            }
            if (!rect) return "{\"ok\":false,\"err\":\"no-selection\"}";
        }

        var dup = doc.duplicate();
        if (mode == "selection" && rect) {
            // 裁切必须带 px 单位，否则会按文档标尺单位解释
            try {
                dup.crop([
                    new UnitValue(rect.left, "px"), new UnitValue(rect.top, "px"),
                    new UnitValue(rect.right, "px"), new UnitValue(rect.bottom, "px")
                ]);
            } catch (eCrop) {
                dup.close(SaveOptions.DONOTSAVECHANGES);
                return "{\"ok\":false,\"err\":\"选区裁切失败: " + PSAI_jsstr(eCrop) + "\"}";
            }
            var cw = Math.round(dup.width.as("px"));
            var chh = Math.round(dup.height.as("px"));
            var ew = rect.right - rect.left;
            var eh = rect.bottom - rect.top;
            if (Math.abs(cw - ew) > 2 || Math.abs(chh - eh) > 2) {
                dup.close(SaveOptions.DONOTSAVECHANGES);
                return "{\"ok\":false,\"err\":\"选区裁切尺寸异常（期望 " + ew + "x" + eh +
                       "，实际 " + cw + "x" + chh + "）\"}";
            }
            extra = ",\"left\":" + rect.left + ",\"top\":" + rect.top +
                    ",\"right\":" + rect.right + ",\"bottom\":" + rect.bottom + ",\"hadSel\":true";
        }

        var po2 = new PNGSaveOptions();
        po2.compression = 6;
        dup.saveAs(File(tmp), po2, true);
        var w2 = Math.round(dup.width.as("px"));
        var h2 = Math.round(dup.height.as("px"));
        dup.close(SaveOptions.DONOTSAVECHANGES);
        return "{\"ok\":true,\"path\":" + PSAI_jsstr(tmp) + ",\"w\":" + w2 + ",\"h\":" + h2 + extra + "}";
    } catch (e) {
        try { if (tmp && File(tmp).exists) File(tmp).remove(); } catch (e2) {}
        return PSAI_err(e);
    }
}

// 常规置入：适配画布并居中（fit=true 时）
// visible=false 时置入后隐藏该图层（多张结果批量入图层用，避免遮挡主结果）
// name 可指定图层名，便于在图层面板区分 AI 结果
function PSAI_place(path, fit, visible, name) {
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var oldSel = PSAI_clearSel(doc);   // 防止 placeEvent 吸附到选区
        var d = new ActionDescriptor();
        d.putPath(charIDToTypeID("null"), new File(path));
        d.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("QCSa"));
        executeAction(charIDToTypeID("Plc "), d, DialogModes.NO);
        if (fit) {
            var lyr = doc.activeLayer;
            var dw = doc.width.as("px");
            var dh = doc.height.as("px");
            var b = lyr.bounds;
            var bw = b[2].as("px") - b[0].as("px");
            var bh = b[3].as("px") - b[1].as("px");
            if (bw > 0 && bh > 0) {
                var s = Math.min(dw / bw, dh / bh) * 100;
                if (Math.abs(s - 100) > 0.1) {
                    lyr.resize(s, s, AnchorPosition.MIDDLECENTER);
                }
                var b2 = lyr.bounds;
                var bw2 = b2[2].as("px") - b2[0].as("px");
                var bh2 = b2[3].as("px") - b2[1].as("px");
                var dx = (dw - bw2) / 2 - b2[0].as("px");
                var dy = (dh - bh2) / 2 - b2[1].as("px");
                if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
                    lyr.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
                }
            }
        }
        // 多张结果作为图层置入：可指定图层名与默认隐藏（不遮挡主结果）
        try {
            if (name) doc.activeLayer.name = String(name);
            if (visible === false) doc.activeLayer.visible = false;
        } catch (eNV) { }
        PSAI_restoreSel(doc, oldSel);
        return "{\"ok\":true,\"hadSel\":" + (oldSel ? "true" : "false") + "}";
    } catch (e) {
        return PSAI_err(e);
    }
}

// 按当前选区给活动图层添加"显示选区"的图层蒙版（用于羽化融合）
function PSAI_addMaskRevealSelection() {
    var d = new ActionDescriptor();
    d.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
    var r = new ActionReference();
    r.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
    d.putReference(charIDToTypeID("At  "), r);
    d.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlS"));
    executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
}

// 切回 RGB 复合通道
// 重要：doc.channels.add() 会把活动通道切到新建 Alpha 通道，
// 此时执行 placeEvent 会异常（实测产出 0x0 空图层，表现为"面板无任何反应"）
function PSAI_selectCompositeChannel() {
    var rr = new ActionReference();
    rr.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("RGB "));
    var rd = new ActionDescriptor();
    rd.putReference(charIDToTypeID("null"), rr);
    rd.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), rd, DialogModes.NO);
}

// 整图上下文局部重绘合成（对标创成式填充思路）：
// 1) 暂存文档当前选区形状  2) 置入整图结果并拉伸铺满画布
// 3) 以原选区形状加蒙版 → 选区内用 AI 结果，选区外保持原图
// 4) 恢复用户选区，便于连续多次生成
// shiftX/shiftY：模型输出相对参考图的整体位移（文档像素），补偿后内容与原图对齐
// fitMode: "stretch"=按画布比例恢复内容（默认，兼容模型拉伸适配）
//          "cover" =严格等比缩放到覆盖画布并居中（绝不拉伸，多余部分裁到画布外）
// rectLeft/rectTop/rectW/rectH > 0 时进入规划矩形模式：
// 上传图即该矩形裁切，模型按同比例输出，等比缩放到该矩形并原位贴回，最后用原选区形状蒙版
function PSAI_placeMasked(path, feather, shiftX, shiftY, fitMode, fineScaleX, fineScaleY,
                          rectLeft, rectTop, rectW, rectH) {
    var ch = null;
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var sb = PSAI_selBounds(doc);
        if (!sb) return "{\"ok\":false,\"err\":\"no-selection\"}";

        ch = doc.channels.add();
        doc.selection.store(ch);
        doc.selection.deselect();
        PSAI_selectCompositeChannel();     // 修复点1：必须切回复合通道

        var d = new ActionDescriptor();
        d.putPath(charIDToTypeID("null"), new File(path));
        d.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("QCSa"));
        executeAction(charIDToTypeID("Plc "), d, DialogModes.NO);
        var lyr = doc.activeLayer;
        if (!lyr) return "{\"ok\":false,\"err\":\"place-failed\"}";

        // 规划矩形模式判定（面板以框选为基础外扩成模型标准比例后传入）
        var rw = Number(rectW) || 0;
        var rh = Number(rectH) || 0;
        var rl = Number(rectLeft), rt = Number(rectTop);
        var rectMode = (rw > 0 && rh > 0 && !isNaN(rl) && !isNaN(rt));

        var dw = doc.width.as("px");
        var dh = doc.height.as("px");
        var b = lyr.bounds;
        var bw = b[2].as("px") - b[0].as("px");
        var bh = b[3].as("px") - b[1].as("px");
        if (bw <= 0 || bh <= 0) {
            return "{\"ok\":false,\"err\":\"placed-empty(" + Math.round(bw) + "x" + Math.round(bh) + ")\"}";
        }
        var coverMode = false;
        var sx, sy;
        if (rectMode) {
            // 将完整输出坐标映射回实际上传矩形，两轴都必须参与。
            // API 可能归一化输出比例；只按宽度缩放会把纵向内容贴错位置。
            sx = rw / bw * 100;
            sy = rh / bh * 100;
        } else {
            coverMode = (String(fitMode) === "cover");
            if (coverMode) {
                var sc = Math.max(dw / bw, dh / bh) * 100;   // 等比覆盖，绝不变形
                sx = sc; sy = sc;
            } else {
                sx = dw / bw * 100;                          // 按画布比例恢复
                sy = dh / bh * 100;
            }
        }
        if (Math.abs(sx - 100) > 0.05 || Math.abs(sy - 100) > 0.05) {
            lyr.resize(sx, sy, AnchorPosition.TOPLEFT);
        }
        if (!rectMode) {
            var b2 = lyr.bounds;
            var bw2 = b2[2].as("px") - b2[0].as("px");
            var bh2 = b2[3].as("px") - b2[1].as("px");
            var dx, dy;
            if (coverMode) {
                dx = (dw - bw2) / 2 - b2[0].as("px");        // 居中（超出部分落在画布外）
                dy = (dh - bh2) / 2 - b2[1].as("px");
            } else {
                dx = 0 - b2[0].as("px");                     // 铺满 (0,0)
                dy = 0 - b2[1].as("px");
            }
            if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
                lyr.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
            }
        }

        // 精细缩放：抵消拉伸带来的残余变形（配准测得，围绕中心缩放）
        var fsx = Number(fineScaleX), fsy = Number(fineScaleY);
        var fineApplied = false;
        if (!isNaN(fsx) && !isNaN(fsy) &&
            (Math.abs(fsx - 1) > 0.0005 || Math.abs(fsy - 1) > 0.0005)) {
            var fb = lyr.bounds;
            var fbw = fb[2].as("px") - fb[0].as("px");
            var fbh = fb[3].as("px") - fb[1].as("px");
            if (fbw > 0 && fbh > 0 && fsx > 0.5 && fsx < 2 && fsy > 0.5 && fsy < 2) {
                lyr.resize(fsx * 100, fsy * 100, AnchorPosition.MIDDLECENTER);
                fineApplied = true;
            }
        }

        // 位移补偿：image-to-image 模型会有整体像素漂移，按面板检测值平移回来
        var mdx = Number(shiftX);
        var mdy = Number(shiftY);
        var shiftApplied = false;
        if (!rectMode && !isNaN(mdx) && !isNaN(mdy) && (Math.abs(mdx) > 0.1 || Math.abs(mdy) > 0.1)) {
            lyr.translate(new UnitValue(mdx, "px"), new UnitValue(mdy, "px"));
            shiftApplied = true;
        }
        // 矩形模式：最终对齐到"规划矩形左上角 + 检测到的位移补偿"
        if (rectMode) {
            var offX = isNaN(mdx) ? 0 : mdx;
            var offY = isNaN(mdy) ? 0 : mdy;
            var bf = lyr.bounds;
            var tx = rl + offX - bf[0].as("px");
            var ty = rt + offY - bf[1].as("px");
            if (Math.abs(tx) > 0.05 || Math.abs(ty) > 0.05) {
                lyr.translate(new UnitValue(tx, "px"), new UnitValue(ty, "px"));
                shiftApplied = true;
            }
        }

        // 载回选区形状 → 轻微羽化（仅消锯齿）→ 加"显示选区"蒙版
        doc.selection.load(ch);
        var fv = Number(feather);
        if (isNaN(fv) || fv < 0) fv = 0;
        if (fv > 0) {
            doc.selection.feather(new UnitValue(fv, "px"));
        }
        doc.activeLayer = lyr;
        PSAI_addMaskRevealSelection();
        doc.selection.deselect();

        // 合成结果校验：可见范围必须非空，否则明确报错（不再静默产出不可见图层）
        var b3 = lyr.bounds;
        var vw = Math.round(b3[2].as("px") - b3[0].as("px"));
        var vh = Math.round(b3[3].as("px") - b3[1].as("px"));
        if (vw <= 0 || vh <= 0) {
            return "{\"ok\":false,\"err\":\"mask-composite-empty\"}";
        }

        // 修复点2：恢复用户选区（不羽化），保证可以连续多次生成
        doc.selection.load(ch);
        ch.remove();
        ch = null;
        return "{\"ok\":true,\"masked\":true,\"feather\":" + fv +
               ",\"visibleW\":" + vw + ",\"visibleH\":" + vh +
               ",\"shiftApplied\":" + (shiftApplied ? "true" : "false") +
               ",\"fineApplied\":" + (fineApplied ? "true" : "false") +
               ",\"fitMode\":" + (coverMode ? "\"cover\"" : (rectMode ? "\"rect\"" : "\"stretch\"")) +
               ",\"rectMode\":" + (rectMode ? "true" : "false") +
               ",\"shiftX\":" + Math.round(mdx || 0) + ",\"shiftY\":" + Math.round(mdy || 0) +
               ",\"selLeft\":" + sb.left + ",\"selTop\":" + sb.top + "}";
    } catch (e) {
        try { if (ch) ch.remove(); } catch (e2) {}
        try { app.activeDocument.selection.deselect(); } catch (e3) {}
        return PSAI_err(e);
    }
}
function PSAI_placeAt(path, left, top, w, h, feather) {
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var oldSel = PSAI_clearSel(doc);   // 关键：置入前取消选区，避免吸附裁剪
        var d = new ActionDescriptor();
        d.putPath(charIDToTypeID("null"), new File(path));
        d.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("QCSa"));
        executeAction(charIDToTypeID("Plc "), d, DialogModes.NO);
        var lyr = doc.activeLayer;
        var b = lyr.bounds;
        var bw = b[2].as("px") - b[0].as("px");
        var bh = b[3].as("px") - b[1].as("px");
        var sApplied = 1;
        if (bw > 0 && bh > 0 && w > 0 && h > 0) {
            var s = Math.min(w / bw, h / bh);   // 等比，取较小比例
            if (Math.abs(s - 1) > 0.001) {
                lyr.resize(s * 100, s * 100, AnchorPosition.MIDDLECENTER);
                sApplied = s;
            }
            var b2 = lyr.bounds;
            var bw2 = b2[2].as("px") - b2[0].as("px");
            var bh2 = b2[3].as("px") - b2[1].as("px");
            var cx = left + w / 2;
            var cy = top + h / 2;
            var dx = cx - (b2[0].as("px") + bw2 / 2);
            var dy = cy - (b2[1].as("px") + bh2 / 2);
            if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
                lyr.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
            }
        }

        // 羽化蒙版融合：内缩后羽化，边缘渐隐过渡，消除硬边色块感
        var fv = Number(feather);
        if (isNaN(fv)) fv = 0;
        var feathered = false;
        if (fv > 0 && w > 0 && h > 0) {
            try {
                var inset = Math.max(4, Math.round(fv / 2));
                var il = left + inset, it = top + inset;
                var ir = left + w - inset, ib = top + h - inset;
                if (ir > il + 1 && ib > it + 1) {
                    doc.selection.select([
                        [new UnitValue(il, "px"), new UnitValue(it, "px")],
                        [new UnitValue(ir, "px"), new UnitValue(it, "px")],
                        [new UnitValue(ir, "px"), new UnitValue(ib, "px")],
                        [new UnitValue(il, "px"), new UnitValue(ib, "px")]
                    ]);
                    doc.selection.feather(new UnitValue(fv, "px"));
                    doc.activeLayer = lyr;
                    PSAI_addMaskRevealSelection();
                    doc.selection.deselect();
                    feathered = true;
                }
            } catch (eM) { /* 蒙版失败不影响主流程 */ }
        }

        PSAI_restoreSel(doc, oldSel);
        var b3 = lyr.bounds;
        return "{\"ok\":true,\"scale\":" + Math.round(sApplied * 1000) / 1000 +
               ",\"feathered\":" + (feathered ? "true" : "false") +
               ",\"placedLeft\":" + Math.round(b3[0].as("px")) +
               ",\"placedTop\":" + Math.round(b3[1].as("px")) +
               ",\"placedW\":" + Math.round(b3[2].as("px") - b3[0].as("px")) +
               ",\"placedH\":" + Math.round(b3[3].as("px") - b3[1].as("px")) + "}";
    } catch (e) {
        return PSAI_err(e);
    }
}

// 返回当前文档所在目录（文档从未保存过则 path 为空字符串）
// 用途：导出组为图片时一键采用"文档目录"作为导出位置
function PSAI_docPath() {
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var full = "";
        try {
            if (doc.fullName) full = doc.fullName.fsName;
        } catch (eF) {}
        if (!full || full.indexOf(":") < 0) {
            return "{\"ok\":true,\"path\":\"\",\"name\":" + PSAI_jsstr(doc.name) + "}";
        }
        var f = new File(full);
        return "{\"ok\":true,\"path\":" + PSAI_jsstr(f.parent.fsName) + ",\"name\":" + PSAI_jsstr(doc.name) + "}";
    } catch (e) {
        return PSAI_err(e);
    }
}

// ================= 导出图层组为图片 =================
// 面板列出文档顶层图层组 → 用户勾选 → 每组导出一张图。
// 实现：先复制文档，在副本里只保留目标组可见（其余顶层内容全隐藏），
// 按需裁到组内容边界，再另存为 PNG/JPG，最后关闭副本——原文档全程不被修改。

// 列出顶层图层组：idx（与 doc.layers 索引一致，0 = 图层面板最上层）、
// name、visible、内容尺寸 w/h（组内图层全隐藏时为 0）、
// count/children：组内**直接子项**（图层或子组）——供"组内每项各导一张"使用
function PSAI_listGroups() {
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var items = [];
        for (var i = 0; i < doc.layers.length; i++) {
            var l = doc.layers[i];
            if (l.typename !== "LayerSet") continue;
            var gw = 0, gh = 0;
            try {
                var gb = l.bounds;
                if (gb && gb.length === 4) {
                    gw = Math.round(gb[2].as("px") - gb[0].as("px"));
                    gh = Math.round(gb[3].as("px") - gb[1].as("px"));
                }
            } catch (eB) {}
            if (!(gw > 0)) gw = 0;
            if (!(gh > 0)) gh = 0;

            var kids = [];
            try {
                for (var c = 0; c < l.layers.length; c++) {
                    var k = l.layers[c];
                    var kw = 0, kh = 0;
                    try {
                        var kb = k.bounds;
                        if (kb && kb.length === 4) {
                            kw = Math.round(kb[2].as("px") - kb[0].as("px"));
                            kh = Math.round(kb[3].as("px") - kb[1].as("px"));
                        }
                    } catch (eKb) {}
                    if (!(kw > 0)) kw = 0;
                    if (!(kh > 0)) kh = 0;
                    kids.push("{\"name\":" + PSAI_jsstr(k.name) +
                              ",\"kind\":" + PSAI_jsstr(k.typename === "LayerSet" ? "group" : "layer") +
                              ",\"visible\":" + (k.visible ? "true" : "false") +
                              ",\"w\":" + kw + ",\"h\":" + kh + "}");
                }
            } catch (eKids) {}

            items.push("{\"idx\":" + i + ",\"name\":" + PSAI_jsstr(l.name) +
                       ",\"visible\":" + (l.visible ? "true" : "false") +
                       ",\"w\":" + gw + ",\"h\":" + gh +
                       ",\"count\":" + kids.length +
                       ",\"children\":[" + kids.join(",") + "]}");
        }
        return "{\"ok\":true,\"count\":" + items.length +
               ",\"docW\":" + Math.round(doc.width.as("px")) +
               ",\"docH\":" + Math.round(doc.height.as("px")) +
               ",\"groups\":[" + items.join(",") + "]}";
    } catch (e) {
        return PSAI_err(e);
    }
}

// 导出单个组（idx 为 doc.layers 索引，须先用 PSAI_listGroups 取到）
// format: "png"（保留透明）/ "jpg"；quality: 1~100（仅 jpg，内部换算成 PS 的 0~12 档）
// trimToContent: 1 = 裁到内容边界，0 = 保持画布范围（各图尺寸一致）
// outPath: 输出文件完整路径
// scopeIndex: -1 = 整组合成一张；>=0 = 只导出组内第 scopeIndex 个直接子项（组内每项一张）
function PSAI_exportGroup(idx, format, quality, trimToContent, outPath, scopeIndex) {
    var dup = null;
    try {
        var doc = app.activeDocument;
        if (!doc) return "{\"ok\":false,\"err\":\"no-doc\"}";
        var wantIdx = Number(idx);
        if (!(wantIdx >= 0) || wantIdx !== Math.floor(wantIdx) || wantIdx >= doc.layers.length) {
            return "{\"ok\":false,\"err\":\"组索引已变化，请重新点「读取文档中的组」\"}";
        }
        var src = doc.layers[wantIdx];
        if (!src || src.typename !== "LayerSet") {
            return "{\"ok\":false,\"err\":\"该位置已不是图层组，请重新点「读取文档中的组」\"}";
        }
        var dw = Math.round(doc.width.as("px"));
        var dh = Math.round(doc.height.as("px"));

        var sub = (scopeIndex === null || scopeIndex === undefined || scopeIndex === "")
                  ? -1 : Number(scopeIndex);
        var useSub = (!isNaN(sub) && sub >= 0);
        if (useSub && (!src.layers || sub >= src.layers.length)) {
            return "{\"ok\":false,\"err\":\"组内子项索引已变化，请重新点「读取文档中的组」\"}";
        }

        dup = doc.duplicate();                    // 全程副本操作，不动原文档
        var target = null;
        for (var i = 0; i < dup.layers.length; i++) {
            var l = dup.layers[i];
            if (i === wantIdx) { l.visible = true; target = l; }
            else l.visible = false;               // 其余顶层内容隐藏，保证导出干净
        }
        if (!target) return "{\"ok\":false,\"err\":\"副本中找不到该组\"}";

        // 组内每项一张：只显示指定子项（其余子项隐藏，组结构与组级效果保持原样）
        var boundObj = target;
        if (useSub) {
            for (var c = 0; c < target.layers.length; c++) {
                target.layers[c].visible = (c === sub);
            }
            boundObj = target.layers[sub];
        }
        try { dup.selection.deselect(); } catch (eS) {}    // 有选区时 crop 可能异常

        // 内容为空（子项/组内图层全隐藏）提前报错，避免导出空白图
        var tb = null;
        try { tb = boundObj.bounds; } catch (eTb) {}
        var hasContent = false;
        if (tb && tb.length === 4) {
            hasContent = ((tb[2].as("px") - tb[0].as("px")) >= 1 &&
                          (tb[3].as("px") - tb[1].as("px")) >= 1);
        }
        if (!hasContent) {
            dup.close(SaveOptions.DONOTSAVECHANGES);
            dup = null;
            return "{\"ok\":false,\"err\":\"" + (useSub ? "该子项内容为空" : "该组内容为空或组内图层全部隐藏") + "\"}";
        }

        if (Number(trimToContent) === 1) {
            // 裁切边界必须带 px 单位，且钳制在画布内（越界会报错）
            var lf = Math.floor(tb[0].as("px")), tf = Math.floor(tb[1].as("px"));
            var rt = Math.ceil(tb[2].as("px")), bt = Math.ceil(tb[3].as("px"));
            lf = Math.max(0, Math.min(dw - 1, lf));
            tf = Math.max(0, Math.min(dh - 1, tf));
            rt = Math.min(dw, Math.max(lf + 1, rt));
            bt = Math.min(dh, Math.max(tf + 1, bt));
            dup.crop([
                new UnitValue(lf, "px"), new UnitValue(tf, "px"),
                new UnitValue(rt, "px"), new UnitValue(bt, "px")
            ]);
        }

        var fmt = String(format || "png").toLowerCase();
        if (fmt === "jpg" || fmt === "jpeg") {
            var q = Number(quality);
            if (!(q >= 1 && q <= 100)) q = 90;
            var jo = new JPEGSaveOptions();
            jo.quality = Math.max(0, Math.min(12, Math.round(q / 100 * 12)));
            jo.embedColorProfile = true;
            dup.saveAs(new File(outPath), jo, true);
        } else {
            var po = new PNGSaveOptions();
            po.compression = 6;
            po.interlaced = false;
            dup.saveAs(new File(outPath), po, true);
        }
        var ow = Math.round(dup.width.as("px"));
        var oh = Math.round(dup.height.as("px"));
        dup.close(SaveOptions.DONOTSAVECHANGES);
        dup = null;
        return "{\"ok\":true,\"w\":" + ow + ",\"h\":" + oh +
               ",\"path\":" + PSAI_jsstr(outPath) + "}";
    } catch (e) {
        try { if (dup) dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        return PSAI_err(e);
    }
}
