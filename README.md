# JMBridge

JM APP 接口的三线路聚合网关，外加一个**手机优先的漫画阅读器前端**。
后端 Python（FastAPI），前端原生 ES modules —— 运行时零依赖，不需要 Node.js。

接口协议（签名、AES 解密、图片打乱还原）全部来自对 `JMComic3 v2.1.12` 的静态还原，
见 workspace 里的 `apk_jm/src_recovered/`。

## 快速开始

```bash
pip install fastapi uvicorn httpx cryptography pillow
python run.py            # http://127.0.0.1:8902
```

数据默认写在 `./data/`（可用环境变量 `JMBRIDGE_HOME` 改到别处）：

| 文件 | 内容 |
| --- | --- |
| `data/settings.json` | 运行设置（线路、压缩档位、缓存上限、接口语言） |
| `data/cache.db` | 缓存索引（SQLite），blob 落在 `data/cache/<kind>/` |
| `data/library.db` | 阅读进度与收藏（**不会被缓存淘汰**） |

## 界面

手机优先；≥900px 自动切换成左侧栏 + 多列网格。

```
首页    继续阅读 / 推荐货架 / 最新上架（无限滚动）/ 随便看看
浏览    分类 + 子分类 / 六档排序 / 标签筛选 / 週刊
搜索    热门标签 / 历史 / 400ms 防抖 / 无限滚动 / 深度搜索（SSE）
书架    阅读历史 + 收藏
我的    线路 / 缓存 / 压缩 / 语言设置，下载任务与缓存管理入口
```

### 阅读器

只做**竖向连续滚动**（特意不做左右翻页 / 双页 —— 见 `PLAN_APP_UI.md`），把这一条体验打磨到底：

- **图片边下边显**：页面不是一张等下载完才出现的图，而是服务端切好的**质量阶梯帧**
  （360px / 780px / 原图）。前端用 `fetch` + `ReadableStream` 自己解析帧，
  每收一帧就 `createImageBitmap` 后画到 `<canvas>` 上 —— 第一帧只占整页约 6%，
  弱网下几秒就能看着读，剩下的时间里同一张画布逐级变清晰。
  加载中的占位是一道**从下往上升的水位波浪**（`--p` 驱动，真实下载进度），
  上面显示页码与百分比；中途失败会保留已经画出来的部分并给「重试」。
- **虚拟化**：只渲染视口上下各 2 页；2730 页的连载在 DOM 里也只有 6 个 `<canvas>`，
  滚动条长度靠前缀和算出来，滚到哪页由二分查找定位，离开窗口的画布立即释放位图。
- **精确占位**：页面落盘时把 `宽/高` 写进缓存 meta，`/api/read/{cid}/sizes` 一次性取回，
  图片还没下载就已经占好正确的高度，长章节滚动不会跳。
- **进度**：翻页节流上报（800ms 合并），切后台/关页面用 `sendBeacon` 兜底，
  下次打开直接回到上次那一页。
- **工具栏**：顶部返回/标题（点开章节抽屉）/页码/下载/设置；底部滑杆（拖动显示缩略图气泡）、
  上一章/目录/跳页/下一章。3 秒无操作自动淡出，轻点屏幕再回来；末页有「本章完 · 下一章」卡片。
- **手势与键盘**：单击切换工具栏、双击在 1× 与 1.8× 之间缩放；`↑/↓` `PageUp/PageDown`
  `Home/End` `+`/`-` `f`（全屏）`Esc`（退出）。
- **阅读设置**（底部抽屉）：图片适配（宽/高/原始）、页间距、预取页数、工具栏自动隐藏时长、
  亮度遮罩、缩放、页码显示开关 —— 全部存在 localStorage。

### 封面：原样透传 + 三级命中 + 排队挂起

封面**不在服务端做任何编解码**，CDN 给什么字节就转发什么字节（`Content-Type` 也照抄）。
三级顺序，按代价从快到慢：

| 层 | 来源 | 是否排队 | 是否占并发名额 |
| --- | --- | --- | --- |
| 1 | 内存里已有的字节 | 否 | 否 |
| 2 | 磁盘缓存（`thumb` 类） | 否 | 否 |
| 3 | 远程 CDN | **是** | **是** |

只有第 3 层受限：全局 12 个 CDN 名额（实测 12 张冷封面 6 个名额要 16.2s，12 个名额 5.9s）。
排到的请求**不返回占位体、不返回错误**，而是让连接一直挂着 —— 浏览器保持 pending，
瓦片底下的波浪做不确定态扫动，所以等待看起来像"正在加载"而不是"坏了"。
一条坏封面不会再卡住一整批（这是放弃批量合流的原因）。

实测：首次 2.6s 拿全，之后同尺寸命中磁盘层 **0.34s**。

> 页面图仍然走质量阶梯帧（WebP 不能截断解码，页面只能等整个文件到齐再出低清帧）。
> 帧格式见下。

### 帧格式

