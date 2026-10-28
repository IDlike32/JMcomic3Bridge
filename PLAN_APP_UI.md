# 前端契约（写视图前必读）

零构建：原生 ES modules，直接被 FastAPI 挂到 `/`。**不要引入任何依赖、不要用 build 步骤、不要用 JSX/TS。**

工作目录：`jmbridge_app/`。服务已在 http://127.0.0.1:8902 运行（改前端文件不用重启，浏览器刷新即可；改 Python 要重启）。

## 文件分工（不要碰别人的文件）

| 文件 | 归属 |
| --- | --- |
| `static/js/api.js` `ui.js` `state.js` `app.js` `css/*.css` `index.html` | **Lead 已定稿，只读** |
| `static/js/views/home.js` `listing.js` `browse.js` | A 组 |
| `static/js/views/search.js` `library.js` | B 组 |
| `static/js/views/album.js` `me.js` | C 组 |
| `static/js/views/reader/*.js` | D 组 |
| `static/js/views/tasks.js` `cache.js` `settings.js` | Lead |

## 视图契约

每个视图导出一个异步函数，签名固定：

```js
export async function renderXxx(view, ctx) { ... return cleanup; }
```

- `view` 是已经清空的 `<main id="view">` DOM 节点，往里 append。
- `ctx = { rest: string[], query: URLSearchParams }`。例如 `#/album/123` → `rest = ["123"]`。
- 返回值：`undefined`、或 `function cleanup()`、或 `{ destroy() }` —— 路由切走时调用，用来 `clearInterval` / 关 `EventSource` / `removeEventListener`。
- 渲染前先放 `skeletonGrid()` / `loadingRow()`，失败放 `errorState(msg, retry)`，空列表放 `emptyState({...})`。**不要用空 div + 转圈替代骨架屏。**
- 所有用户可见文案用简体中文，语气克制、不要感叹号堆砌。

## 路由表（app.js 已经实现，别改）

```
#/home                     首页
#/browse                   浏览（分类 / 排序 / 标签 / 週刊）
#/search?q=&o=             搜索
#/library                  书架（历史 / 收藏）
#/me                       我的
#/album/{aid}               详情
#/read/{cid}?aid={aid}      阅读器
#/listing?kind=&c=&o=&q=&title=   通用网格页（"查看更多"）
#/tasks  #/cache  #/settings
```

`listing` 的 `kind`：`latest` / `browse` / `promote`（配 `id`）/ `search`（配 `q`、`o`）/ `serialization`。
`listing` 内部一律用 `pageHead(title, { back: () => history.back() })` + 无限滚动网格。

## `api.js`（只读，全部返回已解包的 data）

