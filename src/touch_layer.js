// touch_layer.js — 触摸输入层（执行位原型 · A · 2026-10-04）
// 路线（已批）：零侵入键码注入。等 window.__input 出现后接管：
//   摇杆→WASD 键码写入 input.keys；右半屏拖动→input.yaw/pitch（灵敏度复用 0.0023）；
//   按钮→键码派发（justPressed 生命周期与 main.js endFrame() 一致）。
// PointerLock 跳过（源码三处可选链，移动端不炸）。桌面端零激活。
// 边界（汇总员批）：不写后台暂停状态机，RAF 后台节流天然兜底。

const SENS = 0.0023;                       // 与 input.js 同源灵敏度
const PITCH_MIN = -1.25, PITCH_MAX = 1.35; // 与 input.js 同源 clamp

// 总开关（清单 v1.2 B5 红线「一键还原原版」）：URL 加 ?tl0 或 localStorage['tl_off']='1'，
// 即不创建任何 UI/监听，页面回归原版形态；无任何残留需手工清理。
const TL_OFF = new URLSearchParams(location.search).has('tl0')
            || localStorage.getItem('tl_off') === '1';

function isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

// 摇杆向量 → 八向 WASD 键码组合
function vecToKeys(x, z) {                 // z>0 前进（W），x>0 右移（D）
  const keys = [];
  if (z >  0.38) keys.push('KeyW'); else if (z < -0.38) keys.push('KeyS');
  if (x >  0.38) keys.push('KeyD'); else if (x < -0.38) keys.push('KeyA');
  return keys;
}

