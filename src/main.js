/* AI 改图工作台 - CEP 版主逻辑
 * 运行环境：Photoshop CEP（CEF + Node mixed context），PlayerDebugMode 已开启
 * PS 交互：evalScript -> jsx/host.jsx（导出参考图 / 置入结果）
 */
(function () {
  "use strict";

  var fs = null, osMod = null;
  try { fs = require("fs"); osMod = require("os"); } catch (e) { /* node 不可用时禁用本地 IO */ }

  var DEFAULTS = {
    endpoint: "",
    apikey: "",
    model: ""
  };
  var CFG_KEY = "psai.workbench.cfg";
  var resultBuf = null;   // 最近一次结果（Buffer/Uint8Array）
  var history = [];       // 会话内历史 {buf, prompt}

  // ---------- 基础工具 ----------
  function $(id) { return document.getElementById(id); }
  // 带存在性保护的事件绑定：任一元素缺失都不会中断后续绑定
  // （避免"某个控件找不到 → init 中断 → 点按钮无任何反应"）
  function bind(id, ev, fn) {
    var el = $(id);
    if (el) { el.addEventListener(ev, fn); }
  }
  // 折叠区块（*Toggle / *Body / *Arrow 三段式，class 用 card-body）
  function bindCollapse(base) {
    var head = $(base + "Toggle"), body = $(base + "Body"), arrow = $(base + "Arrow");
    if (!head || !body) return;
    var setLabel = function () {
      var collapsed = body.className.indexOf("collapsed") >= 0;
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (arrow) arrow.textContent = collapsed ? "展开" : "收起";
    };
    setLabel();
    head.addEventListener("click", function () {
      body.className = (body.className.indexOf("collapsed") >= 0) ? "card-body" : "card-body collapsed";
      setLabel();
    });
  }
  function log(msg, cls) {
    var s = $("status");
    s.textContent = msg || "";
    s.className = "status" + (cls ? " " + cls : "");
  }
  function round16(x) { return Math.max(16, Math.round(x / 16) * 16); }
  // 尺寸限制随模型变化（火山方舟 Seedream 官方文档）：
  // 4.0 / 4.5 / 5.0-lite：总像素 ≥ 3,686,400，且不支持 1K 档（只能 2K/3K/4K）
  // 3.0-t2i：单边 ≤ 2048、总像素 ≤ 4,194,304
  // 按填写的模型名动态取限，避免请求被服务端 400 拒绝
  function modelLower() { return ($("model") ? $("model").value : "").toLowerCase(); }
  function sizeLimits() {
    var md = modelLower();
    if (/seedream-(4|5)/.test(md)) return { MINP: 3686400, MAXP: 16777216, MINE: 720, MAXE: 6240 };
    if (/seedream-3/.test(md)) return { MINP: 921600, MAXP: 4194304, MINE: 512, MAXE: 2048 };
    return { MINP: 921600, MAXP: 16777216, MINE: 720, MAXE: 6240 };
  }
  function tierAllowed(tier) {
    var md = modelLower();
    if (/seedream-(4|5)/.test(md) && tier === "1K") return "2K";   // 4.0+ 无 1K 档
    return tier;
  }
  function clampSize(w, h) {
    var lim = sizeLimits();
    var MINP = lim.MINP, MAXP = lim.MAXP, MINE = lim.MINE, MAXE = lim.MAXE;
    w = Number(w); h = Number(h);
    if (!(w > 0 && h > 0) || !isFinite(w) || !isFinite(h)) throw new Error("输出尺寸无效");
    // 长短边必须统一缩放，禁止单独补高/补宽破坏裁切图的比例。
    var low = Math.max(MINE / w, MINE / h, Math.sqrt(MINP / (w * h)));
    var high = Math.min(MAXE / w, MAXE / h, Math.sqrt(MAXP / (w * h)));
    if (low > high) throw new Error("区域过于窄长，无法在模型尺寸限制内保持比例，请扩大选区短边");
    var scale = Math.min(high, Math.max(low, 1));
    var rw = Math.ceil(w * scale / 16) * 16;
    var rh = Math.ceil(h * scale / 16) * 16;
    if (rw > MAXE || rh > MAXE || rw * rh > MAXP) {
      rw = Math.floor(w * high / 16) * 16;
      rh = Math.floor(h * high / 16) * 16;
    }
    if (rw < MINE || rh < MINE || rw * rh < MINP) throw new Error("无法生成符合模型限制的同比例尺寸");
    return rw + "x" + rh;
  }
  // 从提示词解析"要出几张"：识别「N张 / N张图 / N个方案 / N个角度 / N images / N variants」等写法，
  // 中文数字支持 一~十（含"两"）；返回 0 表示提示词未指定张数
  function parsePromptCount(prompt) {
    var p = String(prompt || "");
    if (!p) return 0;
    var cn = { "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
    var max = 0;
    var re = /([0-9]+|[一二两三四五六七八九十])\s*(?:张|个方案|种方案|个角度|种角度|个视角|种视角|个方向|images?|variants?|options?|outputs?)/gi;
    var m;
    while ((m = re.exec(p))) {
      var n = parseInt(m[1], 10);
      if (isNaN(n)) n = cn[m[1]] || 0;
      if (n > max) max = n;
    }
    return max;
  }

  // 把提示词里的"要 N 张"计数措辞移除（张数改由请求表达），但**保留差异化意图**——
  // "不同角度/视角/风格"正是出多张不同图的关键，只把其中的数字换成"不同"，避免模型把多张画成一张拼版。
  function stripCountPhrases(prompt) {
    var p = String(prompt || "");
    var cleaned = p
      .replace(/(生成|输出|提供|帮我|画出|画|给|来|要|做|出)\s*[0-9一二两三四五六七八九十]+\s*张(图|照片|图片|画面)?/g, "")
      .replace(/[0-9一二两三四五六七八九十]+\s*个?(?=(?:角度|视角|方向|方案|风格))/g, "不同")
      .replace(/\b(?:generate|create|make|output|give me)\s+\d+\s+(?:images|variants|options|versions|outputs)\b/gi, "");
    cleaned = cleaned.trim().replace(/^[，。、；！？,.;!?]+\s*/, "").replace(/[，。、；\s]+$/, "");
    if (cleaned.length < 2) cleaned = String(p);   // 清洗后过短则保留原提示词
    return cleaned;
  }

  function copyText(t) {
    try {
      var ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
  function toDataUri(buf, mime) {
    var b64 = null;
    if (typeof Buffer !== "undefined" && buf instanceof Buffer) b64 = buf.toString("base64");
    else {
      var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      var s = "", CH = 0x8000;
      for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      b64 = btoa(s);
    }
    return "data:" + (mime || "image/png") + ";base64," + b64;
  }
  function bufFromB64(b64) {
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // ---------- evalScript 桥 ----------
  function evalJSX(code) {
    return new Promise(function (resolve, reject) {
      try {
        window.__adobe_cep__.evalScript(code, function (r) { resolve(r); });
      } catch (e) {
        reject(new Error("无法连接 PS 脚本引擎（请在 Photoshop 中使用本面板）"));
      }
    });
  }
  function parseJsx(r) {
    if (r === null || r === undefined || r === "EvalScript error.") {
      throw new Error("PS 脚本执行失败（host.jsx 未加载或语法错误）");
    }
    var j = null;
    try { j = JSON.parse(r); } catch (e) { j = null; }
    if (!j) {
      // 宽容解析：给未加引号的键名补双引号（防御旧格式）
      try {
        var fixed = String(r).replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
        j = JSON.parse(fixed);
      } catch (e2) { j = null; }
    }
    if (!j) throw new Error("PS 返回异常: " + String(r).slice(0, 200));
    if (!j.ok) throw new Error(j.err === "no-doc" ? "请先在 PS 中打开一个文档" : (j.err || "PS 操作失败"));
    return j;
  }

  // ---------- 配置持久化（文件优先，localStorage 兜底）----------
  // 背景：本机 CEP 的 localStorage 未落盘（%APPDATA%\Adobe\CEP 下无 Local Storage），
  // 面板在 PS 最小化/切回后重载时会丢配置，故改为写用户级配置文件。
  var pathMod = null;
  try { pathMod = require("path"); } catch (e) {}
  var CFG_FILE = null, CFG_DIR = null;
  try {
    var appDataDir = (typeof process !== "undefined" && process.env) ? process.env.APPDATA : null;
    if (appDataDir && pathMod) {
      CFG_DIR = pathMod.join(appDataDir, "DongPS");
      CFG_FILE = pathMod.join(CFG_DIR, "dongps_config.json");
    }
  } catch (e) {}

  function readCfgFile() {
    try {
      if (!fs || !CFG_FILE) return null;
      if (!fs.existsSync(CFG_FILE)) return null;
      return JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    } catch (e) { return null; }
  }
  function writeCfgFile(obj) {
    try {
      if (!fs || !CFG_FILE || !CFG_DIR) return false;
      if (!fs.existsSync(CFG_DIR)) fs.mkdirSync(CFG_DIR, { recursive: true });
      fs.writeFileSync(CFG_FILE, JSON.stringify(obj, null, 2), "utf8");
      return true;
    } catch (e) { return false; }
  }
  function cfgStorageNote() {
    return CFG_FILE ? ("配置文件: " + CFG_FILE) : "配置文件: 不可用（回退内存存储）";
  }

  // ---------- 配置 ----------
  function loadCfg() {
    var cfg = readCfgFile();                       // 1) 文件优先
    if (!cfg) {
      try { cfg = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { cfg = {}; }
    }
    $("endpoint").value = cfg.endpoint || DEFAULTS.endpoint;
    $("apikey").value = cfg.apikey || "";
    $("model").value = cfg.model || DEFAULTS.model;
    if (cfg.model) fillModelOptions([cfg.model]);   // 上次使用的模型进下拉，方便直接选
    presetStore = (cfg.presets && cfg.presets.length) ? cfg.presets : [];
    renderPresetOptions();
    applyUiState(cfg);                             // 界面状态一并恢复
    var el = $("cfgPath");
    if (el) {
      el.textContent = cfg.apikey ? "已配置" : "未配置 Key";
      el.title = cfgStorageNote();
    }
  }
  // 收集需要持久化的界面状态
  function collectState() {
    function val(id) { var e = $(id); return e ? e.value : ""; }
    function chk(id) { var e = $(id); return e ? !!e.checked : false; }
    return {
      endpoint: val("endpoint").trim(),
      apikey: val("apikey").trim(),
      model: val("model").trim(),
      presets: presetStore.slice(0, PRESET_MAX),
      ui: {
        refMode: val("refMode"),
        size: val("size"),
        count: val("count"),
        cw: val("cw"),
        ch: val("ch"),
        feather: val("feather"),
        fit: chk("fit"),
        asSO: chk("asSO"),
        autoAlign: chk("autoAlign"),
        forceStretch: chk("forceStretch"),
        prompt: val("prompt"),
        expFormat: val("expFormat"),
        expQuality: val("expQuality"),
        expTrim: val("expTrim"),
        expGran: val("expGran"),
        expDir: val("expDir")
      },
      savedAt: new Date().toISOString()
    };
  }
  function applyUiState(cfg) {
    var u = cfg && cfg.ui;
    if (!u) return;
    try {
      if (u.refMode && $("refMode")) $("refMode").value = u.refMode;
      if (u.size && $("size")) {
        $("size").value = u.size;
        if ($("customSizeRow")) $("customSizeRow").style.display = (u.size === "custom") ? "flex" : "none";
      }
      if (u.count && $("count")) $("count").value = u.count;
      if (u.cw && $("cw")) $("cw").value = u.cw;
      if (u.ch && $("ch")) $("ch").value = u.ch;
      if (u.feather && $("feather")) $("feather").value = u.feather;
      if ($("fit")) $("fit").checked = u.fit !== false;
      if ($("asSO")) $("asSO").checked = u.asSO !== false;
      if ($("autoAlign")) $("autoAlign").checked = u.autoAlign !== false;
      if ($("forceStretch")) $("forceStretch").checked = !!u.forceStretch;
      if (u.expFormat && $("expFormat")) {
        $("expFormat").value = u.expFormat;
        if ($("expQRow")) $("expQRow").style.display = (u.expFormat === "jpg") ? "flex" : "none";
      }
      if (u.expQuality && $("expQuality")) $("expQuality").value = u.expQuality;
      if (u.expTrim && $("expTrim")) $("expTrim").value = u.expTrim;
      if (u.expGran && $("expGran")) $("expGran").value = u.expGran;
      if (u.expDir && $("expDir")) $("expDir").value = u.expDir;
      if (u.prompt && $("prompt") && !$("prompt").value) $("prompt").value = u.prompt;
    } catch (e) {}
  }
  function persistNow(silent) {
    var st = collectState();
    var prev = readCfgFile() || {};
    if (prev.ui && st.ui && prev.ui.prompt && !st.ui.prompt) st.ui.prompt = prev.ui.prompt;
    var okFile = writeCfgFile(st);
    try { localStorage.setItem(CFG_KEY, JSON.stringify(st)); } catch (e) {}
    if (!silent) {
      var el = $("cfgSaved");
      if (el) {
        el.textContent = okFile ? "已保存到文件" : "已保存（内存）";
        el.style.visibility = "visible";
        setTimeout(function () { el.style.visibility = "hidden"; }, 1800);
      }
    }
    return okFile;
  }
  function saveCfg() {
    var ep = $("endpoint").value.trim();
    if (ep) {
      // 不改写用户填的 URL（旧逻辑会把阿里云地址改写成多模态端点，导致重启后无法再识别）。
      // 生成时按端点动态路由：DashScope 走原生协议，其余走 OpenAI 兼容格式。
      ep = asGenerateUrl(ep);
      $("endpoint").value = ep;
    }
    persistNow(false);
  }

  // ---------- 端点规范化与模型自动识别 ----------
  function normalizeBase(ep) {
    var u = (ep || "").trim().replace(/\/+$/, "");
    u = u.replace(/\/(images\/generations|generations|generation|generate|chat\/completions|completions|embeddings|models|images\/edits|images)$/i, "");
    return u;
  }
  // 通用端点解析：用户粘贴的若已是生成类路径则原样使用（尊重各平台路径差异），
  // 否则去掉对话/向量类后缀后补标准图像生成路径
  function asGenerateUrl(ep) {
    var u = (ep || "").trim().replace(/\/+$/, "");
    if (/\/(images\/generations|images\/edits|generations|generation|generate)$/i.test(u)) return u;
    return normalizeBase(u) + "/images/generations";
  }
  var IMG_KEYWORDS = [
    "seedream", "seededit", "image", "img", "diffusion", "kolors", "flux",
    "dall", "wanx", "cogview", "stable", "banana", "imagen", "recraft",
    "ideogram", "irag", "z-image", "hidream", "imagine", "photon", "muse"
  ];
  function isImageModel(id) {
    var low = (id || "").toLowerCase();
    for (var i = 0; i < IMG_KEYWORDS.length; i++) {
      if (low.indexOf(IMG_KEYWORDS[i]) >= 0) return true;
    }
    return false;
  }
  async function detectModels() {
    var raw = $("endpoint").value.trim();
    var key = $("apikey").value.trim();
    if (!raw) return log("请先填写 API 端点", "err");
    if (!key) return log("请先填写 API Key 再识别", "err");
    var info = $("detectInfo");
    info.style.visibility = "hidden";

    // 纯接口识别：结果只来自接口返回，不掺任何本地/内置清单
    var base = normalizeBase(raw);
    var listUrl;
    if (isDashScopeUrl(raw)) {
      if (/compatible-mode/i.test(raw)) {
        listUrl = raw.replace(/\/images\/generations.*$/i, "").replace(/\/+$/, "") + "/models";
      } else {
        return log("提示：阿里云 DashScope 协议端点不提供模型列表接口（该路径仅支持 POST 生成），并非故障。\n" +
                   "做法：在「模型 ID」里直接填入模型名（用过会自动记入输入框下拉），" +
                   "例如 qwen-image-3.0-pro；或改用 OpenAI 兼容模式端点后再识别。");
      }
    } else {
      listUrl = base + "/models";
    }

    log("正在请求模型列表 " + listUrl + " ...");
    try {
      var resp = await fetch(listUrl, { headers: { "Authorization": "Bearer " + key } });
      var text = await resp.text();
      if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + text.slice(0, 150));
      var j = JSON.parse(text);
      var ids = (j.data || j.models || []).map(function (mo) {
        return (mo && (mo.id || mo.model || mo.name)) || "";
      }).filter(Boolean);
      if (!ids.length) throw new Error("接口返回的列表为空");
      var imgs = ids.filter(isImageModel);
      // 图像类排前面，其余按接口顺序，全部写入模型输入框的下拉
      var ordered = imgs.length ? imgs.concat(ids.filter(function (x) { return imgs.indexOf(x) < 0; })) : ids;
      fillModelOptions(ordered);
      $("endpoint").value = asGenerateUrl(raw);
      $("model").value = ordered[0];
      openModelDd();   // 识别成功立即展示下拉（自绘组件，替代 CEP 中不弹出的原生 datalist）
      log("识别到 " + ids.length + " 个模型（图像类 " + imgs.length + " 个），已写入下拉，当前选用： " + ordered[0] +
          "\n点「模型 ID」输入框可切换其他模型", imgs.length ? "ok" : "");
      info.textContent = "已更新 " + ids.length + " 项";
      info.style.visibility = "visible";
      setTimeout(function () { info.style.visibility = "hidden"; }, 2500);
    } catch (e) {
      var em = String((e && e.message) ? e.message : e);
      // 分类提示：401/403 是 Key 问题，别引导用户去填模型；只有端点无模型列表（404）才建议手动输入
      if (/HTTP 401|HTTP 403/i.test(em)) {
        log("识别失败: " + em.slice(0, 180) +
            "\n→ API Key 无效或无权限：请核对 Key 是否复制完整、是否属于该端点对应的服务商/业务空间，修正后重新点「自动识别模型」", "err");
      } else if (/HTTP 404/i.test(em)) {
        log("识别失败: " + em.slice(0, 180) +
            "\n→ 该端点未提供模型列表接口。可直接手动输入模型 ID（服务商控制台可复制）；填过的模型会进入输入框下拉，方便下次选择", "err");
      } else {
        log("识别失败: " + em.slice(0, 180) +
            "\n→ 可点「端点体检」排查连通性；若端点确实不提供模型列表，可直接手动输入模型 ID", "err");
      }
    }
  }

  // ---------- 「模型 ID」下拉 ----------
  // 背景：原生 datalist 的弹层在 CEP 面板中不显示（v1.9.8 识别后无下拉的根因），
  // 恢复为自绘下拉：点按/聚焦输入框展开，识别成功后自动展开，点选项即填入。
  var modelOptions = [];        // 下拉候选：识别结果（图像类在前）+ 手动输入用过的模型
  var modelDd = null;           // 懒创建的下拉面板
  function fillModelOptions(ids) {
    modelOptions = (ids || []).map(function (x) { return String(x || "").trim(); })
                   .filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (modelDd) renderModelDd();
  }
  function ensureModelDd() {
    if (modelDd) return modelDd;
    modelDd = document.createElement("div");
    modelDd.id = "modelDd";
    modelDd.className = "model-dd";
    modelDd.style.display = "none";
    document.body.appendChild(modelDd);
    return modelDd;
  }
  function renderModelDd() {
    if (!modelDd) return;
    modelDd.innerHTML = "";
    if (!modelOptions.length) {
      var t = document.createElement("div");
      t.className = "model-dd-empty";
      t.textContent = "暂无候选：先点「自动识别模型」，或直接手动输入模型 ID";
      modelDd.appendChild(t);
      return;
    }
    var cur = $("model").value.trim();
    for (var i = 0; i < modelOptions.length; i++) {
      (function (v) {
        var it = document.createElement("div");
        it.className = "model-dd-item" + (v === cur ? " active" : "");
        it.textContent = v;
        it.title = v;
        // 用 mousedown 并阻止默认行为：抢在输入框 blur 之前选中，避免下拉先被关闭
        it.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          $("model").value = v;
          closeModelDd();
          persistNow(true);
        });
        modelDd.appendChild(it);
      })(modelOptions[i]);
    }
  }
  function openModelDd() {
    var inp = $("model");
    if (!inp) return;
    ensureModelDd();
    renderModelDd();
    var r = inp.getBoundingClientRect();
    modelDd.style.left = r.left + "px";
    modelDd.style.top = (r.bottom + 2) + "px";
    modelDd.style.width = r.width + "px";
    modelDd.style.display = "block";
  }
  function closeModelDd() {
    if (modelDd) modelDd.style.display = "none";
  }
  function toggleModelDd() {
    if (modelDd && modelDd.style.display === "block") closeModelDd();
    else openModelDd();
  }

  // ---------- 我的预设（端点 + Key + 模型，随配置文件持久化） ----------
  // 用户自建预设：把当前填写的端点/Key/模型存成命名条目，下拉一键切换。
  // 插件不内置任何厂商预设；数据存于本地 dongps_config.json 的 presets 字段。
  var presetStore = [];           // [{name, endpoint, apikey, model}]，新存的排前面
  var PRESET_MAX = 20;
  function renderPresetOptions() {
    var el = $("presetUser");
    if (!el) return;
    el.innerHTML = "";
    var ph = document.createElement("option");
    ph.value = "";
    ph.textContent = presetStore.length ? ("— 选择已存预设（" + presetStore.length + "）—") : "— 暂无预设，先「存为预设」—";
    el.appendChild(ph);
    for (var i = 0; i < presetStore.length; i++) {
      var op = document.createElement("option");
      op.value = String(i);
      op.textContent = presetStore[i].name;
      el.appendChild(op);
    }
  }
  function savePreset() {
    var ep = $("endpoint").value.trim();
    var key = $("apikey").value.trim();
    var md = $("model").value.trim();
    if (!ep && !key) return log("当前没有可保存的内容：请先填写端点或 Key", "err");
    var nameEl = $("presetName");
    var selEl = $("presetUser");
    var name = (nameEl && nameEl.value.trim()) || "";
    // 名称留空时：优先更新下拉里当前选中的预设
    // （修 v1.9.21：此前会走自动命名，与旧预设名不一致 → 变成新建一条，看起来"改了没生效"）
    if (!name && selEl && selEl.value !== "") {
      var si = parseInt(selEl.value, 10);
      if (presetStore[si]) name = presetStore[si].name;
    }
    if (!name) {                      // 仍为空 → 自动命名：主机 · 模型
      var host = "";
      var m = /^https?:\/\/([^\/]+)/i.exec(ep);
      if (m) host = m[1];
      name = (host || "预设") + " · " + (md || "未填模型");
    }
    var item = { name: name.slice(0, 40), endpoint: ep, apikey: key, model: md };
    var idx = -1;
    for (var i = 0; i < presetStore.length; i++) if (presetStore[i].name === item.name) { idx = i; break; }
    if (idx >= 0) {
      presetStore[idx] = item;
      log("已更新预设「" + item.name + "」（端点/Key/模型已覆盖）", "ok");
    } else {
      if (presetStore.length >= PRESET_MAX) presetStore.pop();
      presetStore.unshift(item);
      log("已新建预设「" + item.name + "」（共 " + presetStore.length + " 个）；换用时在「我的预设」下拉里选", "ok");
    }
    if (nameEl) nameEl.value = "";
    renderPresetOptions();
    // 保存后把下拉选中项指到刚保存的条目，便于继续更新或删除
    if (selEl) {
      for (var j = 0; j < presetStore.length; j++) {
        if (presetStore[j].name === item.name) { selEl.value = String(j); break; }
      }
    }
    persistNow(true);
  }
  function applyPreset(idx) {
    var p = presetStore[idx];
    if (!p) return;
    $("endpoint").value = p.endpoint || "";
    $("apikey").value = p.apikey || "";
    $("model").value = p.model || "";
    if (p.model) fillModelOptions([p.model]);
    if ($("presetName")) $("presetName").value = p.name;   // 名称预填：改完直接点「存为预设」即更新它
    persistNow(true);
    log("已载入预设「" + p.name + "」：端点/Key/模型已填入；改完点「存为预设」即更新该预设", "ok");
  }
  function deletePreset() {
    var el = $("presetUser");
    if (!el || el.value === "") return log("请先在下拉里选中要删除的预设", "err");
    var idx = parseInt(el.value, 10);
    var p = presetStore[idx];
    if (!p) return log("该预设已不存在，请重新在下拉里选择", "err");
    presetStore.splice(idx, 1);
    renderPresetOptions();
    el.value = "";                 // 删完复位，避免索引位移后误显示其它预设
    persistNow(true);
    log("已删除预设「" + p.name + "」（剩余 " + presetStore.length + " 个）", "ok");
  }

  // ---------- 参考图采集 ----------
  var lastSelInfo = null;   // 选区模式：本次实际发送/贴回的矩形
  async function exportRef(mode, rect) {
    if (!fs) throw new Error("Node 文件系统不可用，无法导出参考图");
    var args = JSON.stringify(mode);
    if (mode === "selection" && !rect) {
      var si = parseJsx(await evalJSX("PSAI_docInfo(\"selection\")"));
      if (!si.hadSel) {
        throw new Error("未检测到选区：请先用选框工具框住要修改的区域，再点「生成并置入」");
      }
      var di = parseJsx(await evalJSX("PSAI_docInfo(\"doc\")"));
      var raw = { left: si.left, top: si.top, right: si.right, bottom: si.bottom };
      var pad = computePadRect(raw, di.w, di.h);
      lastSelInfo = pad;
      if (!pad) throw new Error("选区尺寸异常，请重新框选");
      log("选区 " + (raw.right - raw.left) + "x" + (raw.bottom - raw.top) +
          " → 发送区域 " + pad.w + "x" + pad.h + "（" + pad.ratioLabel +
          "，外扩 " + pad.cost.toFixed(2) + " 倍以匹配模型输出比例）");
      args = JSON.stringify(mode) + "," + pad.left + "," + pad.top + "," + pad.right + "," + pad.bottom;
    }
    if (mode === "selection" && rect) {
      args = JSON.stringify(mode) + "," + rect.left + "," + rect.top + "," + rect.right + "," + rect.bottom;
    }
    var j = parseJsx(await evalJSX("PSAI_exportRef(" + args + ")"));
    var buf = fs.readFileSync(j.path);
    var uri = toDataUri(buf, "image/png");
    try { fs.unlinkSync(j.path); } catch (e) {}
    return {
      dataUri: uri, w: j.w, h: j.h,
      left: j.left, top: j.top, right: j.right, bottom: j.bottom,
      hadSel: j.hadSel
    };
  }

  // ---------- API 调用 ----------
  // Agnes AI 平台适配：端点含 agnes-ai.com 或模型名为 agnes-* 时，采用其专有请求格式
  function isAgnes(cfg) {
    var ep = (cfg.endpoint || "").toLowerCase();
    var md = (cfg.model || "").toLowerCase();
    return ep.indexOf("agnes-ai.com") >= 0 || md.indexOf("agnes-") === 0;
  }
  function nearestRatio(w, h) {
    var list = [[1, 1], [3, 4], [4, 3], [16, 9], [9, 16], [2, 3], [3, 2], [21, 9]];
    var t = w / h, best = list[0], bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i][0] / list[i][1] - t);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best[0] + ":" + best[1];
  }

  // 模型可生成的比例候选（与主流平台对齐）
  var RATIOS = [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [3, 2], [2, 3], [21, 9]];

  // 为选区计算"外扩后的发送/贴回矩形"：包住原选区、且比例最接近模型可生成比例
  // 目的：避免窄长选区被模型输出比例挤压成一条
  function computePadRect(b, docW, docH) {
    var w = b.right - b.left;
    var h = b.bottom - b.top;
    if (w <= 0 || h <= 0) return null;
    var area = w * h;
    var best = null;
    for (var i = 0; i < RATIOS.length; i++) {
      var ar = RATIOS[i][0] / RATIOS[i][1];
      var pw = w, ph = w / ar;
      if (ph < h) { ph = h; pw = h * ar; }
      var cost = (pw * ph) / area;
      if (!best || cost < best.cost) {
        best = { pw: pw, ph: ph, cost: cost, ar: ar, label: RATIOS[i][0] + ":" + RATIOS[i][1] };
      }
    }
    var pw2 = Math.ceil(best.pw);
    var ph2 = Math.ceil(best.ph);
    if (docW > 0 && pw2 > docW) { pw2 = docW; ph2 = Math.round(pw2 / best.ar); }
    if (docH > 0 && ph2 > docH) { ph2 = docH; pw2 = Math.round(ph2 * best.ar); }
    if (pw2 < w) pw2 = w;
    if (ph2 < h) ph2 = h;
    var cx = (b.left + b.right) / 2;
    var cy = (b.top + b.bottom) / 2;
    var left = Math.round(cx - pw2 / 2);
    var top = Math.round(cy - ph2 / 2);
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (docW > 0 && left + pw2 > docW) left = Math.max(0, docW - pw2);
    if (docH > 0 && top + ph2 > docH) top = Math.max(0, docH - ph2);
    return {
      left: left, top: top, right: left + pw2, bottom: top + ph2,
      w: pw2, h: ph2, cost: best.cost, ratioLabel: best.label
    };
  }
  function sizeToTier(size) {
    if (size === "1K" || size === "2K" || size === "3K" || size === "4K") {
      return { tier: size, ratio: "1:1" };
    }
    var m = /^(\d+)x(\d+)$/i.exec(size || "");
    if (m) {
      var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
      var px = w * h;
      var tier = px <= 1500000 ? "1K" : (px <= 5000000 ? "2K" : (px <= 12000000 ? "3K" : "4K"));
      return { tier: tier, ratio: nearestRatio(w, h) };
    }
    return { tier: "2K", ratio: "1:1" };
  }
  // 依据请求尺寸（WxH）选择平台档位，保证输出分辨率不低于画布
  // 背景：传精确尺寸时平台会归一化到档位，长边 3072 的画布若被降到 2K 就会放大变糊
  function tierForSize(size) {
    var m = /^(\d+)x(\d+)$/i.exec(size || "");
    if (!m) return null;
    var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!(w > 0 && h > 0)) return null;
    var longSide = Math.max(w, h);
    var tier = longSide <= 1200 ? "1K" : (longSide <= 2200 ? "2K" : (longSide <= 3400 ? "3K" : "4K"));
    return { tier: tier, ratio: nearestRatio(w, h), longSide: longSide };
  }

  function buildBody(cfg, prompt, imageUris, size) {
    var body;
    if (isAgnes(cfg)) {
      // 传精确 WxH 时平台会归一化到档位，可能低于画布 → 主动换算成"档位 + 比例"，
      // 保证输出分辨率不低于画布（避免置入时被放大而发糊）
      var t = tierForSize(size);
      if (t) {
        body = { model: cfg.model, prompt: prompt, size: t.tier, ratio: t.ratio };
      } else {
        body = { model: cfg.model, prompt: prompt, size: size };
      }
      body.extra_body = { response_format: "url" };
      if (imageUris && imageUris.length) body.extra_body.image = imageUris;
      return body;
    }
    body = {
      model: cfg.model,
      prompt: prompt,
      size: size,
      watermark: false,
      response_format: "url"
    };
    if (imageUris && imageUris.length) body.image = imageUris;
    return body;
  }

  // ================= 端点体检 =================
  // 端点体检：只做可达性探测，不生成图片、不产生调用费用
  async function checkEndpoint() {
    var raw = $("endpoint").value.trim();
    if (!raw) return log("请先填写 API 端点", "err");
    var ep = isDashScopeUrl(raw) ? dashEndpoint(raw) : asGenerateUrl(raw);
    if (ep !== raw) log("端点已归一化: " + ep);
    log("端点体检中（仅探测可达性，不生成图片、不产生费用）...");
    try {
      var r = await fetch(ep, { method: "OPTIONS" });
      var code = r.status;
      if (code === 404) {
        log("✗ HTTP 404 —— 该路径不存在\n" +
            "  说明这个服务商没有提供 OpenAI 兼容的图像接口（或路径写错）。\n" +
            "  做法：到服务商文档确认图像生成端点路径，粘贴完整 URL；" +
            "若是自有协议平台（腾讯混元/Google/fal 等），需要专门适配。", "err");
      } else if (code === 401 || code === 403) {
        log("✓ 端点存在（返回 " + code + "，要求鉴权，属正常）\n" +
            "  下一步：填入有效 API Key → 保存设置 → 生成", "ok");
      } else if (code === 405 || code === 400 || code === 415 || code === 422 ||
                 code === 200 || code === 204 || code === 301 || code === 302) {
        log("✓ 端点存在且可达（返回 " + code + "）", "ok");
      } else {
        log("? 端点返回 HTTP " + code + "，无法确定是否支持图像生成；直接试一次最小生成最准确", "err");
      }
    } catch (e) {
      log("✗ 连接失败：" + (e && e.message ? e.message : e) +
          "\n  请检查网络 / 代理（本机 Clash 为 127.0.0.1:7897）", "err");
    }
  }

  // ================= 阿里云百炼（DashScope）适配 =================
  // 兼容模式（compatible-mode）没有 /images/generations（会 404）；
  // 图像生成/编辑要走同步多模态端点，参考图以 base64 data URI 传入。
  function isDashScopeUrl(ep) {
    return /dashscope(-intl)?\.aliyuncs\.com|maas\.aliyuncs\.com/i.test(ep || "");
  }
  function isDashScope(cfg) {
    return isDashScopeUrl(cfg && cfg.endpoint);
  }
  function dashEndpoint(ep) {
    var m = /^(https?:\/\/[^\/]+)/i.exec((ep || "").trim());
    var origin = m ? m[1] : "https://dashscope.aliyuncs.com";
    return origin + "/api/v1/services/aigc/multimodal-generation/generation";
  }
  // 把通用尺寸映射到 DashScope 支持的 "宽*高"（16 的倍数，边长 512~2048）
  function dashSize(size, model) {
    var md = (model || "").toLowerCase();
    var maxSide = 2048;          // qwen-image-2.0 / edit-max / edit-plus 均支持到 2048
    // 仅文生图老系列 qwen-image-max / qwen-image-plus 上限为 1664
    if (/^qwen-image-(max|plus)(-|$)/.test(md)) maxSide = 1664;
    var w = 0, h = 0;
    var m = /^(\d+)x(\d+)$/i.exec(size || "");
    if (m) {
      w = parseInt(m[1], 10); h = parseInt(m[2], 10);
    } else {
      var px = (size === "1K") ? 1024 : (size === "2K") ? 2048 :
               (size === "3K") ? 3072 : (size === "4K") ? 4096 : 2048;
      w = h = px;
    }
    var f = Math.min(1, maxSide / Math.max(w, h));
    w = Math.round(w * f); h = Math.round(h * f);
    w = Math.min(maxSide, Math.max(512, Math.round(w / 16) * 16));
    h = Math.min(maxSide, Math.max(512, Math.round(h / 16) * 16));
    return w + "*" + h;
  }
  async function callDashScope(cfg, prompt, imageUris, size) {
    var url = dashEndpoint(cfg.endpoint);
    var content = [];
    if (imageUris && imageUris.length) {
      var lim = Math.min(3, imageUris.length);       // 官方限制 1~3 张
      for (var i = 0; i < lim; i++) content.push({ image: imageUris[i] });
    }
    content.push({ text: prompt });                  // 只允许一个 text
    var md = (cfg.model || "").toLowerCase();
    var params = { n: Math.min(4, (cfg.count > 1 ? cfg.count : 1)), watermark: false, prompt_extend: false };
    if (md !== "qwen-image-edit") params.size = dashSize(size, cfg.model);   // 基础版不支持 size

    var body = {
      model: cfg.model,
      input: { messages: [{ role: "user", content: content }] },
      parameters: params
    };
    log("阿里云百炼 · 同步多模态端点，size=" + (params.size || "默认") +
        (content.length > 1 ? "，参考图 x" + (content.length - 1) : ""));
    var resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apikey
      },
      body: JSON.stringify(body)
    });
    var text = await resp.text();
    if (!resp.ok) {
      var hint = "";
      if (resp.status === 401) hint = " ｜ API Key 无效或地域不匹配（北京与新加坡的 Key 不通用）";
      if (resp.status === 404) hint = " ｜ 模型 " + cfg.model + " 可能不存在，请到百炼控制台确认模型名（推荐 qwen-image-2.0-pro）";
      if (/model/i.test(text) && /not|exist|invalid/i.test(text)) {
        hint = " ｜ 模型名可能不存在：官方文档推荐 qwen-image-2.0-pro / qwen-image-edit-max / qwen-image-edit-plus";
      }
      throw new Error("阿里云 API 错误 " + resp.status + ": " + text.slice(0, 300) + hint);
    }
    var j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    var urls = [];
    try {
      var cs = j.output.choices[0].message.content;
      for (var k = 0; k < cs.length; k++) {
        if (cs[k].image) urls.push(cs[k].image);
      }
    } catch (e2) { }
    if (!urls.length) throw new Error("阿里云未返回图像: " + text.slice(0, 220));
    var out = [];
    for (var k2 = 0; k2 < urls.length; k2++) {
      var r2 = await fetch(urls[k2]);
      if (!r2.ok) throw new Error("下载生成图失败: HTTP " + r2.status);
      var ab = await r2.arrayBuffer();
      out.push((typeof Buffer !== "undefined") ? Buffer.from(ab) : new Uint8Array(ab));
    }
    return out;
  }

  async function callApi(cfg, prompt, imageUris, size) {
    if (isDashScope(cfg)) {                       // 阿里云百炼走原生协议
      return await callDashScope(cfg, prompt, imageUris, size);
    }
    var body = buildBody(cfg, prompt, imageUris, size);
    var resp = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.apikey
      },
      body: JSON.stringify(body)
    });
    var text = await resp.text();
    var j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!resp.ok) {
      var msg = j && j.error && j.error.message ? j.error.message : text.slice(0, 300);
      var hint = "";
      if (resp.status === 404 && isDashScopeUrl(cfg.endpoint)) {
        hint = " ｜ 阿里云兼容模式（compatible-mode）不含图像生成接口，正确端点是 " +
               dashEndpoint(cfg.endpoint) + "（插件已自动改用该端点，若仍 404 请检查模型名）";
      } else if (resp.status === 404) {
        hint = " ｜ 该路径不存在：请确认端点是否包含 /images/generations 且平台确实支持 OpenAI 兼容生图";
      } else if (isAgnes(cfg) && /LLM Provider|distributor|无可用渠道/i.test(msg)) {
        hint = " ｜ Agnes 平台正确端点是 https://apihub.agnes-ai.com/v1/images/generations" +
               "（platform.agnes-ai.com 只是控制台，不能作为 API 地址），模型名用裸名 agnes-image-2.5-flash，不要加任何前缀";
      } else if (/LLM Provider|provider/i.test(msg)) {
        hint = " ｜ 该网关要求模型名带 provider 前缀，可把模型 ID 改为 openai/" + cfg.model + " 再试";
      } else if (/无可用渠道|distributor|no available channel/i.test(msg)) {
        hint = " ｜ 该模型在此站点当前分组下没有可用渠道：请到站点控制台查看『可用模型』列表，换一个生图模型；与插件和 Key 无关";
      }
      throw new Error("API 错误 " + resp.status + ": " + msg + hint);
    }
    // 通用响应解析：兼容主流返回结构，收集全部图片（支持一次多张）
    // data[i].{url,b64_json,image} / images[i].{url,b64_json,base64} / 顶层 url·image / dataURI
    var entries = null;
    if (j && j.data && j.data.length) entries = j.data;
    else if (j && j.images && j.images.length) entries = j.images;
    if (entries) {
      entries = entries.map(function (x) { return (typeof x === "string") ? { url: x } : x; });
    } else if (j && (typeof j.url === "string" || typeof j.image === "string")) {
      entries = [{ url: (typeof j.url === "string" && j.url) || j.image }];
    }
    if (!entries) throw new Error("API 返回数据为空或格式未识别: " + text.slice(0, 200));
    var out = [];
    for (var ei = 0; ei < entries.length; ei++) {
      var it = entries[ei];
      var b64 = it.b64_json || it.b64 || it.base64 ||
                (it.image && typeof it.image === "object" && (it.image.b64_json || it.image.b64));
      if (b64) { out.push(bufFromB64(b64)); continue; }
      var u = it.url || (typeof it.image === "string" && it.image) || (it.image && it.image.url) || "";
      if (!u) continue;
      if (/^data:/i.test(u)) { out.push(bufFromB64(u.replace(/^data:[^,]*,/, ""))); continue; }
      var r2 = await fetch(u);
      if (!r2.ok) throw new Error("下载生成结果失败: HTTP " + r2.status);
      var ab = await r2.arrayBuffer();
      out.push((typeof Buffer !== "undefined") ? Buffer.from(ab) : new Uint8Array(ab));
    }
    if (!out.length) throw new Error("API 返回中无图片数据: " + text.slice(0, 200));
    return out;
  }

  // 按报错自动修正模型名（最多两步：加 provider 前缀 / 去掉前缀）
  async function callApiSmart(cfg, prompt, imageUris, size) {
    var originModel = cfg.model;
    var tried = [];
    var attempt = async function (model) {
      tried.push(model);
      cfg.model = model;
      try {
        return await callApi(cfg, prompt, imageUris, size);
      } catch (e) {
        var em = (e && e.message) ? e.message : String(e);
        var next = null;
        if (/LLM Provider|provider/i.test(em) && model.indexOf("/") < 0) {
          next = "openai/" + model;
        } else if (/无可用渠道|distributor|no available channel/i.test(em) && model.indexOf("/") >= 0) {
          next = model.split("/").pop();
        }
        if (next && tried.indexOf(next) < 0) {
          log("按报错提示改用 " + next + " 重试...");
          return await attempt(next);
        }
        throw e;
      }
    };
    var bufs = await attempt(originModel);
    if (cfg.model !== originModel) {
      $("model").value = cfg.model;   // 回填最终生效的模型名
    }
    return bufs;
  }

  // ---------- 置入 PS ----------
  async function placeIntoDoc(buf, opts) {
    if (!fs) throw new Error("Node 文件系统不可用，无法置入");
    var o = opts || {};
    var p = osMod.tmpdir() + "\\psai_result_" + Date.now() + "_" + Math.floor(Math.random() * 100000) + ".png";
    fs.writeFileSync(p, Buffer.from(buf));
    try {
      return parseJsx(await evalJSX(
        "PSAI_place(" + JSON.stringify(p) + "," + ($("fit").checked ? "true" : "false") + "," +
        (o.visible === false ? "false" : "true") + "," +
        (o.name ? JSON.stringify(o.name) : "null") + ")"
      ));
    } finally {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }

  // 把图像灰度化并渲染为精确的 w×h（用于统一坐标系）
  function decodeGrayWH(src, w, h) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        var ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        var d = ctx.getImageData(0, 0, w, h).data;
        var g = new Float32Array(w * h);
        for (var i = 0, j = 0; i < g.length; i++, j += 4) {
          g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        }
        resolve({ g: g, w: w, h: h });
      };
      img.onerror = function () { reject(new Error("图像解码失败")); };
      img.src = src;
    });
  }
  // 用 A 的指定子区域作模板，在 B 中搜索最佳偏移（含抛物线亚像素精修）
  function searchPatch(A, B, tx0, ty0, tw, th, maxShift, step) {
    var sadAt = function (dx, dy) {
      var bx0 = tx0 + dx, by0 = ty0 + dy;
      if (bx0 < 0 || by0 < 0 || bx0 + tw > B.w || by0 + th > B.h) return null;
      var sad = 0;
      for (var y = 0; y < th; y += step) {
        var ra = (ty0 + y) * A.w + tx0;
        var rb = (by0 + y) * B.w + bx0;
        for (var x = 0; x < tw; x += step) {
          var df = A.g[ra + x] - B.g[rb + x];
          sad += df < 0 ? -df : df;
        }
      }
      return sad;
    };
    var best = { dx: 0, dy: 0, sad: Infinity };
    for (var dy = -maxShift; dy <= maxShift; dy++) {
      for (var dx = -maxShift; dx <= maxShift; dx++) {
        var v = sadAt(dx, dy);
        if (v === null) continue;
        // 相同误差优先最小位移；纯色/重复纹理不能凭搜索顺序推断漂移。
        if (v < best.sad || (v === best.sad && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) {
          best.dx = dx; best.dy = dy; best.sad = v;
        }
      }
    }
    // 抛物线亚像素精修：用最佳点及其上下左右邻域拟合，得到 sub-pixel 位移
    var c = best.sad;
    var xm = sadAt(best.dx - 1, best.dy), xp = sadAt(best.dx + 1, best.dy);
    var ym = sadAt(best.dx, best.dy - 1), yp = sadAt(best.dx, best.dy + 1);
    var subX = 0, subY = 0;
    if (xm !== null && xp !== null) {
      var denX = xm - 2 * c + xp;
      if (Math.abs(denX) > 1e-9) subX = 0.5 * (xm - xp) / denX;
      if (subX > 1) subX = 1; if (subX < -1) subX = -1;
    }
    if (ym !== null && yp !== null) {
      var denY = ym - 2 * c + yp;
      if (Math.abs(denY) > 1e-9) subY = 0.5 * (ym - yp) / denY;
      if (subY > 1) subY = 1; if (subY < -1) subY = -1;
    }
    best.subDx = best.dx + subX;
    best.subDy = best.dy + subY;
    return best;
  }
  // 精细变换：在"已按画布比例拉伸"的坐标系里，检测残余的纵向/横向缩放偏差与位移
  // 采用 5 条采样带 + 最小二乘拟合，抗噪声；返回抵消变形用的 fineScale 与位移补偿量
  async function detectFineTransform(refUri, buf, docW, docH) {
    var resUrl = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/png" }));
    try {
      var W = 640;
      var H = Math.max(32, Math.round(W * docH / docW));
      var A = await decodeGrayWH(refUri, W, H);
      var B = await decodeGrayWH(resUrl, W, H);
      var maxS = Math.round(W * 0.07);
      var FRACS = [0.08, 0.22, 0.36, 0.50, 0.64, 0.78, 0.92];

      // ---- 纵向：5 条横带，位移随 y 的斜率 ----
      var bandW = Math.round(W * 0.60), bandH = Math.round(H * 0.12);
      var xs0 = Math.round((W - bandW) / 2);
      var ptsY = [];
      for (var i2 = 0; i2 < FRACS.length; i2++) {
        var yc = Math.round(H * FRACS[i2]);
        var ty = Math.max(0, Math.min(H - bandH, yc - Math.round(bandH / 2)));
        var r = searchPatch(A, B, xs0, ty, bandW, bandH, maxS, 2);
        ptsY.push({ y: yc, dy: r.subDy });
      }
      // 最小二乘拟合 dy = a*y + b
      var aY = lsqSlope(ptsY, "dy");

      // ---- 横向：5 条竖带 ----
      var bandW2 = Math.round(W * 0.12), bandH2 = Math.round(H * 0.60);
      var ty0 = Math.round((H - bandH2) / 2);
      var ptsX = [];
      for (var j2 = 0; j2 < FRACS.length; j2++) {
        var xc = Math.round(W * FRACS[j2]);
        var tx = Math.max(0, Math.min(W - bandW2, xc - Math.round(bandW2 / 2)));
        var r2 = searchPatch(A, B, tx, ty0, bandW2, bandH2, maxS, 2);
        ptsX.push({ y: xc, dy: r2.subDx });
      }
      var aX = lsqSlope(ptsX, "dy");

      // ---- 中心区域位移（补偿量）----
      var ctrW = Math.round(W * 0.4), ctrH = Math.round(H * 0.4);
      var ctr = searchPatch(A, B, Math.round((W - ctrW) / 2), Math.round((H - ctrH) / 2),
                            ctrW, ctrH, maxS, 2);

      // 结果图内容在 B 中 ≈ k*参考图位置 + c，k = 1 + 斜率；图层按 1/k 缩放即可复正
      var kY = 1 + aY, kX = 1 + aX;
      // 误检保护：变形超过 4% 视为配准失败，不施加
      var okY = (kY > 0.96 && kY < 1.04), okX = (kX > 0.96 && kX < 1.04);
      var fsY = okY ? 1 / kY : 1;
      var fsX = okX ? 1 / kX : 1;

      var gainD = docW / W;
      return {
        fineScaleX: Math.round(fsX * 10000) / 10000,
        fineScaleY: Math.round(fsY * 10000) / 10000,
        rawDx: Math.round(ctr.subDx * gainD),
        rawDy: Math.round(ctr.subDy * gainD),
        shiftX: -Math.round(ctr.subDx * gainD),
        shiftY: -Math.round(ctr.subDy * gainD),
        slopeX: Math.round(aX * 1000000) / 1000000,
        slopeY: Math.round(aY * 1000000) / 1000000,
        samples: ptsY.length
      };
    } finally {
      try { URL.revokeObjectURL(resUrl); } catch (e) {}
    }
  }
  // 最小二乘斜率（点集：{y: 自变量, dy: 因变量}）
  function lsqSlope(pts, key) {
    var n = pts.length;
    if (n < 2) return 0;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) {
      var x = pts[i].y, y = pts[i][key];
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    var den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return 0;
    return (n * sxy - sx * sy) / den;
  }

  // 读取图像原始像素尺寸
  function getImageSize(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
      };
      img.onerror = function () { reject(new Error("读取图像尺寸失败")); };
      img.src = src;
    });
  }

  // ---------- 透明底支持（提示词驱动，无 UI 项） ----------
  // 提示词出现"透明底/透明背景/去背/抠图/transparent"时：
  // 请求前把透明诉求改写为纯白背景（防止模型画出假透明的棋盘格/灰底），
  // 出图后在面板内做"边缘泛洪抠白"转为真透明 PNG。
  // 只处理与画面边界连通的近白区域，商品内部的白色不会被误抠。
  function promptWantsTransparent(p) {
    if (!p) return false;
    if (/transparent/i.test(p)) return true;
    return /透明底|透明背景|透明的背景|透明底色|去背|抠图|白底转透明/.test(p);
  }

  function rewritePromptForWhiteBg(p) {
    var s = String(p);
    s = s.replace(/transparent(\s+background)?/gi, "pure white background");
    s = s.replace(/透明底色|透明的背景|透明背景|透明底|去背|抠图|白底转透明/g, "纯白背景");
    s += (/[，。,.;；!！?？:\s]$/.test(s) ? "" : "，") +
         "背景输出为均匀纯白色，纯白实底，不要棋盘格、不要灰色底、不要渐变";
    return s;
  }

  // 泛洪抠白核心（纯数据，可独立测试）：
  // 从四边种子扩散，把与画面边界连通的近白像素转透明（商品内部的封闭白色不受影响）。
  // SOLID(244) 以上 alpha=0；SOFT(228)~SOLID 线性渐变软边；色偏超过 CHROMA(16) 的不动。
  // 返回受影响像素数。
  function floodWhiteToAlpha(px, w, h) {
    var SOLID = 244, SOFT = 228, CHROMA = 16;
    var visited = new Uint8Array(w * h);
    var stack = [];
    var touched = 0;
    function pushSeed(i) {
      if (visited[i]) return;
      var j = i * 4;
      var mx = Math.max(px[j], px[j + 1], px[j + 2]);
      var mn = Math.min(px[j], px[j + 1], px[j + 2]);
      if (mn >= SOFT && (mx - mn) <= CHROMA) { visited[i] = 1; stack.push(i); }
    }
    var x, y;
    for (x = 0; x < w; x++) { pushSeed(x); pushSeed((h - 1) * w + x); }
    for (y = 0; y < h; y++) { pushSeed(y * w); pushSeed(y * w + w - 1); }
    while (stack.length) {
      var i = stack.pop();
      var j = i * 4;
      var mn2 = Math.min(px[j], px[j + 1], px[j + 2]);
      if (mn2 >= SOLID) {
        px[j + 3] = 0;                            // 纯白 → 全透明
      } else {
        var t = (mn2 - SOFT) / (SOLID - SOFT);    // 过渡带 → 半透明软边
        px[j + 3] = Math.round(t * 150);
      }
      touched++;
      var x0 = i % w, y0 = (i / w) | 0;
      if (x0 > 0) pushSeed(i - 1);
      if (x0 < w - 1) pushSeed(i + 1);
      if (y0 > 0) pushSeed(i - w);
      if (y0 < h - 1) pushSeed(i + w);
    }
    return touched;
  }

  // 结果图透明化：解码后先检查是否已带真透明（任一像素 alpha<250，说明端点原生输出了透明底），
  // 有则原样返回；无则做边缘泛洪抠白。
  // 返回 { buf, changed, native, touched, w, h }
  function transparentizeImage(buf) {
    return new Promise(function (resolve, reject) {
      var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
      var blob = new Blob([u8], { type: "image/png" });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          var ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0);
          var d = ctx.getImageData(0, 0, w, h);
          var px = d.data;
          var hasAlpha = false;
          for (var i0 = 3; i0 < px.length; i0 += 4) {
            if (px[i0] < 250) { hasAlpha = true; break; }
          }
          if (hasAlpha) {
            try { URL.revokeObjectURL(url); } catch (eR0) {}
            return resolve({ buf: buf, changed: false, native: true, touched: 0, w: w, h: h });
          }
          var touched = floodWhiteToAlpha(px, w, h);
          ctx.putImageData(d, 0, 0);
          cv.toBlob(function (bl) {
            try { URL.revokeObjectURL(url); } catch (eR) {}
            if (!bl) return reject(new Error("透明 PNG 编码失败"));
            var fr = new FileReader();
            fr.onload = function () {
              resolve({ buf: new Uint8Array(fr.result), changed: true, native: false,
                        touched: touched, w: w, h: h });
            };
            fr.onerror = function () { reject(new Error("透明 PNG 读取失败")); };
            fr.readAsArrayBuffer(bl);
          }, "image/png");
        } catch (eP) {
          try { URL.revokeObjectURL(url); } catch (eR2) {}
          reject(eP);
        }
      };
      img.onerror = function () {
        try { URL.revokeObjectURL(url); } catch (eR3) {}
        reject(new Error("结果图解码失败，无法透明化"));
      };
      img.src = url;
    });
  }

  // 规划"符合模型标准比例"的上传矩形
  // 规则：以框选为中心；比例与标准比例偏差 > 2% 时，外扩成最接近的标准比例矩形（包住原框选）
  function planUploadRect(selRect, docW, docH) {
    var w = selRect.right - selRect.left;
    var h = selRect.bottom - selRect.top;
    if (!(w > 0 && h > 0)) return null;
    var baseAr = w / h;
    var best = null;
    for (var i = 0; i < RATIOS.length; i++) {
      var ar = RATIOS[i][0] / RATIOS[i][1];
      var rel = Math.abs(ar / baseAr - 1);
      if (!best || rel < best.rel) {
        best = { ar: ar, rel: rel, label: RATIOS[i][0] + ":" + RATIOS[i][1] };
      }
    }
    var cx = (selRect.left + selRect.right) / 2;
    var cy = (selRect.top + selRect.bottom) / 2;
    var uw = w, uh = h, adjusted = false, label = best.label;
    if (best.rel > 0.02) {
      adjusted = true;
      uw = w;
      uh = w / best.ar;
      if (uh < h) { uh = h; uw = h * best.ar; }
    }
    uw = Math.round(uw); uh = Math.round(uh);
    // 限制在画布范围内（优先平移，不缩小）
    if (docW > 0 && uw > docW) { uw = docW; uh = Math.round(uw / (adjusted ? best.ar : baseAr)); }
    if (docH > 0 && uh > docH) { uh = docH; uw = Math.round(uh * (adjusted ? best.ar : baseAr)); }
    if (uw < w) uw = w;
    if (uh < h) uh = h;
    var left = Math.round(cx - uw / 2), top = Math.round(cy - uh / 2);
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (docW > 0 && left + uw > docW) left = Math.max(0, docW - uw);
    if (docH > 0 && top + uh > docH) top = Math.max(0, docH - uh);
    var covers = (left <= selRect.left + 0.5) && (top <= selRect.top + 0.5) &&
                 (left + uw >= selRect.right - 0.5) && (top + uh >= selRect.bottom - 0.5);
    return {
      left: left, top: top, right: left + uw, bottom: top + uh,
      w: uw, h: uh, ratioLabel: label, adjusted: adjusted,
      ratioDev: Math.round(best.rel * 1000) / 10,
      coversSel: covers,
      areaGrow: Math.round(uw * uh / Math.max(1, w * h) * 100) / 100
    };
  }

  // ---------- 位移检测（图像配准，补偿模型整体像素漂移）----------
  function decodeGray(src, maxW) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = Math.max(16, Math.min(maxW, img.width));
        var h = Math.max(16, Math.round(img.height * w / img.width));
        var cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        var ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        var d = ctx.getImageData(0, 0, w, h).data;
        var g = new Float32Array(w * h);
        for (var i = 0, j = 0; i < g.length; i++, j += 4) {
          g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        }
        resolve({ g: g, w: w, h: h });
      };
      img.onerror = function () { reject(new Error("图像解码失败")); };
      img.src = src;
    });
  }
  // 在 B 中搜索 A 中心模板的最佳匹配偏移（SAD 最小）
  function searchBest(A, B, maxShift, step, cx, cy) {
    var tw = Math.max(16, Math.round(A.w * 0.6));
    var th = Math.max(16, Math.round(A.h * 0.6));
    var tx0 = Math.round((A.w - tw) / 2), ty0 = Math.round((A.h - th) / 2);
    var best = { dx: 0, dy: 0, sad: Infinity };
    var from = (cx === undefined) ? -maxShift : cx - maxShift;
    var to = (cx === undefined) ? maxShift : cx + maxShift;
    var fy = (cy === undefined) ? -maxShift : cy - maxShift;
    var ty = (cy === undefined) ? maxShift : cy + maxShift;
    for (var dy = fy; dy <= ty; dy++) {
      for (var dx = from; dx <= to; dx++) {
        var bx0 = tx0 + dx, by0 = ty0 + dy;
        if (bx0 < 0 || by0 < 0 || bx0 + tw > B.w || by0 + th > B.h) continue;
        var sad = 0;
        for (var y = 0; y < th; y += step) {
          var ra = (ty0 + y) * A.w + tx0;
          var rb = (by0 + y) * B.w + bx0;
          for (var x = 0; x < tw; x += step) {
            var df = A.g[ra + x] - B.g[rb + x];
            sad += df < 0 ? -df : df;
          }
        }
        if (sad < best.sad) { best.dx = dx; best.dy = dy; best.sad = sad; }
      }
    }
    return best;
  }
  // 返回结果图相对参考图的整体位移（文档像素）
  // 语义：结果图在 p 处的内容 ≈ 参考图在 p+shift 处的内容 → 图层按 shift 平移即可对齐
  async function detectShift(refUri, buf, docW, docH) {
    var resUrl = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/png" }));
    try {
      var Ac = await decodeGray(refUri, 128);
      var Bc = await decodeGray(resUrl, 128);
      var coarse = searchBest(Ac, Bc, 6, 2);
      var gainC = 128 / docW;
      var cxD = coarse.dx / gainC, cyD = coarse.dy / gainC;

      var Af = await decodeGray(refUri, 512);
      var Bf = await decodeGray(resUrl, 512);
      var gainF = 512 / docW;
      var fine = searchBest(Af, Bf, 3, 2, Math.round(cxD * gainF), Math.round(cyD * gainF));
      var rawDx = Math.round(fine.dx / gainF);
      var rawDy = Math.round(fine.dy / gainF);
      // raw = 参考图内容在结果图中的位置偏移；图层反向平移才是补偿量
      return { dx: -rawDx, dy: -rawDy, rawDx: rawDx, rawDy: rawDy, sad: fine.sad };
    } finally {
      try { URL.revokeObjectURL(resUrl); } catch (e) {}
    }
  }

  // 整图上下文局部重绘：置入整图结果并用原选区形状加蒙版合成
  async function placeMasked(buf, feather, shiftX, shiftY, fitMode, fineScaleX, fineScaleY,
                             rectLeft, rectTop, rectW, rectH) {
    if (!fs) throw new Error("Node 文件系统不可用，无法置入");
    var p = osMod.tmpdir() + "\\psai_mask_" + Date.now() + ".png";
    fs.writeFileSync(p, Buffer.from(buf));
    try {
      return parseJsx(await evalJSX(
        "PSAI_placeMasked(" + JSON.stringify(p) + "," + (feather || 0) + "," +
        Math.round(shiftX || 0) + "," + Math.round(shiftY || 0) + "," +
        JSON.stringify(fitMode || "stretch") + "," +
        (Number(fineScaleX) || 1) + "," + (Number(fineScaleY) || 1) + "," +
        Math.round(rectLeft === undefined ? -1 : rectLeft) + "," +
        Math.round(rectTop === undefined ? -1 : rectTop) + "," +
        Math.round(rectW || 0) + "," + Math.round(rectH || 0) + ")"
      ));
    } finally {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }

  // 选区原位贴回（返回实际放置信息，便于核对）；feather>0 时自动加羽化蒙版融合
  async function placeAtRect(buf, left, top, w, h, feather) {
    if (!fs) throw new Error("Node 文件系统不可用，无法置入");
    var p = osMod.tmpdir() + "\\psai_res_" + Date.now() + ".png";
    fs.writeFileSync(p, Buffer.from(buf));
    try {
      var fv = parseInt(feather, 10);
      if (isNaN(fv) || fv < 0) fv = 0;
      return parseJsx(await evalJSX(
        "PSAI_placeAt(" + JSON.stringify(p) + "," +
        Math.round(left) + "," + Math.round(top) + "," +
        Math.round(w) + "," + Math.round(h) + "," + fv + ")"
      ));
    } finally {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }

  // ---------- 额外参考图 ----------
  var extraRefs = [];
  function pickFiles() {
    // 同一套路径选择实现（同步版优先、回调兜底），避免旧回调形式个别 PS 版本不弹窗
    return pickPaths(false, "选择参考图", ["png", "jpg", "jpeg", "webp", "bmp"], true);
  }
  async function addExtraRefs() {
    if (!fs) return log("Node 不可用", "err");
    var files = await pickFiles();
    if (!files || !files.length) return;
    var list = $("extraRefs");
    for (var i = 0; i < files.length; i++) {
      var buf = fs.readFileSync(files[i]);
      var ext = (files[i].split(".").pop() || "png").toLowerCase();
      var mime = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "image/" + ext;
      extraRefs.push({ name: files[i].replace(/^.*[\\\/]/, ""), dataUri: toDataUri(buf, mime) });
      var tag = document.createElement("span");
      tag.className = "ref";
      tag.textContent = files[i].replace(/^.*[\\\/]/, "");
      list.appendChild(tag);
    }
  }
  function clearExtraRefs() {
    extraRefs = [];
    $("extraRefs").innerHTML = "";
  }

  // ---------- 导出图层组为图片 ----------
  // 流程：读取文档顶层组 → 勾选 → 逐个调 PS 导出（副本操作，不动原文档）
  var expGroups = [];

  // 组名 → 合法文件名（去掉 Windows 非法字符，防超长/纯点号）
  function sanitizeName(n) {
    var s = String(n === undefined || n === null ? "" : n)
      .replace(/[\\\/:*?"<>|\r\n\t]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\s+$/, "");
    if (!s) s = "group";
    if (s.length > 80) s = s.slice(0, 80);
    return s;
  }

  async function refreshGroups() {
    try {
      var j = parseJsx(await evalJSX("PSAI_listGroups()"));
      expGroups = (j && j.groups) ? j.groups : [];
      renderGroupList();
      var note = $("expNote");
      if (note) note.textContent = expGroups.length ? (expGroups.length + " 个组") : "没有组";
      if (!expGroups.length) {
        log("当前文档里没有图层组：先在 PS 图层面板选中要导出的图层，按 Ctrl+G 编组", "err");
      } else {
        var totalItems = 0;
        for (var tk = 0; tk < expGroups.length; tk++) {
          totalItems += (expGroups[tk].children && expGroups[tk].children.length) || 1;
        }
        log("已读取 " + expGroups.length + " 个组（画布 " + j.docW + "×" + j.docH + "，共 " +
            totalItems + " 项），默认全部勾选。\n要「组内每张图分别导出」，把「粒度」切到「组内每项一张」");
      }
    } catch (e) {
      log("读取组失败：" + (e && e.message ? e.message : e), "err");
    }
  }

  // 组列表右侧说明：整组模式显示尺寸，逐项模式显示会导出几张
  function groupSizeLabel(g) {
    var perItem = ($("expGran") && $("expGran").value === "children");
    var n = (g.children && g.children.length) ? g.children.length : 0;
    if (perItem) return (n || 1) + " 张";
    return (g.w > 0 && g.h > 0) ? (g.w + "×" + g.h) : "空";
  }

  function renderGroupList() {
    var box = $("expList");
    if (!box) return;
    box.innerHTML = "";
    if (!expGroups.length) {
      var em = document.createElement("div");
      em.className = "grouplist-empty";
      em.textContent = "未发现图层组";
      box.appendChild(em);
      return;
    }
    for (var i = 0; i < expGroups.length; i++) {
      var g = expGroups[i];
      var row = document.createElement("label");
      row.className = "groupitem" + (g.visible ? "" : " hidden-layer");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-idx", String(g.idx));
      cb.checked = true;
      var nm = document.createElement("span");
      nm.className = "gname";
      nm.textContent = g.name + (g.visible ? "" : "（原文档中隐藏）");
      var sz = document.createElement("span");
      sz.className = "gsize";
      sz.textContent = groupSizeLabel(g);
      row.appendChild(cb);
      row.appendChild(nm);
      row.appendChild(sz);
      box.appendChild(row);
    }
  }

  function setAllGroups(checked) {
    var box = $("expList");
    if (!box) return;
    var cbs = box.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < cbs.length; i++) cbs[i].checked = checked;
  }

  // 系统路径选择框
  // 优先用同步版 showOpenDialog（CEP 官方 def：chooseDirectory=true 即选目录，同步返回 {data,err}）；
  // 该 API 不存在/参数不支持（抛异常）时退回回调版 showOpenDialogEx。
  // 返回 Promise<string[]>（用户取消或不可用 → 空数组）
  function pickResultList(r) {
    try {
      if (typeof r === "string") {
        var j = JSON.parse(r);
        if (j && j.data && j.data.length) return Array.prototype.slice.call(j.data).map(String);
        return [];
      }
      if (r && r.data && r.data.length) return Array.prototype.slice.call(r.data).map(String);
    } catch (e) {}
    return [];
  }
  function pickPaths(chooseDir, title, fileTypes, allowMulti) {
    var cepFs = (typeof window !== "undefined" && window.cep && window.cep.fs) ? window.cep.fs : null;
    if (cepFs && typeof cepFs.showOpenDialog === "function") {
      try {
        var r = cepFs.showOpenDialog(!!allowMulti, !!chooseDir, title, "",
                                     chooseDir ? "" : (fileTypes || []));
        return Promise.resolve(pickResultList(r));
      } catch (e) { /* 退回回调版 */ }
    }
    return new Promise(function (resolve) {
      if (!cepFs || typeof cepFs.showOpenDialogEx !== "function") return resolve([]);
      try {
        cepFs.showOpenDialogEx(
          !!allowMulti, !!chooseDir, title, "",
          chooseDir ? [] : (fileTypes || []), "", "", "",
          function (result) { resolve(pickResultList(result)); },
          function () { resolve([]); }
        );
      } catch (e2) { resolve([]); }
    });
  }
  function pickPath(chooseDir, title, fileTypes) {
    return pickPaths(chooseDir, title, fileTypes, false).then(function (l) {
      return l.length ? l[0] : "";
    });
  }

  // 默认导出目录：系统「图片」目录（不存在则退回用户主目录）
  function defaultExportDir() {
    try {
      if (!osMod || !osMod.homedir) return "";
      var home = osMod.homedir();
      var pics = pathMod ? pathMod.join(home, "Pictures") : (home + "\\Pictures");
      try { if (fs && fs.existsSync(pics)) return pics; } catch (eP) {}
      return home;
    } catch (e) { return ""; }
  }

  async function chooseDir() {
    var dir = await pickPath(true, "选择导出目录");
    if (!dir) {
      log("未获取到目录。可直接把路径粘贴到输入框（如 D:\\导出），或点「用文档目录」", "err");
      return;
    }
    if ($("expDir")) $("expDir").value = dir;
    persistNow(true);
    log("导出目录：" + dir);
  }

  // 一键用"当前文档所在目录"
  async function useDocDir() {
    try {
      var j = parseJsx(await evalJSX("PSAI_docPath()"));
      if (!j.path) {
        return log("当前文档还没保存到磁盘，取不到它的目录。先保存文档，或手动填/选择目录", "err");
      }
      if ($("expDir")) $("expDir").value = j.path;
      persistNow(true);
      log("导出目录已设为文档所在目录：" + j.path, "ok");
    } catch (e) {
      log("取文档目录失败：" + (e && e.message ? e.message : e), "err");
    }
  }

  async function exportGroups() {
    if (!expGroups.length) return log("请先点「读取文档中的组」", "err");
    if (!fs) return log("Node 文件系统不可用，无法导出", "err");
    var picked = [];
    var box = $("expList");
    if (box) {
      var cbs = box.querySelectorAll("input[type=checkbox]");
      for (var i = 0; i < cbs.length; i++) {
        if (cbs[i].checked) picked.push(parseInt(cbs[i].getAttribute("data-idx"), 10));
      }
    }
    if (!picked.length) return log("请先勾选要导出的组", "err");
    var dir = ($("expDir") ? $("expDir").value : "").trim();
    if (!dir) {
      dir = defaultExportDir();                       // 留空不阻塞：自动用系统「图片」目录
      if (!dir) return log("请先选择或填写导出目录", "err");
      if ($("expDir")) $("expDir").value = dir;
      log("未指定目录，已使用默认目录：" + dir);
    }
    var fmt = $("expFormat") ? $("expFormat").value : "png";
    var ext = (fmt === "jpg") ? ".jpg" : ".png";
    var q = parseInt($("expQuality") ? $("expQuality").value : "90", 10);
    if (!(q >= 1 && q <= 100)) q = 90;
    var trim = ($("expTrim") && $("expTrim").value === "content") ? 1 : 0;

    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (eMk) {
      return log("导出目录不可用：" + (eMk && eMk.message ? eMk.message : eMk), "err");
    }

    // 粒度：整组一张 / 组内每项一张（先展开成任务列表，便于显示总张数）
    var perItem = ($("expGran") && $("expGran").value === "children");
    var tasks = [];
    for (var pi = 0; pi < picked.length; pi++) {
      var gid = picked[pi];
      var grp = null;
      for (var gk = 0; gk < expGroups.length; gk++) {
        if (expGroups[gk].idx === gid) { grp = expGroups[gk]; break; }
      }
      var gName = grp ? grp.name : ("group" + gid);
      var kids = (grp && grp.children) ? grp.children : [];
      if (perItem && kids.length) {
        for (var ci = 0; ci < kids.length; ci++) {
          tasks.push({
            idx: gid, sub: ci,
            name: kids[ci].name || (gName + "_" + (ci + 1))
          });
        }
      } else {
        tasks.push({ idx: gid, sub: -1, name: gName });
      }
    }
    var go = $("expGo");
    if (go) go.disabled = true;
    var okN = 0, failN = 0, used = {};
    log("开始导出 " + tasks.length + " 张（" + picked.length + " 个组" +
        (perItem ? "，组内逐项" : "") + "）...");
    try {
      for (var k = 0; k < tasks.length; k++) {
        var t = tasks[k];
        var base = sanitizeName(t.name);
        var key = base.toLowerCase();
        used[key] = (used[key] || 0) + 1;
        if (used[key] > 1) base = base + "_" + used[key];   // 同批重名加序号
        var outPath = dir.replace(/[\\\/]+$/, "") + "\\" + base + ext;
        var prog = "(" + (k + 1) + "/" + tasks.length + ") ";
        log(prog + "正在导出 " + base + ext + " ...");
        try {
          var r = parseJsx(await evalJSX(
            "PSAI_exportGroup(" + t.idx + "," + JSON.stringify(fmt) + "," + q + "," + trim + "," +
            JSON.stringify(outPath) + "," + t.sub + ")"
          ));
          // 以"文件真的落盘"为准判成功（防路径字符/权限导致静默失败）
          var wrote = false;
          try { wrote = fs.existsSync(outPath); } catch (eEx) {}
          if (!wrote) throw new Error("PS 未写出文件，请检查导出目录与读写权限");
          var mb = "";
          try { mb = Math.round(fs.statSync(outPath).size / 1048576 * 100) / 100 + " MB"; } catch (eSt) {}
          okN++;
          log(prog + "已导出 " + base + ext + "（" + r.w + "×" + r.h + (mb ? "，" + mb : "") + "）" +
              (k + 1 < tasks.length ? "\n继续下一张..." : ""), "ok");
        } catch (eOne) {
          failN++;
          log(prog + "导出失败：" + (eOne && eOne.message ? eOne.message : eOne) +
              (k + 1 < tasks.length ? "\n继续下一张..." : ""), "err");
        }
      }
    } finally {
      if (go) go.disabled = false;
    }
    log("导出完成：成功 " + okN + " / " + (okN + failN) + " 张" +
        (failN ? "，失败 " + failN + " 张（见上方日志）" : "") +
        "\n格式 " + ext + " ｜ 目录：" + dir, failN ? "err" : "ok");
  }


  // ---------- 尺寸 ----------
  async function resolveSize(sel) {
    var v = $("size").value;
    if (v === "1K" || v === "2K" || v === "3K" || v === "4K") {
      var tv = tierAllowed(v);
      if (tv !== v) log("该模型不支持 " + v + " 档，已自动按 " + tv + " 请求");
      return tv;
    }
    if (v === "custom") {
      var w = parseInt($("cw").value, 10) || 2048;
      var h = parseInt($("ch").value, 10) || 2048;
      return clampSize(w, h);
    }
    // auto：选区模式按选区（外扩后）尺寸算，保证输出比例与贴回区域一致
    if (sel && sel.w > 0 && sel.h > 0) {
      var t0 = Math.max(sel.w * sel.h, 1048576);
      var f0 = Math.sqrt(t0 / (sel.w * sel.h));
      return clampSize(sel.w * f0, sel.h * f0);
    }
    try {
      var mode = $("refMode").value === "none" ? "doc" : $("refMode").value;
      var j = parseJsx(await evalJSX("PSAI_docInfo(" + JSON.stringify(mode) + ")"));
      var w = j.w, h = j.h;
      var target = Math.max(w * h, 1048576);
      var f = Math.sqrt(target / (w * h));
      return clampSize(w * f, h * f);
    } catch (e) {
      return "2K";
    }
  }

  // ---------- 主流程 ----------
  async function generate() {
    var tStart = Date.now(), tPrep = 0, tApi = 0;   // 分阶段耗时，用于定位"感觉慢"到底慢在哪
    var ep = $("endpoint").value.trim();
    if (ep) ep = asGenerateUrl(ep);
    var cfg = {
      endpoint: ep,
      apikey: $("apikey").value.trim(),
      model: $("model").value.trim()
    };
    if (!cfg.endpoint) return log("请先在 API 设置里填写端点", "err");
    if (!cfg.apikey) return log("请先填写 API Key", "err");
    if (!cfg.model) return log("请先填写模型 ID", "err");
    var prompt = $("prompt").value.trim();
    if (!prompt) return log("请输入提示词/指令", "err");

    // 出图张数：提示词里明确要求 ≥2 张时优先生效，否则用「出图张数」设置
    var cntEl = $("count");
    var uiCount = cntEl ? (parseInt(cntEl.value, 10) || 1) : 1;
    var promptCount = parsePromptCount(prompt);
    var count = (promptCount >= 2) ? promptCount : uiCount;
    count = Math.min(4, Math.max(1, count));   // 多张上限 4 张（主流模型常规档位）
    if (promptCount >= 2 && count !== uiCount) {
      log("提示词要求 " + promptCount + " 张 → 本次按 " + count + " 张请求（上限 4 张）");
    }
    cfg.count = count;

    persistNow(true);            // 生成前静默保存，确保重载后不丢状态
    try { } catch (e0) {}
    var go = $("go");
    go.disabled = true;
    try {
      var imageUris = [];
      var mode = $("refMode").value;
      var selInfo = null;
      var usePrompt = prompt;
      // 局部重绘统一走标准流程：整图上下文 + 原选区蒙版合成
      // （旧的"仅发送选区内容"路径已下线：它缺少上下文，会导致色调不连续与比例偏移）
      var fullctx = (mode === "selection");
      var apiPrompt = usePrompt;
      var wantTransparent = false;

      var uploadRect = null;
      if (mode === "selection") {
        var si = parseJsx(await evalJSX("PSAI_docInfo(\"selection\")"));
        if (!si.hadSel) {
          throw new Error("未检测到选区：请先用选框/套索工具框住要修改的区域，再点「生成并置入」");
        }
        var selRect = { left: si.left, top: si.top, right: si.right, bottom: si.bottom };
        log("已识别选区 " + (selRect.right - selRect.left) + "x" + (selRect.bottom - selRect.top) +
            " @ (" + selRect.left + "," + selRect.top + ")");
        var di0 = null;
        try { di0 = parseJsx(await evalJSX("PSAI_docInfo(\"doc\")")); } catch (eD0) {}
        uploadRect = planUploadRect(selRect, di0 ? di0.w : 0, di0 ? di0.h : 0);
        if (uploadRect && !uploadRect.coversSel) {
          throw new Error("选区过于贴边，无法在画布内扩出模型标准比例区域。" +
                          "请把选区往画面中间挪一些，或改用更接近矩形的框选");
        }
        if (uploadRect) {
          if (uploadRect.adjusted && uploadRect.areaGrow > 3) {
            log("提示：框选过于窄长，上传区域已外扩到 " + uploadRect.areaGrow +
                " 倍以匹配模型比例；建议改用更接近矩形的框选，效果会更聚焦");
          }
          if (uploadRect.adjusted) {
            log("框选比例与模型标准比例相差 " + uploadRect.ratioDev + "% → 自动外扩为 " +
                uploadRect.w + "x" + uploadRect.h + "（" + uploadRect.ratioLabel +
                "，以框选为中心，选区外仅作上下文）");
          } else {
            log("框选比例 " + uploadRect.ratioLabel + " 符合模型规范，按原框选上传 " +
                uploadRect.w + "x" + uploadRect.h);
          }
        }
        usePrompt = "只修改我指定的局部区域，画面其余部分必须严格保持原样" +
                    "（不要改变整体构图、背景颜色、光照与元素位置）：\n" + prompt;
      }

      if (mode !== "none") {
        var refModeUse = (mode === "selection" && fullctx) ? "doc" : mode;
        log("正在准备上传图（" + (uploadRect ? "框选外扩区" : (fullctx ? "整图" : refModeUse)) + "）...");
        var ref = uploadRect
          ? await exportRef("selection", uploadRect)
          : await exportRef(refModeUse);
        imageUris.push(ref.dataUri);
        var refMB = Math.round(ref.dataUri.length * 0.75 / 1048576 * 10) / 10;
        log("已上传 " + ref.w + "x" + ref.h + "（无损 PNG " + refMB + " MB，未做任何羽化/压缩处理）");
        if (mode === "selection" && !fullctx) {
          selInfo = { left: ref.left, top: ref.top, w: ref.w, h: ref.h };
        }
      }
      for (var i = 0; i < extraRefs.length && i < 9; i++) imageUris.push(extraRefs[i].dataUri);

      log("正在计算输出尺寸...");
      var size = uploadRect
        ? clampSize(uploadRect.w, uploadRect.h)
        : await resolveSize(fullctx ? null : selInfo);
      tPrep = Date.now();
      log("正在调用模型（size=" + size + (imageUris.length ? "，参考图 x" + imageUris.length : "") + "）...");
      // 透明底支持：提示词要求透明时改写为纯白背景请求，出图后自动抠白（局部重绘要贴回原画布，不适用）
      wantTransparent = (mode !== "selection") && promptWantsTransparent(prompt);
      if (wantTransparent) {
        apiPrompt = rewritePromptForWhiteBg(usePrompt);
        log("检测到透明底需求 → 已改写为纯白背景请求，出图后自动转为透明 PNG");
      }
      // 多张出图 = N 个并行独立请求（每次 1 张）。
      // 实测数据：方舟"原生组图"是一条请求内服务端串行出图（4 张 88.6s ≈ 22s/张），
      // 而 N 路并行独立请求总耗时≈单张（同负载 4 张约 22~30s），差异也更自然。
      var bufs = [];
      var imgSecs = [];                     // 每张实际耗时，写进完成日志
      if (cfg.count > 1) {
        var basePrompt = stripCountPhrases(apiPrompt) +
            "\n（每次只输出一张单幅完整构图，不要拼版、宫格或分格）";
        var MAX_CONC = 6;
        var results = new Array(cfg.count);
        var nextTask = 0;
        var workerCount = Math.min(MAX_CONC, cfg.count);
        log("正在并行生成 " + cfg.count + " 张（同时最多 " + workerCount + " 路请求）...");
        var szm = /^(\d+)x(\d+)$/i.exec(size);
        if (szm && Math.max(parseInt(szm[1], 10), parseInt(szm[2], 10)) > 2048) {
          log("提示：当前 size=" + size + " 偏大，单张出图耗时会成倍增加；多张试跑可把「尺寸」改成 2K 更快");
        }
        var worker = async function () {
          for (;;) {
            var myIdx = nextTask++;
            if (myIdx >= cfg.count) return;
            var one = Object.assign({}, cfg, { count: 1 });
            var tImg = Date.now();
            var got = null, lastErr = null;
            for (var att = 1; att <= 3 && !got; att++) {
              try {
                got = await callApiSmart(one, basePrompt, imageUris, size);
              } catch (eM) {
                lastErr = eM;
                var em = (eM && eM.message) ? eM.message : String(eM);
                // 并发请求可能触发平台限流：429/限流类错误退避重试，其它错误直接放弃该张
                if (att < 3 && /429|rate ?limit|too many requests|限流|QPS|throttl/i.test(em)) {
                  await new Promise(function (rs) { setTimeout(rs, 1200 * att); });
                } else break;
              }
            }
            results[myIdx] = got;
            var dtSec = ((Date.now() - tImg) / 1000).toFixed(1);
            imgSecs[myIdx] = dtSec;
            if (got) log("第 " + (myIdx + 1) + "/" + cfg.count + " 张完成，用时 " + dtSec + "s");
            else log("第 " + (myIdx + 1) + " 张失败（用时 " + dtSec + "s）：" +
                     (lastErr && lastErr.message ? lastErr.message : lastErr));
          }
        };
        var workers = [];
        for (var wi = 0; wi < workerCount; wi++) workers.push(worker());
        await Promise.all(workers);
        for (var ri = 0; ri < results.length; ri++) {
          if (!results[ri]) continue;
          for (var rj = 0; rj < results[ri].length && bufs.length < cfg.count; rj++) bufs.push(results[ri][rj]);
        }
      } else {
        bufs = await callApiSmart(cfg, apiPrompt, imageUris, size);
      }
      if (!bufs.length) throw new Error("API 未返回任何图片");
      if (wantTransparent) {
        try {
          for (var ti = 0; ti < bufs.length; ti++) {
            var tr = await transparentizeImage(bufs[ti]);
            bufs[ti] = tr.buf;
            if (tr.native) {
              log("第 " + (ti + 1) + " 张已自带透明通道（端点原生透明输出），跳过抠白");
            } else {
              var pct = Math.round(tr.touched / (tr.w * tr.h) * 100);
              log("第 " + (ti + 1) + " 张已转为透明 PNG（泛洪抠白，透明区约 " + pct + "%）");
              if (pct < 8) {
                log("提醒：透明占比偏低，背景可能不是纯白（或商品贴边）。可在提示词里强调「背景为均匀纯白色」后重试", "err");
              }
            }
          }
        } catch (eT) {
          log("透明化失败，按原图继续：" + (eT && eT.message ? eT.message : eT), "err");
        }
      }
      tApi = Date.now();
      var buf = bufs[0];
      resultBuf = buf;
      for (var bi = bufs.length - 1; bi >= 0; bi--) {   // 多张全部进历史（倒序压入，最新集在前）
        history.push({ buf: bufs[bi], prompt: prompt });
        if (history.length > 12) history.shift();
      }
      renderHistory();
      showPreview(buf);
      if (bufs.length > 1) log("已生成 " + bufs.length + " 张：第 1 张按当前模式置入，其余自动作为图层放入文档...");
      var fv = parseInt($("feather").value, 10);
      if (isNaN(fv) || fv < 0) fv = 0;
      var resultMsg = "";   // 置入结果描述（多张时与"其余入图层"说明合并到一条日志）
      if (mode === "selection" && fullctx) {
        var shX = 0, shY = 0, shInfo = "";
        var fitMode = "stretch";
        var docSize = null;
        try {
          docSize = parseJsx(await evalJSX("PSAI_docInfo(\"doc\")"));
        } catch (eD) {}
        // 探测模型输出尺寸，决定适配策略
        try {
          var objUrl = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/png" }));
          var resSize = await getImageSize(objUrl);
          try { URL.revokeObjectURL(objUrl); } catch (eR) {}
          if (uploadRect && resSize && resSize.h > 0) {
            fitMode = "stretch";
            var ratioError = Math.abs((resSize.w / resSize.h) / (uploadRect.w / uploadRect.h) - 1);
            shInfo = "；原位映射 " + uploadRect.w + "x" + uploadRect.h +
              "，无二次配准" + (ratioError > 0.02 ? "；模型输出比例不符，已按两轴还原（模型重构的内容不保证恢复）" : "");
            log("模型输出 " + resSize.w + "x" + resSize.h + " → 回贴区域 " +
              uploadRect.w + "x" + uploadRect.h + " @ (" + uploadRect.left + "," + uploadRect.top + ")");
          } else if (docSize && resSize && resSize.h > 0) {
            var rRes = resSize.w / resSize.h, rDoc = docSize.w / docSize.h;
            var dev = Math.abs(rRes / rDoc - 1);
            var forceStretch = ($("forceStretch") && $("forceStretch").checked);
            if (forceStretch) {
              fitMode = "stretch";
              shInfo = "；已强制按画布比例拉伸匹配（可能变形）";
            } else if (dev > 0.02) {
              fitMode = "cover";
              shInfo = "；遵循模型输出比例 " + resSize.w + "x" + resSize.h + "（等比缩放，不变形，溢出部分裁到画布外）";
            } else {
              fitMode = "stretch";
              shInfo = "；输出比例与画布一致（等比即等价，无变形）";
            }
            var mag = (docSize && resSize.w > 0) ? (docSize.w / resSize.w) : 1;
            var magNote = mag > 1.02
              ? ("（输出低于画布，放大 " + mag.toFixed(2) + " 倍，画面会略糊）")
              : (mag < 0.98 ? ("（输出高于画布，缩小 " + (1 / mag).toFixed(2) + " 倍，清晰）") : "（与画布同级，无放大）");
            log("模型输出 " + resSize.w + "x" + resSize.h + " / 画布 " + docSize.w + "x" + docSize.h +
                " " + magNote + shInfo);
          }
        } catch (eS) {
          log("输出尺寸探测跳过(" + (eS && eS.message ? eS.message : eS) + ")");
        }
        var fsX = 1, fsY = 1;
        // 局部内容本来就会改变；无稳定锚点时不根据内容差异二次挪动选区结果。
        if ($("autoAlign") && $("autoAlign").checked && imageUris.length && !uploadRect) {
          log("正在配准模型输出与原图（检测位移与变形）...");
          try {
            var di = docSize || parseJsx(await evalJSX("PSAI_docInfo(\"doc\")"));
            var ft = await detectFineTransform(imageUris[0], buf,
              uploadRect ? uploadRect.w : di.w, uploadRect ? uploadRect.h : di.h);
            var sxp = (ft.fineScaleX - 1) * 100, syp = (ft.fineScaleY - 1) * 100;
            if (Math.abs(sxp) > 0.05 || Math.abs(syp) > 0.05) {
              fsX = ft.fineScaleX; fsY = ft.fineScaleY;
            }
            if (Math.abs(ft.shiftX) >= 2 || Math.abs(ft.shiftY) >= 2) {
              shX = ft.shiftX; shY = ft.shiftY;
            }
            var parts = [];
            if (fsX !== 1 || fsY !== 1) {
              parts.push("变形(" + sxp.toFixed(2) + "% / " + syp.toFixed(2) + "%)已抵消");
            } else {
              parts.push("无形变");
            }
            if (shX !== 0 || shY !== 0) {
              parts.push("位移(" + shX + "," + shY + ")已补偿");
            } else {
              parts.push("无位移");
            }
            shInfo = "，" + parts.join("，");
          } catch (eA) {
            shInfo = "，配准跳过(" + (eA && eA.message ? eA.message : eA) + ")";
          }
        }
        log("生成完成，正在按选区形状合成...");
        var pm = await placeMasked(buf, fv, shX, shY, fitMode, fsX, fsY,
          uploadRect ? uploadRect.left : -1, uploadRect ? uploadRect.top : -1,
          uploadRect ? uploadRect.w : 0, uploadRect ? uploadRect.h : 0);
        resultMsg = "已合成：可见范围 " + pm.visibleW + "x" + pm.visibleH +
            (uploadRect && uploadRect.adjusted ? "（合成基准 " + uploadRect.ratioLabel + "）" : "") + shInfo +
            "，选区已保留（可连续生成）\n选区内为 AI 重绘结果，选区外原图未改动；蒙版羽化 " + fv +
            "px（仅用于消除接缝锯齿，不参与上传）";
      } else if (selInfo) {
        log("生成完成，正在贴回选区位置...");
        var pr = await placeAtRect(buf, selInfo.left, selInfo.top, selInfo.w, selInfo.h, fv);
        resultMsg = "已贴回：目标(" + selInfo.left + "," + selInfo.top + ") " +
            selInfo.w + "x" + selInfo.h + " → 实际(" + pr.placedLeft + "," + pr.placedTop + ") " +
            pr.placedW + "x" + pr.placedH + "，缩放 " + Math.round(pr.scale * 100) + "%" +
            (pr.feathered ? "，已加 " + fv + "px 羽化蒙版融合" : "，未羽化（硬边贴回）");
      } else {
        log("生成完成，正在置入文档...");
        var pl = await placeIntoDoc(buf);
        resultMsg = "已置入当前文档（智能对象图层）" + (pl && pl.hadSel ? "，原选区已保留" : "");
      }
      // 多张结果：其余各张直接作为图层放入文档（默认隐藏，不遮挡第 1 张）
      var extraNote = "";
      if (bufs.length > 1) {
        var extraPlaced = 0;
        for (var xi = 1; xi < bufs.length; xi++) {
          try {
            await placeIntoDoc(bufs[xi], { visible: false, name: "AI 结果 " + (xi + 1) });
            extraPlaced++;
          } catch (eX) { /* 单张失败不影响其余 */ }
        }
        extraNote = "\n本次共 " + bufs.length + " 张：第 1 张如上；其余 " + extraPlaced +
                    " 张已作为图层放入文档（默认隐藏，图层面板点亮眼睛即可对比查看）";
      }
      var tEnd = Date.now();
      var sec = function (a, b) { return ((b - a) / 1000).toFixed(1) + "s"; };
      var imgInfo = "";
      if (imgSecs.length) {
        var okSecs = [];
        for (var si = 0; si < imgSecs.length; si++) { if (imgSecs[si]) okSecs.push(imgSecs[si] + "s"); }
        if (okSecs.length) imgInfo = "（单张：" + okSecs.join(" / ") + "）";
      }
      log(resultMsg + extraNote +
          "\n耗时明细（size=" + size + "）：准备 " + sec(tStart, tPrep) +
          " ｜ 模型 " + sec(tPrep, tApi) + imgInfo +
          " ｜ 置入 " + sec(tApi, tEnd) +
          " ｜ 合计 " + sec(tStart, tEnd), "ok");
    } catch (e) {
      log("失败: " + (e && e.message ? e.message : String(e)) +
          "\n反馈 / 求助：加 QQ 2584818650（DongPS 作者 AAdong）", "err");
    } finally {
      go.disabled = false;
    }
  }

  function showPreview(buf) {
    $("pv").src = toDataUri(buf, "image/png");
    $("previewWrap").style.display = "block";
  }
  function renderHistory() {
    var wrap = $("historyWrap"), box = $("history");
    if (!history.length) { wrap.style.display = "none"; return; }
    wrap.style.display = "block";
    box.innerHTML = "";
    for (var i = history.length - 1; i >= 0; i--) {
      (function (item) {
        var img = document.createElement("img");
        img.src = toDataUri(item.buf, "image/png");
        img.title = item.prompt;
        img.addEventListener("click", async function () {
          try {
            log("正在置入历史结果...");
            await placeIntoDoc(item.buf);
            log("已置入", "ok");
          } catch (e) {
            log("置入失败: " + e.message, "err");
          }
        });
        box.appendChild(img);
      })(history[i]);
    }
  }

  // ---------- 事件绑定 ----------
  function init() {
    loadCfg();
    bind("saveCfg", "click", saveCfg);
    bind("detect", "click", detectModels);
    bind("checkEp", "click", checkEndpoint);
    // 我的预设：保存 / 删除 / 载入
    bind("presetSave", "click", savePreset);
    bind("presetDel", "click", deletePreset);
    bind("presetName", "keydown", function (e) { if (e.key === "Enter") savePreset(); });
    bind("presetUser", "change", function () {
      var el = $("presetUser");
      if (!el || el.value === "") return;
      applyPreset(parseInt(el.value, 10));
      // 保留当前选中项：删除按钮按"下拉里选中的预设"删除，
      // 若在此复位，用户会变成"选中→载入→复位"，导致选不中、删不掉（v1.9.20 修复）
    });

    bind("go", "click", generate);
    bind("place", "click", async function () {
      if (!resultBuf) return;
      try {
        await placeIntoDoc(resultBuf);
        log("已置入", "ok");
      } catch (e) { log("置入失败: " + e.message, "err"); }
    });
    bind("addRefs", "click", addExtraRefs);
    bind("clearRefs", "click", clearExtraRefs);
    bindCollapse("cfg");
    bindCollapse("adv");
    bindCollapse("sponsor");

    // 导出组为图片
    bindCollapse("exp");
    bind("expRefresh", "click", refreshGroups);
    bind("expAll", "click", function () { setAllGroups(true); });
    bind("expNone", "click", function () { setAllGroups(false); });
    bind("expPick", "click", chooseDir);
    bind("expDirDoc", "click", useDocDir);
    bind("expGo", "click", exportGroups);
    bind("expToggle", "click", function () {
      // 展开时：目录留空则预填默认目录（不阻塞导出），并自动读一次组
      if ($("expDir") && $("expDir").value.trim() === "") {
        var d = defaultExportDir();
        if (d) $("expDir").value = d;
      }
      if (!expGroups.length) refreshGroups();
    });
    bind("expFormat", "change", function () {
      var isJpg = $("expFormat").value === "jpg";
      if ($("expQRow")) $("expQRow").style.display = isJpg ? "flex" : "none";
      persistNow(true);
    });
    bind("expTrim", "change", function () { persistNow(true); });
    bind("expGran", "change", function () {
      renderGroupList();        // 右侧提示随粒度切换（尺寸 ↔ 张数）
      persistNow(true);
    });
    bind("expQuality", "change", function () { persistNow(true); });
    bind("expDir", "change", function () { persistNow(true); });
    bind("copyQQ", "click", function () {
      var ok = copyText("2584818650");
      log(ok ? "QQ 号已复制：2584818650，加好友请说明「DongPS 反馈」"
             : "复制失败，请手动记录反馈 QQ：2584818650", ok ? "ok" : "err");
    });
    if (typeof window !== "undefined") {
      var persistOnExit = function () { persistNow(true); };
      window.addEventListener("beforeunload", persistOnExit);
      window.addEventListener("pagehide", persistOnExit);   // CEP 关闭/重载时 beforeunload 不总触发，pagehide 兜底
    }
    // 填完即存（blur/回车触发 change）：URL、Key 不点「保存设置」也不丢
    bind("endpoint", "change", function () { persistNow(true); });
    bind("apikey", "change", function () { persistNow(true); });
    // 模型下拉（自绘）：点按/聚焦输入框展开；选择项或点击其他区域关闭
    bind("model", "mousedown", function (e) { e.stopPropagation(); toggleModelDd(); });
    bind("model", "focus", function () { openModelDd(); });
    bind("model", "blur", function () { setTimeout(closeModelDd, 150); });
    bind("model", "keydown", function (e) { if (e.key === "Escape") closeModelDd(); });
    bind("model", "change", function () {
      var v = $("model").value.trim();
      // 手动输入用过的模型记入下拉（报错提示中承诺的行为）
      if (v && modelOptions.indexOf(v) < 0) { modelOptions.unshift(v); if (modelDd) renderModelDd(); }
      persistNow(true);
    });
    document.addEventListener("mousedown", function (e) {
      if (!modelDd || modelDd.style.display !== "block") return;
      if (modelDd.contains(e.target) || e.target === $("model")) return;
      closeModelDd();
    });
    // 滚动处理：页面滚动时下拉跟随输入框重新定位（不再整页一滚就关）；
    // 下拉自身滚动（滚轮预览列表）原样放行
    document.addEventListener("scroll", function (e) {
      if (!modelDd || modelDd.style.display !== "block") return;
      if (e.target === modelDd || modelDd.contains(e.target)) return;
      var r = $("model").getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { closeModelDd(); return; }
      modelDd.style.left = r.left + "px";
      modelDd.style.top = (r.bottom + 2) + "px";
    }, true);
    window.addEventListener("resize", function () {
      if (modelDd && modelDd.style.display === "block") openModelDd();
    });
    bind("size", "change", function () {
      $("customSizeRow").style.display = $("size").value === "custom" ? "flex" : "none";
      persistNow(true);
    });
    bind("tpl", "change", function () {
      if ($("tpl").value) $("prompt").value = $("tpl").value;
    });
  }

  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState === "complete" || document.readyState === "interactive") init();
})();