```
api.health() api.lines() api.discoverLines() api.probeLines()
api.settings() api.saveSettings(patch)
api.home()                                     -> { promote:[{title,content:[item]}], latest:[item], hot_tags:[str], serialization:[item] }
api.latest(page)                               -> { page, items:[item], total }
api.serialization(page, type, date)            -> { page, items, total }
api.categories()                               -> { categories:[{id,name,slug,total_albums,sub_categories:[{CID,name,slug}]}], blocks:[{title,content:[str]}] }
api.browse(c, o, page)                         -> { c, o, order, page, items, total }
api.week(id, type)                             -> 无参 { categories:[{id,title,time}], types:[{id,title}] } / 有参 { items, total }
api.hotTags()                                  -> [str]
api.random()                                   -> [item]
api.promoteList(id, page)                      -> { total, list:[item] }
api.search(q, page, o)                         -> { page, items, total }
api.searchFull(q, o, maxPages)                 -> { items, total, pages }
api.searchStreamUrl(q, o)                      -> url（EventSource 用，事件 start/page/done/error）
api.album(aid)                                 -> 见下方字段
api.albumProgress(aid)                         -> { aid, items:[progress], favorite: bool }
api.read(cid)                                  -> { id, name, total_page, images:[{page,image}], scramble_id, series_id }
api.readSizes(cid, mode)                       -> { sizes: { "1": [w,h], ... } }
api.neighbors(cid, aid)                        -> { cid, aid, index, total, prev:{id,name}|null, next:{id,name}|null }
api.progressList(limit)                        -> { items:[progress], stats }
api.progressGet(cid)                           -> progress|null
api.progressSet({ cid, page, total, aid, title, album }) -> progress
api.progressDelete(cid)
api.favorites()                                -> { items, stats }
api.favoriteAdd({ aid, title, author })        -> record
api.favoriteRemove(aid)
api.library()                                  -> { progress:[progress], favorites:[fav], stats }
api.tasks() api.task(cid) api.taskPages(cid,mode) api.createTask(cid,title,aid,foreground)
api.taskPages(cid, mode)                       -> { state, total, cached, failed, pages:[{page,index,state,cached,attempts,w,h}] }
api.eventsUrl()                                -> SSE 事件流（page-stored / cover-stored），不要再轮询
api.coversStatus(aids, size)                   -> { ready: { aid: bool } }（一次查一整屏封面）
api.coversWant(aids, size)                     -> { queued, stats }（让后台去抓，前端不等）
api.focusTask(cid,page) api.pauseTask api.resumeTask api.cancelTask api.deleteTask
api.tasksStreamUrl()                           -> SSE url（事件 tasks）
api.cache() api.cacheList(kind,limit,offset) api.cacheClear(kind)
api.cacheDeleteItem(kind,key) api.cacheDropPages(cid) api.cacheEvict() api.cachePack(cid,mode)
api.coverUrl(aid, size)                        -> 封面代理 URL（**不要自己拼 CDN**）
api.progUrl(cid, index, aid, scramble, mode)   -> 渐进帧流（旧阅读器用；现已不引用，同样只读缓存）
api.progCoverUrl(aid, size)                    -> 封面（原样透传；tile() 内部已经用了这个）
api.pageUrl(cid, index, aid, scramble, mode)   -> 整页图（**只读缓存**：未缓存返回 503，不会去 CDN 抓）
api.thumbUrl(cid, index, aid, scramble, size)  -> 缩略图（同样只读缓存）
api.progCoverUrl(aid, size)                    -> 封面（**只读缓存**：未缓存返回 503 并自动排队，靠事件流补图）
api.downloadUrl(cid, title)
```

格式化：`fmtBytes(n)` `fmtNum(n)` `fmtAgo(ts秒)` `itemTitle(item)` `itemAuthor(item)` `itemCategory(item)` `itemCoverId(item)` `qs(obj)`

**album 字段**：`id name description author[] tags[] works[] actors[] total_photos total_views likes comment_total addtime series:[{id,name,sort}] series_id related_list:[item]`

**progress 字段**：`{ cid, aid, title, album, page, total, finished, updated, percent }`

**item 字段**（列表项）：`{ id, name, author, category:{id,title}, category_sub:{id,title}, update_at }`；`random`/`week` 里还带 `description`。

## `ui.js`（只读）

```
el(tag, attrs, children)           attrs: class/text/html/style/on*/任意属性
icon(name) iconButton(name,onClick,{title,class})
toast(msg, ms)
openSheet({ title, subtitle, body, onClose }) -> { sheet, close }
confirmDialog({ title, message, okText, cancelText, danger }) -> Promise<bool>
segControl({ options:[{label,value}], value, onChange }) -> node 且 node.set(v) / node.get()
chipStrip([str|{label,value}], { value, onChange, allowEmpty }) -> node 且 node.set(v)
tile(item, { cover, sub, badge, progress, favorite, onFavorite, onOpen, onMenu, note })
tileGrid(items, opts) rail(items, opts)
sectionHead(title, { sub, more:{label,onClick} }) section(title, { ...sectionHead, body })
skeletonGrid(n) skeletonRail(n) skeletonTile() loadingRow(text)
emptyState({ icon, title, text, actionLabel, onAction }) errorState(msg, retry)
listRow({ icon, title, desc, trailing, onClick, chevron })
statCard(value, label) pageHead(title, { sub, back, actions })
infiniteScroll(sentinelNode, async () => hasMore:boolean) -> { disconnect(), finish() }
relativeTime(ts)
```

