# DongPS（Photoshop AI 改图工作台）— 项目说明

> 2026-09-18 完成目录重组：源码、脚本、依赖、产物、发布包、文档、归档各自独立，命名统一。

## 一、目录结构

| 目录 | 用途 | 说明 |
|---|---|---|
| `src/` | **开发源码（唯一真源）** | 改功能只动这里；构建脚本从这里取文件 |
| `scripts/` | 构建 / 打包 / 安装 / 同步脚本 + 回归测试 | 见下方对照表 |
| `tools/` | 构建依赖与开发辅助 | `node_modules/`（混淆器、jsxbin、playwright 等）、`verification/`（校验产物）、`dev/`（一次性维护脚本与运行日志） |
| `dist/` | 构建产物 | 每个版本一个目录 + 同名 `.zip` / `.zip.sha256` |
| `releases/` | 对外发布包 | 分发用 zip + sha256（`sync-protected.py` 会自动归档到这里） |
| `docs/` | 文档 | 使用说明等 |
| `archive/` | 历史归档 | 旧版解压包（v1.9.2）、原始赞助素材 |
| `.workbuddy/memory/` | 工作记录与项目约定 | 自动维护，勿删 |

## 二、源码文件（`src/`）

| 文件 | 用途 |
|---|---|
| `main.js` | 面板主逻辑：配置持久化、我的预设、模型识别、多张出图、API 调用与响应解析、尺寸换算、结果置入 PS |
| `index.html` | 面板界面（含 API 设置、我的预设、输出参数等区块） |
| `style.css` | 面板样式（暗色，跟随 PS 面板尺寸） |
| `CSXS/manifest.xml` | CEP 清单：bundle id、CEF 启动参数（含 `--disable-web-security`）、面板尺寸 |
| `jsx/host.jsx` | ExtendScript 桥（**ES3**）：导出参考图、置入结果、选区蒙版合成、图层显隐与命名 |
| `assets/sponsor/` | 随包分发的赞助素材（声明 + 收款码）。**不在 Git 版本控制内**，克隆后需手动放入，否则构建会缺文件 |

## 三、脚本对照表（`scripts/`）

| 脚本 | 用途 | 用法 |
|---|---|---|
| `build-protected.cjs` | 生成源码保护版：JS 混淆 + JSXBIN 编译 + 版本改写 + 按白名单复制 | `DONGPS_VERSION=1.9.28 node scripts/build-protected.cjs` |
| `archive-protected.py` | 打包 zip 并生成 sha256，逐文件回读校验 | `python scripts/archive-protected.py 1.9.28` |
| `sync-protected.py` | 同步到 PS 安装目录：备份旧版 → 覆盖 8 个文件 → MD5 校验 → 发布件归档到 `releases/` | `python scripts/sync-protected.py 1.9.28` |
| `install-protected.ps1` | 包内一键安装（检查 PHP 关闭、备份、复制校验、开 PlayerDebugMode） | 随发布包分发，由 `Install.bat` 调用 |
| `verify-protected.cjs` | 对保护版做函数级验证 | `DONGPS_VERSION=1.9.27 node scripts/verify-protected.cjs` |
| `tests/` | 回归与调试：PS 往返、尺寸比例、局部重绘、赞助面板截图 | 见各文件头部注释 |

## 四、标准发布流程

```bash
# 1) 改 src/ 下的源码并自测
# 2) 构建保护版
DONGPS_VERSION=1.9.28 node scripts/build-protected.cjs
# 3) 打包并校验
python scripts/archive-protected.py 1.9.28
# 4) 同步到本机 PS 安装目录（自动备份 + MD5 校验 + 归档到 releases/）
python scripts/sync-protected.py 1.9.28
# 5) 重启 Photoshop 生效
```

## 五、关键路径与环境约定

- 安装目录：`%APPDATA%\Adobe\CEP\extensions\com.lx.psai.workbench`
- 用户配置：`%APPDATA%\DongPS\dongps_config.json`（端点 / Key / 模型 / 我的预设，明文存本机）
- 回滚备份：`%APPDATA%\Adobe\CEP\extensions\backup_com.lx.psai.workbench_*`、`%APPDATA%\DongPS\plugin-backups\`
- 未签名插件需 `PlayerDebugMode=1`（CSXS.9~13）
- 本机 bash 缺 coreutils：脚本一律用 python / node 全路径执行；PowerShell 输出不回显，结果落盘再读
- 硬性规则：**真版本以保护版为准**，不要用未混淆源码直接覆盖安装目录；删除任何文件前先列清单并送回收站

## 六、`tools/dev/` 说明

存放一次性维护脚本与运行日志（历史留档，非发布链路）：
`inventory.py`（结构盘点）、`reorg.py`（本次重组）、`pathfix.py`（路径改写）、`verify_reorg.py`（重组校验）、
`cleanup_scan.py` / `cleanup_old_versions.py`（旧版清理）、`ps_status.py`（PS 连接检查）、
## 七、从本仓库克隆后如何构建

```bash
git clone <repo-url> DongPS
cd DongPS
npm --prefix tools install          # 安装混淆器 / jsxbin 等构建依赖
mkdir -p src/assets/sponsor        # 放入自己的赞助素材（可选，缺失时构建仍可完成）
node scripts/build-protected.cjs  # 需带 DONGPS_VERSION=<版本> 环境变量
```

### 不入库的内容（见 `.gitignore`）

| 内容 | 原因 |
|---|---|
| `dist/` `releases/` `archive/` | 构建产物，可由 `scripts/` 完整重建；也避免仓库体积膨胀 |
| `tools/node_modules/` | 依赖，`npm install` 可复原（83M） |
| `tools/dev/` `tools/verification/` `scripts/tests/artifacts/` | 一次性维护脚本与验证日志 |
| `src/assets/sponsor/` | 个人收款码图片与声明，不适合公开 |

> 提示：`scripts/tests/sponsor-panel.cjs` 会读取 `src/assets/sponsor/软件声明.txt` 做赞助面板回归测试，
> 该文件不在版本控制内，克隆后需自行放入才能跑这个测试（其余测试不受影响）。
| `.workbuddy/` | 本地工作记录与 Agent 上下文 |
| `dongps_config.json` `*.env` | API 端点 / Key 配置（本就存于 `%APPDATA%\DongPS\`，从不入库） |

> **安全说明**：本插件不在源码中硬编码任何 API Key，配置仅保存在用户本机
> `%APPDATA%\DongPS\dongps_config.json`。公开仓库不泄露密钥。
>
> **注意**：本仓库为**公开源码**，`src/main.js`、`src/index.html`、`src/jsx/host.jsx` 均为明文可读。
> 若需对外分发混淆后的保护版，请使用 `releases/` 中的 zip（不入库，请自行上传至 GitHub Releases）。

