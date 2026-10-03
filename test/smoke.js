/*
 * userscript 启动冒烟测试：用最小 DOM 桩把脚本真跑一遍。
 *
 * 目的不是测功能，而是抓 TDZ、声明顺序、初始化时序、以及降级路径这类
 * 只在运行时暴露的错误。零依赖，只要本机有 Node。
 *
 * 运行：
 *   node test/smoke.js                       # 场景 1：正常响应，分段遍历收敛
 *   SCENARIO=malformed   node test/smoke.js  # 场景 2：接口返回缺 code 字段，必须降级为 —
 *   SCENARIO=nostate-flat  node test/smoke.js# 场景 3：初始状态形状变体（平铺 data）
 *   SCENARIO=nostate-string node test/smoke.js#场景 4：videoData 是 JSON 字符串（线上真实形态）
 *   SCENARIO=nostate-deep  node test/smoke.js# 场景 5：数据嵌套 3 层深
 *   SCENARIO=inlinescript node test/smoke.js # 场景 6：数据只在内联 script 里，window 上没有
 *   SCENARIO=domonly      node test/smoke.js # 场景 7：只靠 DOM 的 data-cid 列表
 *   SCENARIO=perfonly     node test/smoke.js # 场景 8：只靠播放器请求里的 cid（单分P）
 *   SCENARIO=latehydrate  node test/smoke.js # 场景 9：数据在 document-idle 后才水合，必须自愈
 *   SCENARIO=paused       node test/smoke.js # 场景 10：enabled=false，必须弹「已暂停」通知
 *   SCENARIO=error        node test/smoke.js # 场景 11：全取不到，必须弹「未显示」+ 诊断信息
 *
 * 全部通过时进程退出码 0；任一失败退出码 1，可直接接 CI。共 273 项断言。
 * Windows cmd 下用 set SCENARIO=malformed 代替前缀赋值。
 *
 * 断言分三段：启动与初始渲染 → 模拟点击（面板展开 / 收起）→ countAll 收敛。
 * 四条关键不变量：
 *   1. 失败必须可见 —— paused / error 两条路径以前是静默 hideAll()，用户只看到空白页。
 *   2. 零网络依赖 —— 页面已经具备数据时不该发任何 view 请求。
 *      当初就是这条没守住，脚本落回网络请求才吃下 code=-404。
 *   3. 来源不敏感 —— nostate-* / inlinescript / domonly / perfonly 覆盖初始状态变体、
 *      内联 script 注入、只靠 DOM、只靠播放器请求四种情况。
 *   4. 不抢异步水合 —— B 站首屏数据可能在 document-idle 之后才水合，
 *      失败要有退避宽限期，一上来就报错等于跟水合抢时间（error 场景会先断言
 *      宽限期内**不该**有通知）。
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'bilibili-part-stats.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

// SCENARIO=normal      正常响应：分段遍历收敛，弹幕数应为 35
// SCENARIO=malformed   seg.so 返回缺 code 字段：必须降级为 —，绝不能误报成 0
// SCENARIO=paused      enabled=false（曾点过关闭）：必须弹「已暂停」通知，绝不能静默消失
// SCENARIO=error       页面数据 + view 接口全取不到：必须弹「未显示」通知，绝不能静默消失
const SCENARIO = process.env.SCENARIO || 'normal';
// 只有 error 场景完全没有分P数据、不可能发起分段请求；
// nostate-* 场景数据来自页面状态，弹幕数仍要真正调 seg.so，所以期望值和 normal 一致
const EXPECT_SEG = SCENARIO === 'malformed' ? 1 : SCENARIO === 'error' ? 0 : 7;

/* ---------------- 最小 DOM ---------------- */
const registry = new Map();