```
magic "JMPG2"(5) | asset(4, big-endian) | kind(8, 以 \0 补齐)
                 | width(4) | height(4) | payload length(4) | payload
```

`kind`：`pr`（JSON 进度 `{r,t,p}`）、`p1`/`p2`/`p3`/`pf`（JPEG 帧，越大越清晰）、`err`。

## 三线路聚合

启动时从远端加密线路表拉取最新主机，探测延迟，取最快的三条常驻：

- **API 请求** 走延迟最低的线路，失败自动故障转移（最多重试三条）。
- **图片请求** 按「在途请求数 → 延迟」排序，分摊到不同线路，避免单线被打满。
- 前端「设置」里可固定单条线路，或改聚合条数（1–3）。

## 协议要点

```
Token:      md5(unix秒 + "185Hcomic3PAPP7R")
Tokenparam: "<unix秒>,2.1.12"
响应解密:   AES-256-ECB，key = md5(秒 + "185Hcomic3PAPP7R")
            回退       key = md5(秒 + "18comicAPPContent")
线路表解密: AES-256-ECB，key = md5("diosfjckwpqpdfjkvnqQjsik")
```

图片打乱还原与官方阅读器完全一致（`descramble.py`）：

```
num = NUM_TABLE[ord(md5(str(aid) + page_name)[-1]) % 10]   # aid≥421926 取 %8
仅当 aid >= scramble_id 才需要还原；page_name 是图片文件名去掉扩展名
```

## 下载任务（阅读即缓存）

打开一本漫画不再逐页懒加载，而是在后台创建一个缓存任务，按顺序把整章下完。

**三源同时打**：实测同一图片路径 `/media/photos/{aid}/{page}.webp` 在三条线路的
`img_host` 上都能取到（已验证 3/3 可用），所以每一页会按「在途数最少 + 历史速度最快」
加权分配到不同 CDN，三条线路并行拉不同页，而不是一条线路拉全部。

```
12 个并发槽位  →  按分数挑线路  →  score = (inflight + 1) / EWMA速度
```

- 每页带 3 次重试，失败换线路；速度用 EWMA 记录，慢线自动少派活。
- 实测稳定在 **12 个在途请求、约 1.6 页/秒**（60 页章节 16.8s）；纯串行约 3s/页。

**优先级 = 用户视角**：

| 行为 | 结果 |
| --- | --- |
| 滚到第 15 页 | 焦点移到 15，**前面 1–14 页直接放弃**，从 15 往后下 |
| 切到另一本 | 旧任务立刻 `paused`，新任务拿满 12 个槽位 |
| 切回来 | 旧任务 `resumed`，从上次中断处继续（已下的页不重下） |
| 关闭阅读器 / 切标签页 | 任务暂停，让出槽位 |

同一时刻只跑一个任务——就是你在看的那个。其余全部停在 `paused`，
任务页随时可以手动继续或移除。

**任务页 `#/tasks`**：SSE 推送，每 0.5 秒刷新。显示每个任务的进度、
字节数、以及逐页状态条（灰=未开始 / 蓝=下载中 / 绿=完成 / 红=失败）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tasks` | 任务列表 + 汇总 |
| GET | `/api/tasks/stream` | SSE 实时推送 |
| POST | `/api/tasks` | 创建（`foreground` 决定是否抢占） |
| POST | `/api/tasks/{cid}/focus` | 上报用户位置（页码） |
| POST | `/api/tasks/{cid}/pause`、`/resume`、`/cancel` | 控制 |
| DELETE | `/api/tasks/{cid}` | 移除 |

任务写入的就是 `pages` 缓存，阅读器直接从缓存取图，所以下完后再打开是秒开。
压缩档位同样生效：任务按当前设置的 `cache_compression` 落盘。

## 缓存

| 类别 | 内容 | 键 |
|---|---|---|
| `search` | 搜索全量结果、相册/章节元数据、推荐 | `查询\|页\|排序\|语言` |
| `thumb` | 缩略图 | `cid\|页\|边长` |
| `pages` | 漫画页面 | `cid\|页\|压缩率` |
| `zip` | 打包归档 | `cid\|模式` |
| `prog` | 页面的质量阶梯帧（阅读器 canvas 用） | `cid\|页\|压缩率` |

- 总量上限可配（默认 2048 MB），超限按 **LRU 淘汰到 90%**。
- 漫画内容压缩率四档，**压缩率是缓存键的一部分**，同一页不同档位互不覆盖：

| 模式 | 做法 | 实测体积 |
|---|---|---|
| `none` | 无损 WebP，不缩放 | 100% |
| `minimal` | q85，超过 1600px 才缩放 | ≈100%（不会大于无损） |
| `medium` | q72，上限 1280px | ≈78% |
| `max` | q52，上限 960px | ≈58% |

压缩档位带**体积守卫**：重编码后若比无损版更大，就退回无损版，保证「压缩」永远不会撑大。

## 下载 ≠ 缓存

- `GET /api/download/{cid}`：**只有无损**。未打乱的页直接原字节落盘；需要还原的页用无损 WebP
  （像素与官方阅读器完全一致）。输出 zip，文件名为作品名（RFC 5987 编码，中文标题不乱码）。
- `POST /api/cache/pack/{cid}`：按当前压缩档位打包进缓存，`zip` 类可随时清理。

## 前端结构

原生 ES modules，`static/` 直接被 FastAPI 挂载，**运行时零依赖**。

```
static/
  index.html            外壳：底栏/侧栏、内联 SVG sprite、PWA meta
  manifest.webmanifest
  css/tokens.css        设计变量（深色/浅色两套）
  css/app.css           组件与布局
  css/reader.css        阅读器
  js/api.js             纯网络层 + 格式化（无 DOM）
  js/frames.js          渐进帧解析 + canvas 绘制（页面与封面共用）
  js/ui.js              el/icon/toast/sheet/tile/section/skeleton/infiniteScroll…
  js/state.js           共享状态、主题、进度与收藏镜像
  js/app.js             路由 + 导航高亮 + 清理
  js/views/home.js      首页
  js/views/browse.js    浏览（分类/排序/标签/週刊）
  js/views/search.js    搜索（热词/历史/防抖/无限滚动/深度搜索）
  js/views/library.js   书架（历史/收藏）
  js/views/me.js        我的
  js/views/listing.js   通用网格页（"查看更多"）
  js/views/album.js     详情（hero / 章节 / 进度）
  js/views/tasks.js     下载任务（SSE）
  js/views/cache.js     缓存管理
  js/views/settings.js  设置
  js/views/reader/      index.js（装配）/ flow.js（虚拟化 canvas）/ pageimage.js（帧解析+绘制）
                        prefs.js / progress.js