export function mountTouchLayer(getInput) {
  if (!isTouchDevice()) return null;       // 桌面端零激活承诺

  // ---- UI 构建（全部动态创建，不动 index.html 骨架；壳层注入点已批）----
  const css = document.createElement('style');
  css.textContent = `
    #tl-root{position:fixed;inset:0;z-index:9999;pointer-events:none;
      touch-action:none;-webkit-user-select:none;user-select:none;
      padding-bottom:env(safe-area-inset-bottom);padding-right:env(safe-area-inset-right)}
    #tl-root *{touch-action:none;-webkit-tap-highlight-color:transparent}
    /* [a7t] 按键零文字：只放一枚内联 SVG 小标识，尺寸跟着按钮走。
       font-size:0 + 无 text 节点 → 任何残留字符都不会在键面上显示。 */
    .tl-btn{position:absolute;pointer-events:auto;width:54px;height:54px;border-radius:50%;
      background:rgba(20,26,38,.55);border:1px solid rgba(120,220,255,.5);color:#9be8ff;
      display:flex;align-items:center;justify-content:center;
      font-size:0;line-height:0;text-align:center;opacity:.85;
      -webkit-tap-highlight-color:transparent}
    .tl-btn svg{width:58%;height:58%;display:block;overflow:visible;
      fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;
      stroke-linejoin:round;pointer-events:none}
    .tl-btn svg .fill{fill:currentColor;stroke:none}
    .tl-btn.on{background:rgba(60,180,255,.55);color:#eafaff}
    .tl-stick{position:absolute;pointer-events:auto;width:104px;height:104px;border-radius:50%;
      background:rgba(20,26,38,.4);border:1px solid rgba(120,220,255,.4)}
    .tl-knob{position:absolute;left:30px;top:30px;width:44px;height:44px;border-radius:50%;
      background:rgba(120,220,255,.55)}
  `;
  document.head.appendChild(css);
  const root = document.createElement('div');
  root.id = 'tl-root';
  document.body.appendChild(root);

  // ---- 左摇杆（按下处现身，动态原点）----
  const stick = document.createElement('div'); stick.className = 'tl-stick'; stick.style.display = 'none';
  const knob = document.createElement('div'); knob.className = 'tl-knob'; stick.appendChild(knob);
  root.appendChild(stick);
  let stickId = null, stickOrigin = null, activeKeys = new Set();

  const applyStickKeys = (dx, dy) => {
    // 横屏旋转态：屏幕坐标 → 应用坐标（应用 x 轴指向屏幕下方，y 轴指向屏幕左方）
    if (window.__mcRotated) { const t = dx; dx = dy; dy = -t; }
    const want = vecToKeys(dx / 45, -dy / 45);       // 45px 死区→全量
    for (const k of activeKeys) if (!want.includes(k)) getInput().keys.delete(k);
    for (const k of want) if (!activeKeys.has(k)) getInput().keys.add(k);
    activeKeys = new Set(want);
    const len = Math.min(1, Math.hypot(dx, dy) / 45);
    const ang = Math.atan2(dy, dx);
    knob.style.left = 30 + Math.cos(ang) * 30 * len + 'px';
    knob.style.top  = 30 + Math.sin(ang) * 30 * len + 'px';
  };

  // ---- 右半屏视角拖动 ----
  let lookId = null, lookLast = null;

  // 【必修1 · 16:23 批令】#tl-root 是 pointer-events:none，空白区触摸目标=canvas（root 兄弟节点），
  // 事件不冒泡经过 root——原 root 监听收不到任何事件，上线即死。改绑 window：
  // 按钮 touchstart 已 stopPropagation 不会双触发；此处再对按钮内 target 直接 return 兜底
  // （按钮 touchend 只有 preventDefault 无 stopPropagation，必须靠兜底拦住）。
  const fromBtn = (e) => e.target?.closest?.('.tl-btn');

  window.addEventListener('touchstart', (e) => {
    if (fromBtn(e)) return;
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45 && stickId === null && t.clientY > innerHeight * 0.35) {
        stickId = t.identifier; stickOrigin = { x: t.clientX, y: t.clientY };
        stick.style.display = 'block';
        stick.style.left = (t.clientX - 52) + 'px'; stick.style.top = (t.clientY - 52) + 'px';
      } else if (lookId === null) {
        lookId = t.identifier; lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (fromBtn(e)) return;
    e.preventDefault();                               // 禁页面滚动/下拉刷新
    const inp = getInput(); if (!inp) return;
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) applyStickKeys(t.clientX - stickOrigin.x, t.clientY - stickOrigin.y);
      else if (t.identifier === lookId) {
        let ddx = t.clientX - lookLast.x, ddy = t.clientY - lookLast.y;
        if (window.__mcRotated) { const t2 = ddx; ddx = ddy; ddy = -t2; }
        inp.yaw   -= ddx * SENS;
        inp.pitch -= ddy * SENS;
        inp.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, inp.pitch));
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: false });

  const endTouch = (e) => {
    if (fromBtn(e)) return;
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        stickId = null; stick.style.display = 'none';
        for (const k of activeKeys) getInput().keys.delete(k);
        activeKeys.clear();
      }
      if (t.identifier === lookId) lookId = null;
    }
  };
  window.addEventListener('touchend', endTouch);
  window.addEventListener('touchcancel', endTouch);

  // ---- 动作按钮（键码派发，justPressed 走 input 同一条路）----
  // 【必修2 · 16:23 批令】KeyT 昼夜走 synth 原生通道：main.js L1194 是原生 keydown 监听
  //   （不读 input 对象），注入 keys/justPressed 到不了——改派发 KeyboardEvent('keydown')
  //   （不带 repeat，满足 !e.repeat 实锤 L1194）。
  // 【必修3 · 16:23 批令】hold:false 只塞 justPressed 不碰 keys：touchend 也不删——杜绝键残留。
  // 【2026-10-05 剥玩法 · 终检补刀】飞掠(KeyE)/回城(KeyR) 按钮已剥——消费端 controller 分支
  //   已移除，键码注入型按钮不经函数符号、符号清零 grep 罩不住，死按钮不留。
  // 【标注4 · 同步】KeyS 双语义收敛为地面后退（空中俯冲已剥），键码同源不改。
  /* [a7t] 键面零文字，全部换成象形小标识。
     全部为内联 SVG 路径，无 <text>、无字符实体、无 emoji；
     viewBox 24×24，stroke 取 currentColor，按下态自动换色。
       跳   = 跃起小人 + 起跳弧线（「蹦跳」那枚）
       冲刺 = 双右尖箭 + 速度线
       后退 = 回退弧箭
       昼夜 = 太阳半圆 + 月牙
     aria-label 只给读屏用，屏幕上零可见文字。 */
  const ICON = {
    jump:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle class="fill" cx="12" cy="4.6" r="2.1"/>' +
        '<path d="M12 7.2v5.1M12 8.6l-3.6-2.1M12 8.6l3.6-2.1M12 12.3l-3.1 4.3M12 12.3l3.1 4.3"/>' +
        '<path d="M4.5 20.4c2.2-1.5 4.9-2.2 7.5-2.2s5.3.7 7.5 2.2" opacity=".65"/>' +
      '</svg>',
    sprint:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M3.2 7.5h6.1M3.2 12h8.4M3.2 16.5h5.2" opacity=".55"/>' +
        '<path d="M11.4 5.4 18.6 12l-7.2 6.6M17.2 5.4 24 12l-6.8 6.6" transform="translate(-3.2 0)"/>' +
      '</svg>',
    back:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M9.2 6.4 3.6 12l5.6 5.6"/>' +
        '<path d="M3.9 12h9.4a6.2 6.2 0 1 1 0 12.4" transform="translate(0 -6.2)"/>' +
        '<path d="M14.2 12h6.2" opacity=".55"/>' +
      '</svg>',
    daynight:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="7.4"/>' +
        '<path d="M12 4.6a7.4 7.4 0 0 1 0 14.8 5.6 5.6 0 0 0 0-14.8Z" class="fill" opacity=".9"/>' +
        '<path d="M12 1.6v1.8M12 20.6v1.8M1.6 12h1.8M20.6 12h1.8M4.6 4.6l1.3 1.3M18.1 18.1l1.3 1.3M19.4 4.6l-1.3 1.3M5.9 18.1l-1.3 1.3" opacity=".6"/>' +
      '</svg>',
  };

  /* [a7t] 布局回到常规手游拇指区：右下角主动作键最大最顺手，
     其余按使用频次向左上排开，横屏整体收一档；每枚键自带尺寸，
     键面零文字。安全区用 calc 叠在 right/bottom 上，刘海屏零遮挡。
     [2026-11-17a6] 历史：曾把 4 键排成一列，横屏会顶到屏幕上沿 → 已废弃。 */
  const LAYOUT = {
    portrait: [
      { icon: ICON.jump,     aria: '跳跃', key: 'Space',     r: 24, b: 28,  size: 64, hold: true  },
      { icon: ICON.sprint,   aria: '冲刺', key: 'ShiftLeft', r: 100, b: 104, size: 52, hold: true  },
      { icon: ICON.back,     aria: '后退', key: 'KeyS',      r: 24, b: 112, size: 48, hold: true  },
      { icon: ICON.daynight, aria: '昼夜', key: 'KeyT',      r: 96, b: 176, size: 44, hold: false, synth: true },
    ],
    landscape: [
      { icon: ICON.jump,     aria: '跳跃', key: 'Space',     r: 16, b: 16, size: 56, hold: true  },
      { icon: ICON.sprint,   aria: '冲刺', key: 'ShiftLeft', r: 82, b: 22, size: 46, hold: true  },
      { icon: ICON.back,     aria: '后退', key: 'KeyS',      r: 16, b: 84, size: 42, hold: true  },
      { icon: ICON.daynight, aria: '昼夜', key: 'KeyT',      r: 80, b: 88, size: 40, hold: false, synth: true },
    ],
  };
  const btnEls = [];
  for (const d of LAYOUT.portrait) {
    const b = document.createElement('div');
    b.className = 'tl-btn';
    b.innerHTML = d.icon;                       // 纯 SVG，零文字节点
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', d.aria);      // 仅读屏用，键面无字
    b.dataset.key = d.key;                     // 验收/调试按真实键码定位
    b.style.right = d.r + 'px'; b.style.bottom = d.b + 'px';
    btnEls.push({ el: b, def: d });
    const press = (on) => {
      if (d.synth) {  // 原生 keydown 通道（昼夜循环），无需 keyup：main.js 只读 keydown 单次
        if (on) window.dispatchEvent(new KeyboardEvent('keydown', { code: d.key }));
        return;
      }
      const inp = getInput(); if (!inp) return;
      if (d.hold) {
        if (on) { inp.keys.add(d.key); inp.justPressed.add(d.key); b.classList.add('on'); }
        else    { inp.keys.delete(d.key); b.classList.remove('on'); }
      } else if (on) {
        inp.justPressed.add(d.key); b.classList.add('on');    // 单帧键：不碰 keys，无残留
      } else {
        b.classList.remove('on');
      }
    };
    b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); press(true); }, { passive: false });
    b.addEventListener('touchend',   (e) => { e.preventDefault(); press(false); }, { passive: false });
    root.appendChild(b);
  }

  /* 横竖屏布局切换：旋转态 __mcRotated 时视口是竖的但画面是横的，两种都要判。 */
  function applyBtnLayout() {
    const land = !!window.__mcRotated || innerWidth > innerHeight * 1.15;
    const defs = land ? LAYOUT.landscape : LAYOUT.portrait;
    btnEls.forEach(({ el }, i) => {
      const nd = defs[i];
      // safe-area 叠在坐标上：刘海/手势条屏零遮挡
      el.style.right  = `calc(${nd.r}px + env(safe-area-inset-right, 0px))`;
      el.style.bottom = `calc(${nd.b}px + env(safe-area-inset-bottom, 0px))`;
      el.style.width  = nd.size + 'px';
      el.style.height = nd.size + 'px';
      el.style.fontSize = '0';                 // 双保险：键面永不出现字符
      el.setAttribute('aria-label', nd.aria);
    });
  }
  applyBtnLayout();
  addEventListener('resize', applyBtnLayout);
  addEventListener('orientationchange', () => setTimeout(applyBtnLayout, 300));

  // 【顺手5 · 16:23 批令】activeKeys 在 applyStickKeys 内被整体重建（new Set），
  // 直接返回引用会失真——改 getter，每次取实时值。
  // [2026-11-20 审查修复 F-46] 之前 __touchLayer 从未赋值，触屏开关/按钮大小/
  // 透明度设置全无消费端。这里暴露控制 API 供 game-shell applySettings 调用。
  window.__touchLayer = {
    setEnabled(on) { root.style.display = on ? '' : 'none'; },
    // 兼容 game-shell 的双参调用 setScale(size, opacity)
    setScale(s, o) {
      const k = Math.max(0.5, Math.min(2, +s || 1));
      root.querySelectorAll('.tl-btn').forEach(b => { b.style.transform = `scale(${k})`; b.style.transformOrigin = 'center'; });
      root.querySelectorAll('.tl-stick').forEach(b => { b.style.transform = `scale(${k})`; b.style.transformOrigin = 'center'; });
      if (o !== undefined) this.setOpacity(o);
    },
    setOpacity(o) { root.style.opacity = Math.max(0.1, Math.min(1, +o || 0.75)); },
  };
  return { root, get activeKeysRef() { return activeKeys; } };
}