function mkEl(tag, attrs) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    parentElement: null,
    textContent: '',
    attributes: attrs || {},
    style: {},
    classList: {
      _s: new Set(),
      add(...cs) { cs.forEach((c) => this._s.add(c)); },
      remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
      toggle(c, f) {
        if (f === false) this._s.delete(c); else this._s.add(c);
        return this._s.has(c);
      },
      contains(c) { return this._s.has(c); },
    },
  };
  let _id = '';
  Object.defineProperty(el, 'id', {
    configurable: true,
    get() { return _id; },
    set(v) { _id = v; if (v) registry.set(v, el); else registry.delete(_id); },
  });
  let _ih = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return _ih; },
    set(v) { _ih = String(v); },
  });
  let _sib = null;
  Object.defineProperty(el, 'previousElementSibling', {
    configurable: true,
    get() { return _sib; },
  });
  el.querySelector = () => null;
  el.closest = () => null;
  el.getAttribute = function (k) { return (k in this.attributes) ? this.attributes[k] : null; };
  el.appendChild = function (c) {
    this.children.push(c);
    c.parentElement = this;
    return c;
  };
  el.remove = function () {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  };
  el.insertAdjacentElement = function (pos, node) {
    if (pos !== 'afterend') throw new Error('only afterend supported, got ' + pos);
    const p = this.parentElement;
    if (p) {
      const i = p.children.indexOf(this);
      p.children.splice(i + 1, 0, node);
      node.parentElement = p;
      _sib = p.children[i];
      Object.defineProperty(node, 'previousElementSibling', { get() { return _sib; } });
    } else {
      (this._orphan = this._orphan || []).push(node);
    }
    return node;
  };
  return el;
}

const h1 = mkEl('h1');
h1.textContent = '《明日方舟》SideStory「昨日海」活动宣传PV';
const titleBox = mkEl('div');
titleBox.appendChild(h1);
h1.closest = () => titleBox;

// domonly 场景用：页面上渲染出来的分P标签（B 站靠 data-cid 做 SPA 跳转）
const domParts = [];
if (SCENARIO === 'domonly') {
  const p1 = mkEl('li', { 'data-cid': '42391374735', 'data-p': '1' });
  p1.textContent = '【中】宣传PV  03:24';
  const p2 = mkEl('li', { 'data-cid': '42391375292', 'data-p': '2' });
  p2.textContent = '【日】宣传PV  03:24';
  domParts.push(p1, p2);
}
// 页面统计行里的「弹幕 N」
const statNode = mkEl('span');
statNode.textContent = '弹幕 8040';

// inlinescript 场景用：数据只存在于内联 script，window 全局上没有
// （PAGE 在下面才定义，所以到那儿再填）
const inlineScripts = [];

// perfonly 场景：什么本地来源都没有，只有播放器自己发出的请求里带着 cid
const videoEl = mkEl('video');
videoEl.duration = 204;

const perfEntries = (SCENARIO === 'perfonly')
  ? [{ name: 'https://api.bilibili.com/x/player/playurl?avid=1&cid=42391375292&q=64' }]
  : [];
const performanceStub = {
  getEntriesByType: function (t) { return t === 'resource' ? perfEntries : []; },
};

const handlers = {}; // 收集 document.addEventListener 注册的事件处理器

const documentStub = {
  head: mkEl('head'),
  body: mkEl('body'),
  documentElement: mkEl('html'),
  title: '《明日方舟》SideStory「昨日海」活动宣传PV_哔哩哔哩_bilibili',
  getElementById(id) { return registry.get(id) || null; },
  createElement(tag) { return mkEl(tag); },
  querySelector(sel) {
    if (sel === 'script#__INITIAL_STATE__') return null;
    if (sel === 'video') return (SCENARIO === 'perfonly') ? videoEl : null;
    if (sel.startsWith('h1') || sel.startsWith('.video-title')) return h1;
    return null;
  },
  addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
  querySelectorAll(sel) {
    if (sel === 'script') return inlineScripts;
    if (sel === '[data-cid]') return domParts;
    if (sel === 'span,div,a') return [statNode];
    return [];
  },
};

/* ---------------- 页面数据 ---------------- */
const PAGE = {
  bvid: 'BV1Rxam6kEtU',
  aid: '117370114869602',
  title: '《明日方舟》SideStory「昨日海」活动宣传PV',
  cid: '42391375292',
  pages: [
    { cid: '42391374735', page: 1, part: '【中】宣传PV', duration: 204 },
    { cid: '42391375292', page: 2, part: '【日】宣传PV', duration: 204 },
  ],
  stat: { danmaku: 8040 },
};