可用图标名（`icon("x")`）：home compass search bookmark user heart download settings arrow-left
chevron-right chevron-left chevron-down close check more shuffle trash refresh clock signal
folder archive list grid filter sort expand image info play book tag zoom eye

## `state.js`（只读）

```
state.settings  state.compressionModes  state.lines  state.theme
state.progress  state.favorites  state.favoriteIds:Set  state.progressByCid:Map
isFavorite(aid) toggleFavorite({aid|id,title|name,author}) -> Promise<bool>（已写好乐观更新）
progressFor(cid) continueReading(limit) -> progress[]
refreshSettings() saveSettings(patch) refreshLines() loadLibrary() setTheme(t) toggleTheme() restoreTheme()
```

## CSS（已写好，只用这些 class，不要写内联大段样式）

```
.page-head .back-btn
.section .section-head (h2 + .sub + .more)
.grid .rail .tile(.cover .badge .fav .progress .cap .t .s)
.panel .panel-head .list .list-row(.lead .title .desc .chev)
.stats .stat  .bar(>i)  .chips .chip(.on .plain)  .strip(横滑)
.seg(>button.on)  .btn(.primary .ghost .danger .sm .block)  .icon-btn(.on)
.input .select .searchbar(.icon .clear)
.skeleton .sk-tile(.cover .line .short)  .spinner .loading-row
.empty(.t .s)  .muted .dim .tiny .ellipsis .clamp2 .clamp3
.row(.wrap) .grow .hidden
.reader / .reader-scroll / .reader-flow / .rpage / .r-chrome / .r-bar / .r-head / .r-foot
.r-slider / .r-preview / .r-drawer / .ch-item / .r-endcard / .r-set / .r-dim / .r-loadbar / .r-hint
```

移动优先：断点 `@media (min-width: 900px)` 时侧栏替代底栏（已实现）。触摸目标 ≥ 40px。

## 质量底线

- 页面切换必须清理定时器 / SSE / 事件监听（返回 cleanup）。
- 网络失败必须给出可重试的 UI，不能白屏。
- 无限滚动：先 `IntersectionObserver` + 哨兵元素，`infiniteScroll()` 已封装。
- 图片一律 `loading="lazy"`（封面用 `ui.coverImage` 或 `tile`）。
- **图片不要用 `<img>`**：服务端把它们切成渐进帧流，客户端用 `js/frames.js` 画到 canvas。
  - 阅读页：`reader/pageimage.js` 的 `loadPageIntoCanvas(url, canvas, {...})`，
    返回 `{ cancel, done }`；离开窗口必须 `cancel()` 并把 canvas 的 `width/height` 置 0。
  - 封面：直接用 `ui.tile()` / `ui.coverCanvas(url)`，不要自己发请求 ——
    封面有全局并发窗口（浏览器每域只给 6 条连接）和三级命中（内存/磁盘/远程）。
    远程请求会被服务端**挂起**排队，期间没有字节也没有错误，靠瓦片的波浪动画撑住观感。
  - 占位的水位波浪由 CSS 的 `--p`（0..1）驱动，设了就涨，不用自己写动画。
- 不要修改 `index.html` / `css/*` / `api.js` / `ui.js` / `state.js` / `app.js`。缺组件就就地用 `el()` 组装并复用现有 class。
- 写完必须自测：`bash _syntax.sh`（语法），再 `node` 跑一个最小 DOM stub 或直接用 curl 抓页面确认没有 404 模块引用。