// 等待 __input 注入 + 进入游戏（phase==='play'）才挂载。
// 关键：菜单阶段绝不能出现摇杆/按钮 —— 它们会盖住 ENTER GAME 按钮，
// 玩家一碰就变成「拖摇杆」，导致点不进去。
export function autoMount(maxWaitMs = 120000) {
  if (TL_OFF) return;                      // 总开关：关闭时不建任何 DOM/监听
  const t0 = Date.now();
  const inGame = () => {
    const ph = window.__phase;
    if (ph) return ph === 'play';
    // 没有 phase 探针时，退回「菜单已隐藏」的判断
    const menu = document.getElementById('menu');
    return !!menu && menu.classList.contains('gone');
  };
  let mounted = false;
  const tryMount = () => {
    if (mounted || !window.__input || !inGame()) return false;
    mounted = true;
    mountTouchLayer(() => window.__input);
    return true;
  };
  const timer = setInterval(() => {
    if (tryMount()) { clearInterval(timer); return; }
    if (Date.now() - t0 > maxWaitMs) clearInterval(timer);
  }, 100);
  // 事件驱动：进入游戏那一刻立刻挂载（卡顿时轮询可能迟迟不跑）
  addEventListener('mc:phase', () => { if (tryMount()) clearInterval(timer); });
}

// 自启动（index.html 仅 src 引用即生效；总开关关闭时上面已 return）
autoMount();