// inlinescript 场景：数据只在内联 <script> 里，window 全局上没有
if (SCENARIO === 'inlinescript') {
  const s = mkEl('script');
  s.textContent = 'window.__INITIAL_STATE__=' + JSON.stringify({ videoData: { data: PAGE } });
  inlineScripts.push(s);
}

let segCalls = 0;
let viewerCalls = 0;
let viewCalls = 0;

const locationStub = {
  pathname: '/video/BV1Rxam6kEtU/',
  search: '?p=2',
  href: 'https://www.bilibili.com/video/BV1Rxam6kEtU/?p=2',
};

function ok(body) { return { ok: true, status: 200, json: async () => body }; }
function htmlErr() {
  return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token < in JSON'); } };
}

// __INITIAL_STATE__ 的形状回归矩阵：B 站一直在改结构，
// readInitialState 不能钉死在某条 key 路径上，否则会误落回网络请求（进而吃风控/-404）。
//   normal / malformed : { videoData: { data: PAGE } }
//   nostate-flat       : { data: PAGE }
//   nostate-string     : { videoData: '<JSON 字符串>' }   ← 线上真实踩到的形态
//   nostate-deep       : { a: { b: { c: { data: PAGE } } } }
//   inlinescript       : window 上没有，数据只在内联 <script> 里
//   domonly / error    : window 上没有，见下
function buildInitialState() {
  switch (SCENARIO) {
    case 'nostate-flat': return { data: PAGE };
    case 'nostate-string': return { videoData: JSON.stringify({ code: 0, data: PAGE }) };
    case 'nostate-deep': return { a: { b: { c: { data: PAGE } } } };
    default: return { videoData: { data: PAGE } };
  }
}

// 这些场景 window 全局上就是没有初始状态，逼脚本走内联 script / DOM / perf 兜底
const NO_WINDOW_STATE = { error: 1, domonly: 1, inlinescript: 1, perfonly: 1, latehydrate: 1 };

// perfonly / latehydrate 场景只按单分P处理，不能用多分P视频的公共断言
const SINGLE_PART = { perfonly: 1 };

// 顺序敏感：'/x/web-interface/view/type' 也包含 '/x/web-interface/view'，必须先判前者
const fetchImpl = async (url) => {
  const u = String(url);
  if (u.includes('/x/web-interface/view/type')) {
    viewerCalls++;
    return htmlErr(); // 端点已下线的真实形态：回 HTML 而不是 JSON
  }
  if (u.includes('/x/web-interface/view?')) {
    viewCalls++;
    // latehydrate 也必须让接口失败，否则脚本会走网络提前恢复，
    // 就测不到「异步水合后靠本地数据自愈」这条路径了
    if (SCENARIO === 'error' || SCENARIO === 'latehydrate') {
      throw new Error('TypeError: Failed to fetch (CORS)');
    }
    return ok({ code: 0, data: JSON.parse(JSON.stringify(PAGE)) });
  }
  if (u.includes('/x/v2/dm/web/seg.so')) {
    segCalls++;
    const m = u.match(/progress=(\d+)/);
    const progress = Number(m && m[1]) || 0;
    const total = 204000;
    const body = {
      data: {
        page: { duration: total, progress: progress + 30000, seg_index: 6 },
        danmaku: new Array(5).fill(0).map((_, i) => ({ p: i })),
      },
    };
    // malformed 场景：故意不给 code 字段，模拟响应结构被 B 站改掉
    return ok(SCENARIO === 'malformed' ? body : Object.assign({ code: 0 }, body));
  }
  throw new Error('unexpected url: ' + u);
};

/* ---------------- 全局环境 ---------------- */
const store = {};
// paused 场景：模拟用户曾经点过「关闭」，enabled 被持久化成 false
if (SCENARIO === 'paused') store['bPsStore.v1'] = JSON.stringify({ config: { enabled: false } });
const menu = [];
const windowStub = {
  addEventListener() {},
  dispatchEvent() {},
  // NO_WINDOW_STATE 场景：window 全局上没有初始状态
  __INITIAL_STATE__: NO_WINDOW_STATE[SCENARIO] ? undefined : buildInitialState(),
};