```

视图契约：`export async function renderXxx(view, ctx)`，返回 `cleanup` 函数或
`{ destroy() }`；路由切走时调用。完整约定见 `static/js/views/CONTRACT.md`。

可选打包（构建期用 Node，**发布物不需要**）：

```bash
npm i -D esbuild && node build_frontend.mjs
```

## 测试

```bash
bash _syntax.sh          # 全部前端模块语法（ESM）
node _t_views.mjs        # 视图导出契约
node test_reader.mjs     # 阅读器虚拟化布局（无浏览器）
python _t_api.py         # 所有 API（需服务在跑）
python _t_ui.py          # 真实 Chrome 走全部路由，抓控制台错误并截图到 .shots/
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 线路与缓存概览 |
| GET/POST | `/api/lines`、`/api/lines/probe`、`/api/lines/discover` | 线路状态、测速、重新发现 |
| GET/POST | `/api/settings` | 读写设置 |
| GET | `/api/home` | 首页一次取全（promote / latest / hot_tags / serialization） |
| GET | `/api/recommend`、`/api/promote/list` | 推荐聚合 / 货架分页 |
| GET | `/api/latest`、`/api/serialization` | 最新 / 连载分页 |
| GET | `/api/categories`、`/api/browse` | 分类树+标签块 / 分类筛选列表 |
| GET | `/api/week` | 週刊（无参取期号索引，带参取该期内容） |
| GET | `/api/hot_tags`、`/api/random` | 热门标签 / 随机推荐 |
| GET | `/api/cover/{aid}` | 封面代理 + thumb 缓存（无图时返回占位图，不报错） |
| GET | `/api/search`、`/api/search/stream`、`/api/search/full` | 搜索 / SSE / 全量 |
| GET | `/api/album/{aid}`、`/api/read/{cid}` | 详情 / 章节页列表 |
| GET | `/api/read/{cid}/sizes` | 已缓存页的宽高（阅读器精确占位） |
| GET | `/api/chapter/{cid}/neighbors` | 上一章 / 下一章 |
| GET/POST/DELETE | `/api/progress`、`/api/progress/{cid}` | 阅读进度 |
| GET/POST/DELETE | `/api/favorites`、`/api/favorites/{aid}` | 收藏 |
| GET | `/api/library`、`/api/album/{aid}/progress` | 书架汇总 / 单本进度 |
| GET | `/api/prog/{cid}/{index}` | 页面质量阶梯帧流（阅读器 canvas 用） |
| GET | `/api/progcover/{aid}` | 封面原样透传（三级命中 + 排队挂起） |
| GET | `/api/image/{cid}/{index}` | 整页图（`mode`、`thumb` 可选；缩略图与下载用） |
| GET | `/api/pages/stream/{cid}` | 连续多页 multipart 流 |
| GET | `/api/download/{cid}` | 无损 zip |
| GET/DELETE | `/api/cache`、`/api/cache/{kind}` | 用量 / 列表 / 清理 |
| POST | `/api/cache/pack/{cid}`、`/api/cache/evict` | 打包 / 按上限整理 |
| GET/POST | `/api/tasks`、`/api/tasks/stream` | 下载任务 / SSE |

## 未实现（按需求排除）

登录、注册、评论、点赞、金币、签到、小说、视频、论坛一类接口全部没有接入。