// latehydrate：模拟 B 站在 document-idle 之后才异步水合首屏数据。
// boot 时取不到，重试才取得到——这是线上真实踩到的时序。
// 1300ms 卡在前两轮退避（t=0 / 300 / 1100）之后、首轮断言（t=1600）之前。
if (SCENARIO === 'latehydrate') {
  setTimeout(function () { windowStub.__INITIAL_STATE__ = buildInitialState(); }, 1300);
}

const bootError = [];
try {
  // 脚本里 sleep() 用 setTimeout、fetchJSON 也用它设 9s 超时；用真实定时器，
  // 但把 setInterval 打废，避免 1s 轮询让进程不退出。
  const fn = new Function(
    'window', 'document', 'location', 'history', 'fetch', 'localStorage',
    'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand',
    'MutationObserver', 'PopStateEvent', 'AbortController', 'console',
    'setTimeout', 'setInterval', 'clearTimeout', 'performance',
    src + '\n;return true;'
  );
  const r = fn(
    windowStub, documentStub, locationStub,
    { pushState() {} },
    fetchImpl,
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    // 脚本自己负责 JSON 编解码，这里必须原样存取字符串，
    // 否则 loadStore 里的 JSON.parse 会二次解析失败，导致 enabled 等配置全部读不到
    (k, d) => (k in store ? store[k] : d),
    (k, v) => { store[k] = String(v); },
    (label, cb) => { menu.push([label, cb]); },
    class { observe() {} disconnect() {} },
    class { constructor(t) { this.type = t; } },
    AbortController,
    console,
    setTimeout,
    () => 0,
    clearTimeout,
    performanceStub,
  );
  if (r !== true) bootError.push('script did not signal completion');
} catch (e) {
  bootError.push('BOOT THREW: ' + e.stack.split('\n').slice(0, 5).join('\n    '));
}

/* ---------------- 断言 ---------------- */
const checks = [];
const assert = (name, cond) => checks.push([name, !!cond]);
const clsOf = (el) => (el && el.classList && el.classList._s) ? Array.from(el.classList._s) : [];
const hasCls = (el, c) => clsOf(el).indexOf(c) >= 0;

/** 模拟点击栏或面板上的某个 data-act 控件 */
function clickAct(act, inPanel) {
  const el = {
    getAttribute: () => act,
    closest(sel) {
      if (sel === '#b-ps-bar') return inPanel ? null : {};
      if (sel === '#b-ps-panel') return inPanel ? {} : null;
      return null;
    },
  };
  const e = {
    target: {
      closest(sel) {
        if (sel === '[data-act]') return el;
        if (sel === '#b-ps-bar') return inPanel ? null : {};
        if (sel === '#b-ps-panel') return inPanel ? {} : null;
        return null;
      },
    },
  };
  (handlers.click || []).forEach((fn) => fn(e));
}

function finish(dmCell) {
  console.log('\n=== userscript 冒烟测试 · 场景: ' + SCENARIO + ' ===');
  if (dmCell !== undefined) {
    console.log('弹幕单元格内容: ' + dmCell.replace(/<[^>]+>/g, '[').replace(/\]/g, ']'));
  }
  let pass = 0;
  for (const [name, okFlag] of checks) {
    console.log((okFlag ? '  PASS  ' : '  FAIL  ') + name);
    if (okFlag) pass++;
  }
  console.log('\nseg.so 调用 ' + segCalls + ' 次 | view/type 调用 ' + viewerCalls + ' 次');
  if (bootError.length) {
    console.log('\n启动异常:');
    bootError.forEach((e) => console.log('  ! ' + e));
  }
  console.log('\n' + pass + '/' + checks.length + ' 通过');
  process.exit(pass === checks.length && !bootError.length ? 0 : 1);
}

setTimeout(() => {
  const bar = registry.get('b-ps-bar');
  const panel = registry.get('b-ps-panel');
  // latehydrate 单独走：模拟 B 站在 document-idle 之后才异步水合首屏数据。
  // boot 时取不到（这是线上真实踩到的时序），退避重试后必须自己恢复。
  if (SCENARIO === 'latehydrate') {
    assert('水合前不急着弹错误（给异步水合留时间）', !bar);
    // 水合发生在 t=1300，首轮断言在 t=1600：此刻前几轮重试的 fetch 都已经跑完。
    // 每轮因 CORS 自适应会发 include+omit 两个请求，所以 3 次尝试最多 6 次请求。
    // 关键不变量不是「零请求」，而是「水合之后再不发」——水合前打不过网络是正常的。
    assert('水合前的网络请求量在重试窗口之内（<=6 次）', viewCalls <= 6);
    const viewBeforeHydrate = viewCalls;
    setTimeout(() => {
      const b2 = registry.get('b-ps-bar');
      assert('异步水合后重试自动恢复，不用用户干预', !!b2);
      assert('恢复后走正常挂载而非浮动兜底', !!b2 && !hasCls(b2, 'is-float'));
      assert('恢复后没有弹过错误通知', !!b2 && !hasCls(b2, 'is-notice'));
      assert('水合成功后没有再发任何 view 请求（水合前发过 ' + viewBeforeHydrate + ' 次，之后不再增加）', viewCalls === viewBeforeHydrate);
      // v0.3 起栏本身是空的（只是图标），恢复的标志是「正常栏挂回标题旁」而不是浮动
      assert('恢复后栏挂回标题旁（不再是浮动通知）', !!b2 && !hasCls(b2, 'is-float') && !hasCls(b2, 'is-notice'));
      assert('恢复后弹幕统计正常运行', segCalls >= 1);
      finish(undefined);
    }, 2200);
    return;
  }

  // error 场景单独走：失败现在有退避宽限期，此刻还没有通知是**期望行为**
  if (SCENARIO === 'error') {
    assert('宽限期内不急着弹错误（给异步水合留时间）', !bar);
    setTimeout(() => {
      const b2 = registry.get('b-ps-bar');
      assert('重试耗尽后仍给出可见通知', !!b2);
      assert('通知样式 is-notice + is-bad', !!b2 && hasCls(b2, 'is-notice') && hasCls(b2, 'is-bad'));
      assert('通知挂在 body 下（浮动兜底生效）', !!b2 && documentStub.body.children.includes(b2));
      assert('通知明确写出「未显示」', !!b2 && b2.innerHTML.includes('未显示'));
      assert('通知写出真实失败原因', !!b2 && b2.innerHTML.includes('Failed to fetch'));
      assert('通知给出「重试」按钮', !!b2 && b2.innerHTML.includes('data-act="refresh"'));
      assert('通知附带现场诊断信息', !!b2 && b2.innerHTML.includes('诊断信息'));
      assert('诊断含 __INITIAL_STATE__ 现场值', !!b2 && b2.innerHTML.includes('__INITIAL_STATE__'));
      assert('诊断含 [data-cid] 元素计数', !!b2 && b2.innerHTML.includes('[data-cid]'));
      assert('诊断含 perf 里抠到的 cid', !!b2 && b2.innerHTML.includes('perf里的cid'));
      assert('通知给出「复制」按钮', !!b2 && b2.innerHTML.includes('data-act="copydiag"'));
      assert('失败路径零弹幕请求', segCalls === 0);
      // 重试链路：接口仍然失败时，通知必须继续可见，不能又变成空白
      clickAct('refresh');
      setTimeout(() => {
        const b3 = registry.get('b-ps-bar');
        assert('点「重试」后仍然可见（不是静默失败）', !!b3 && documentStub.body.children.includes(b3));
        assert('点「重试」后仍是通知样式', !!b3 && hasCls(b3, 'is-notice') && hasCls(b3, 'is-bad'));
        assert('点「重试」后仍给出可点按钮', !!b3 && b3.innerHTML.indexOf('b-ps-btn') >= 0);
        finish(undefined);
      }, 1500);
    }, 2200);
    return;
  }

  const isNotice = SCENARIO === 'paused';

  assert('脚本注册了单例标记（防双跑）', windowStub.__biliPartStatsInstalled === true);
  assert('CSS 已注入 <style id=b-ps-css>', !!registry.get('b-ps-css'));
  assert('栏元素已创建（任何场景都不能没有栏）', !!bar);
  assert('注册了 3 个油猴菜单项', menu.length === 3);
  assert('注册了 1 个 click 委托处理器', (handlers.click || []).length === 1);

  // v0.2.1 的核心不变量：页面自己已经有分P数据时，脚本不该打任何 view 请求。
  // 当初就是这条没守住，才落回网络请求吃下 code=-404。
  // （latehydrate / error 有自己的时序，单独断言）
  if (SCENARIO !== 'error' && SCENARIO !== 'latehydrate') {
    assert('已能从 __INITIAL_STATE__ 直接取到分P数据，零 view 请求（' + SCENARIO + '）', viewCalls === 0);
  }

  if (isNotice) {
    // v0.2 最关键的两条回归：这两条失败路径以前是静默 hideAll()，
    // 用户只会看到空白页，无从判断脚本到底有没有跑起来。
    assert('失败路径渲染出通知样式 is-notice', !!hasCls(bar, 'is-notice'));
    assert('失败路径走浮动兜底定位 is-float', !!hasCls(bar, 'is-float'));
    assert('通知挂在 body 下（兜底挂载生效）', !!bar && documentStub.body.children.includes(bar));
    assert('通知文字说明了当前状态', !!bar && bar.innerHTML.length > 40);
    assert('通知带可点的恢复按钮', !!bar && bar.innerHTML.indexOf('b-ps-btn') >= 0);
    assert('失败路径零弹幕请求', segCalls === 0);
    assert('失败路径零在线人数请求', viewerCalls === 0);

    if (SCENARIO === 'paused') {
      assert('已暂停提示明确写出「已暂停」', !!bar && bar.innerHTML.includes('已暂停'));
      assert('已暂停提示不误标红色错误', !!bar && !hasCls(bar, 'is-bad'));
      assert('已暂停提示给出「重新启用」按钮', !!bar && bar.innerHTML.includes('data-act="enable"'));
      assert('已暂停提示给出「忽略」按钮', !!bar && bar.innerHTML.includes('data-act="quiet"'));

      // 恢复链路：点「重新启用」后必须真的把数据栏画回来
      clickAct('enable');
      setTimeout(() => {
        const b2 = registry.get('b-ps-bar');
        assert('点「重新启用」后通知样式被清掉', !!b2 && !hasCls(b2, 'is-notice'));
        assert('点「重新启用」后恢复了浮动兜底以外的正常挂载', !!b2 && !hasCls(b2, 'is-float'));
        // v0.3 起栏本身不再承载内容，恢复的标志是「正常图标栏回到了标题旁边」
        assert('点「重新启用」后图标栏已挂回标题旁（不再是浮动通知）', !!b2 && !hasCls(b2, 'is-float') && !hasCls(b2, 'is-notice'));
        assert('点「重新启用」后弹幕统计真的跑起来了', segCalls >= 1);
        finish(undefined);
      }, 2200);
      return;
    }

    return;
  }

  const b = bar;
  const p = panel;
  assert('面板元素已创建', !!p);
  assert('栏挂在标题容器之后', !!(titleBox._orphan || []).includes(b));
  assert('面板紧挨在栏之后', !!(b._orphan || []).includes(p));
  // v0.3 起：栏收缩成一个「小图标」——自身不再有任何文本内容，
  // 点它靠 wire() 的 click 委托识别（e.target.closest('#b-ps-bar')）。
  assert('栏本身是空的（图标由 CSS ::before 画出来）', !b.innerHTML || b.innerHTML.length === 0);
  assert('初始未展开面板（懒加载）', !!p && !p.classList.contains('is-open'));

  // 点图标后必须真的把面板展开，用户点开才知道数据在哪
  clickAct('toggle');
  assert('点图标后面板已展开', !!p && p.classList.contains('is-open'));
  if (!SINGLE_PART[SCENARIO]) {
    assert('面板头部显示当前分P标题（转义后）', !!p && p.innerHTML.includes('宣传PV'));
  }
  // 精确取出当前分P的弹幕单元格内容，避免用 includes 做模糊匹配
  const m = String(p.innerHTML).match(/当前弹幕 <b class="b-ps-num">([\s\S]*?)<\/b>/);
  const dmCell = m ? m[1] : '(未渲染)';

  if (SCENARIO === 'malformed') {
    assert('格式异常响应降级为 —（不误报 0）', dmCell.indexOf('b-ps-dash') >= 0);
    assert('格式异常时不显示任何数字', !/\d/.test(dmCell));
    assert('格式异常时不误标下界上标', dmCell.indexOf('⁺') < 0);
  } else {
    assert('弹幕数已算出为 35（7 段 × 5 条）', dmCell === '35');
    assert('弹幕数不是「统计中…」占位', dmCell.indexOf('统计中') < 0);
    assert('跑完全部分段时不标下界上标', dmCell.indexOf('⁺') < 0);
  }
  assert('当前分P请求次数与预期一致（' + EXPECT_SEG + '）', segCalls === EXPECT_SEG);
  // v0.3 起：在线人数从栏挪到面板头部的「当前在线」标签里
  assert('在线人数在端点下线时降级为 —', !!p && p.innerHTML.includes('当前在线') && p.innerHTML.indexOf('<span class="b-ps-dash">—</span>') >= 0);
  if (!SINGLE_PART[SCENARIO]) assert('多分P才显示「统计全部分P」按钮', !!p.innerHTML.includes('统计全部分P'));
  else assert('单分P不显示「统计全部分P」按钮', !p.innerHTML.includes('统计全部分P'));
  assert('在线人数端点被调用过且熔断', viewerCalls >= 1);
  assert('缓存已写入 GM 存储', typeof store['bPsStore.v1'] === 'string');
  assert('油猴菜单含关闭/开启入口', !!menu.find((x) => x[0] === '关闭 / 开启分P数据栏'));

  // 点「统计全部分P」必须同时展开面板——此前只算数据不展开，用户会以为「没反应」
  clickAct('count-all');
  assert('点「统计全部分P」后面板已展开', !!p && p.classList.contains('is-open'));
  assert('面板行数与分P数一致', !!p &&
    (p.innerHTML.match(/b-ps-row/g) || []).length === (SINGLE_PART[SCENARIO] ? 1 : 2));
  assert('面板高亮当前分P', !!p && p.innerHTML.includes('b-ps-cur'));
  assert('面板显示全片总弹幕', !!p && p.innerHTML.includes('8040'));
  if (SCENARIO === 'domonly') {
    // DOM 兜底源必须把时长和标题都解析出来，不能只凑出几个 cid
    assert('DOM 兜底源解析出分P时长 03:24', !!p && p.innerHTML.includes('03:24'));
    assert('DOM 兜底源从统计行取到全片总弹幕 8040', !!p && p.innerHTML.includes('8040'));
  }
  if (SCENARIO === 'perfonly') {
    // 降级来源：只从播放器请求里抠到当前 cid + video 元素的时长，按单分P处理
    assert('降级来源按单分P显示（只有一个 cid）', !/全部分P/.test(b.innerHTML));
    assert('降级来源用播放器自身时长 03:24', !!p && p.innerHTML.includes('03:24'));
    assert('降级来源从统计行取到全片总弹幕 8040', !!p && p.innerHTML.includes('8040'));
  }

  clickAct('toggle', true);
  assert('点面板内的「×」后已收起', !!p && !p.classList.contains('is-open'));

  // 等 countAll 把全部分P都算完
  setTimeout(() => {
    const total = SCENARIO === 'malformed' ? 2 : SINGLE_PART[SCENARIO] ? 7 : 14;
    assert('全部分P都统计完（' + total + ' 次）', segCalls === total);
    finish(dmCell);
  }, 1600);
}, 1600);
