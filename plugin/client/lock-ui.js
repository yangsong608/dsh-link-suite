/**
 * dsh-link — 浏览器半侧：界面锁（L1）
 *
 * 只做界面：全屏层 + 焦点陷阱 + 键盘/右键拦截 + 密码框交互。
 * **密码比较全部在宿主**（POST /dsh-link/lock/unlock），浏览器里不出现 salt 与 hash。
 *
 * 与 dsh-startup-moss 的门口令的区别：那个是"页面加载时问一次"，这个是"持续状态"——
 * 空闲会自动进入，锁定时还会把背后的应用 `display:none`（不只是盖一层）。
 *
 * 诚实边界：这是界面锁，挡的是人，不是进程。已登录浏览器的 API 调用拦不住，
 * 因为 dsh 没给 owner 调用链留钩子（见 docs/06 §3）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-link',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // dsh 的浏览器半跑在 React 里。设置面板必须用 React 渲染才能插进 slots
    // 的渲染树；锁层是直接操作 DOM 的（它要覆盖整个页面，不需要参与 React）。
    var React = require('react')

    var BASE = '/dsh-link'
    var ROOT_ID = 'dsh-link-lock'
    var POLL_MS = 1000
    var MAX_DOTS = 8

    var state = {
      armed: false,
      hasPassword: false,
      /** ready | disabled | no-password —— 决定要不要显示"未武装"提示条 */
      armedReason: 'no-password',
      locked: false,
      soft: false,
      since: 0,
      reason: '',
      attemptsLeft: null,
      fails: 0,
      busy: false,
      poll: null,
      watchdog: null,
      lastActivity: Date.now()
    }

    // ── 样式（内联：客户端半只有一个文件请求，少一次就能少一次失败）──────────
    var CSS = [
      'html.dsh-link-locked, html.dsh-link-locked body{overflow:hidden!important;overscroll-behavior:none}',
      '#dsh-link-lock{position:fixed;inset:0;z-index:2147483002;display:grid;place-items:center;',
      'background:radial-gradient(ellipse 90% 70% at 50% 38%,#160a07 0%,#0a0504 46%,#020202 100%);',
      'color:#f2eae4;font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;',
      'opacity:0;transition:opacity .42s ease;overflow:hidden}',
      '#dsh-link-lock.on{opacity:1}',
      '#dsh-link-lock *{box-sizing:border-box}',
      '#dsh-link-lock .veil{position:absolute;inset:0;pointer-events:none;',
      'background:repeating-linear-gradient(0deg,rgba(255,255,255,.016) 0 1px,rgba(0,0,0,0) 1px 4px),',
      'radial-gradient(circle at 50% 45%,rgba(0,0,0,0) 36%,rgba(0,0,0,.8) 100%);mix-blend-mode:screen;opacity:.38}',
      '#dsh-link-lock .card{position:relative;width:min(520px,92vw);border:1px solid rgba(255,59,47,.42);',
      'border-radius:10px;background:linear-gradient(180deg,rgba(26,9,7,.97),rgba(9,4,4,.99));padding:0 26px 22px;',
      'box-shadow:0 0 0 1px rgba(255,59,47,.1),0 30px 90px rgba(0,0,0,.82),0 0 70px rgba(255,59,47,.14),',
      'inset 0 0 70px rgba(255,59,47,.05)}',
      '#dsh-link-lock .card.shake{animation:dshk-shake .38s cubic-bezier(.36,.07,.19,.97)}',
      '@keyframes dshk-shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-9px)}',
      '32%{transform:translateX(8px)}50%{transform:translateX(-5px)}68%{transform:translateX(4px)}84%{transform:translateX(-2px)}}',
      '#dsh-link-lock .bar{display:flex;align-items:center;gap:8px;height:34px;margin:0 -26px 22px;padding:0 14px;',
      'border-bottom:1px solid rgba(255,59,47,.22);background:linear-gradient(180deg,rgba(58,18,14,.55),rgba(24,8,6,.2));',
      'font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,190,180,.82)}',
      '#dsh-link-lock .dot{width:9px;height:9px;border-radius:50%;background:#ff3b2f;',
      'box-shadow:0 0 10px rgba(255,59,47,.9);flex:none}',
      '#dsh-link-lock .bar b{font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#dsh-link-lock .bar .tag{color:rgba(255,190,180,.55);font-weight:400}',
      '#dsh-link-lock .emblem{width:48px;height:48px;margin:6px auto 14px;border-radius:50%;',
      'border:1px solid rgba(255,59,47,.5);display:grid;place-items:center;color:#ff6a5e;font-size:18px;',
      'animation:dshk-breathe 2.4s ease-in-out infinite}',
      '@keyframes dshk-breathe{0%,100%{box-shadow:0 0 0 0 rgba(255,59,47,.28)}50%{box-shadow:0 0 24px 6px rgba(255,59,47,.18)}}',
      '#dsh-link-lock .sub{text-align:center;font-size:13px;letter-spacing:.18em;color:rgba(255,190,180,.5);margin-bottom:18px}',
      '#dsh-link-lock .field{display:flex;align-items:center;gap:10px;height:48px;padding:0 14px;border-radius:8px;',
      'border:1px solid rgba(255,59,47,.3);background:rgba(10,5,4,.9);cursor:text}',
      '#dsh-link-lock .field.focus{border-color:rgba(255,59,47,.72);box-shadow:0 0 0 1px rgba(255,59,47,.2)}',
      '#dsh-link-lock .dots{display:flex;gap:10px;flex:1}',
      '#dsh-link-lock .dots i{width:9px;height:9px;border-radius:50%;background:rgba(255,190,180,.22);transition:.16s}',
      '#dsh-link-lock .dots i.on{background:#ff3b2f;box-shadow:0 0 8px rgba(255,59,47,.8);transform:scale(1.18)}',
      '#dsh-link-lock input{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}',
      '#dsh-link-lock .row{display:flex;gap:10px;margin-top:16px}',
      '#dsh-link-lock button{height:48px;flex:1;border-radius:8px;font:inherit;font-size:14px;cursor:pointer;',
      'border:1px solid rgba(255,59,47,.34);background:rgba(30,12,10,.9);color:#f2eae4;transition:.16s}',
      '#dsh-link-lock button.primary{background:#ff3b2f;border-color:transparent;color:#fff;font-weight:600;',
      'box-shadow:0 6px 20px rgba(255,59,47,.28)}',
      '#dsh-link-lock button:active{transform:scale(.985)}',
      '#dsh-link-lock button:disabled{opacity:.5;cursor:default}',
      '#dsh-link-lock .foot{display:flex;justify-content:space-between;margin-top:16px;font-size:11px;',
      'color:rgba(255,190,180,.42);letter-spacing:.08em}',
      '#dsh-link-lock .msg{min-height:16px;margin-top:10px;font-size:12px;color:#ff8a7e;letter-spacing:.04em}',
      'html.dsh-link-locked #root{display:none!important}'
    ].join('')

    var $ = function (sel, root) { return (root || document).querySelector(sel) }

    function ensureStyle() {
      if (document.getElementById(ROOT_ID + '-css')) return
      var s = document.createElement('style')
      s.id = ROOT_ID + '-css'
      s.textContent = CSS
      document.head.appendChild(s)
    }

    // ── 与宿主通信 ──────────────────────────────────────────────────────────
    function api(path, body) {
      var opt = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      return fetch(BASE + path, Object.assign({ credentials: 'same-origin' }, opt))
        .then(function (res) { return res.json().then(function (j) { return { status: res.status, body: j } }) })
    }

    function poll() {
      api('/lock').then(function (out) {
        if (out.status !== 200) return
        var was = state.locked
        state.armed = out.body.armed === true
        state.hasPassword = out.body.hasPassword === true
        state.armedReason = out.body.armedReason || (state.armed ? 'ready' : 'no-password')
        state.locked = out.body.locked === true
        state.soft = out.body.soft === true
        state.since = out.body.since || 0
        state.reason = out.body.reason || ''
        state.attemptsLeft = out.body.attemptsLeft
        if (state.locked && !was) render()
        if (!state.locked && was) unmount()
        syncSetupHint()
      }).catch(function () { /* 宿主没起来时静默，下一次再试 */ })
    }

    // ── 未武装提示 ──────────────────────────────────────────────────────────
    // 以前这一格是空的：没设密码时锁屏既不生效、界面也不说为什么，
    // 用户只会以为"这个功能坏了"。现在把原因和下一步直接放在页面上。
    var HINT_ID = ROOT_ID + '-setup-hint'

    function syncSetupHint() {
      var existing = document.getElementById(HINT_ID)
      var needHint = !state.armed && state.armedReason === 'no-password'
      if (!needHint) {
        if (existing) existing.remove()
        return
      }
      if (existing) return

      var bar = document.createElement('div')
      bar.id = HINT_ID
      bar.setAttribute('role', 'status')
      bar.style.cssText = [
        'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483001',
        'max-width:min(560px,92vw);padding:12px 16px;border-radius:10px',
        'border:1px solid rgba(232,194,74,.42);background:rgba(28,22,8,.96)',
        'color:#f0e2b8;font:13px/1.5 ui-monospace,"SF Mono",Menlo,monospace',
        'box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center'
      ].join(';')
      bar.innerHTML = [
        '<span style="flex:none;color:#e8c24a">!</span>',
        '<span style="flex:1">锁屏未生效：还没有设置密码。</span>',
        '<button type="button" data-act="pw" style="flex:none;height:30px;padding:0 12px;border-radius:6px;cursor:pointer;',
        'border:1px solid rgba(232,194,74,.5);background:rgba(60,46,12,.9);color:#f0e2b8;',
        'font:inherit">设置密码</button>',
        '<button type="button" data-act="setup" style="flex:none;height:30px;padding:0 12px;border-radius:6px;',
        'cursor:pointer;border:1px solid rgba(232,194,74,.3);background:transparent;color:#f0e2b8;',
        'font:inherit">全部设置</button>'
      ].join('')
      bar.querySelector('[data-act="pw"]').addEventListener('click', function () {
        openPasswordSetup(bar)
      })
      // 配对与设备管理只在设置页里有——不从提示条给出入口，用户根本找不到
      bar.querySelector('[data-act="setup"]').addEventListener('click', function () {
        window.open(BASE + '/setup', '_blank', 'noopener')
      })
      document.body.appendChild(bar)
    }

    // ── 常驻设置入口 ────────────────────────────────────────────────────────
    // 只在"未武装"时提示是不够的：用户设好密码之后仍然需要配对设备、撤销设备。
    // 一个 28px 的小胶囊，右下角，不抢焦点、不挡内容。
    var PILL_ID = ROOT_ID + '-pill'

    function syncSetupPill() {
      if (document.getElementById(PILL_ID)) return
      var pill = document.createElement('button')
      pill.id = PILL_ID
      pill.type = 'button'
      pill.title = 'MOSS Link 设置（配对设备、锁屏密码）'
      pill.textContent = 'LINK'
      pill.style.cssText = [
        'position:fixed;right:14px;bottom:14px;z-index:2147483000',
        'height:26px;padding:0 10px;border-radius:13px;cursor:pointer',
        'border:1px solid rgba(70,227,166,.32);background:rgba(11,18,16,.86)',
        'color:rgba(230,243,236,.62);font:10px/1 ui-monospace,"SF Mono",Menlo,monospace',
        'letter-spacing:1.4px;opacity:.55;transition:opacity .18s,color .18s',
        'backdrop-filter:blur(6px)'
      ].join(';')
      pill.addEventListener('mouseenter', function () { pill.style.opacity = '1'; pill.style.color = '#46e3a6' })
      pill.addEventListener('mouseleave', function () { pill.style.opacity = '.55'; pill.style.color = 'rgba(230,243,236,.62)' })
      pill.addEventListener('click', function () {
        window.open(BASE + '/setup', '_blank', 'noopener')
      })
      document.body.appendChild(pill)
    }

    /** 首次设置密码的极简对话框：只问一个字段，按回车提交。 */
    function openPasswordSetup(anchor) {
      if (document.getElementById(ROOT_ID + '-pw')) return
      var wrap = document.createElement('div')
      wrap.id = ROOT_ID + '-pw'
      wrap.style.cssText = [
        'position:fixed;inset:0;z-index:2147483003;display:grid;place-items:center',
        'background:rgba(0,0,0,.62)'
      ].join(';')
      wrap.innerHTML = [
        '<div style="width:min(420px,92vw);border-radius:10px;padding:18px;',
        'border:1px solid rgba(232,194,74,.4);background:#141009;color:#f2eae4;',
        'font:13px/1.6 ui-monospace,\'SF Mono\',Menlo,monospace">',
        '<div style="font-size:12px;letter-spacing:.14em;color:rgba(240,226,184,.7);margin-bottom:10px">',
        'MOSS-LINK / 设置锁屏密码</div>',
        '<input type="password" autocomplete="new-password" placeholder="至少 8 位"',
        ' style="width:100%;height:40px;padding:0 12px;border-radius:6px;box-sizing:border-box;',
        'border:1px solid rgba(232,194,74,.35);background:#0b0805;color:#f2eae4;font:inherit;outline:none">',
        '<div class="err" style="min-height:18px;margin-top:8px;color:#ff8a7e;font-size:12px"></div>',
        '<div style="display:flex;gap:8px;margin-top:6px">',
        '<button type="button" class="ok" style="flex:1;height:38px;border-radius:6px;cursor:pointer;',
        'border:0;background:#e8c24a;color:#201800;font:inherit;font-weight:600">设置</button>',
        '<button type="button" class="no" style="flex:1;height:38px;border-radius:6px;cursor:pointer;',
        'border:1px solid rgba(232,194,74,.35);background:transparent;color:#f2eae4;font:inherit">取消</button>',
        '</div></div>'
      ].join('')

      document.body.appendChild(wrap)
      var input = wrap.querySelector('input')
      var errEl = wrap.querySelector('.err')
      var close = function () { wrap.remove() }
      var submit = function () {
        var value = input.value
        if (value.length < 8) {
          errEl.textContent = '密码至少 8 位'
          return
        }
        api('/lock/password', { next: value }).then(function (out) {
          if (out.status === 200) {
            close()
            poll()
            return
          }
          var body = out.body || {}
          errEl.textContent = body.error ? String(body.error) : '设置失败'
        }).catch(function () {
          errEl.textContent = '无法连接主机'
        })
      }
      wrap.querySelector('.ok').addEventListener('click', submit)
      wrap.querySelector('.no').addEventListener('click', close)
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit() }
      })
      wrap.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close()
      })
      setTimeout(function () { input.focus() }, 50)
    }

    // ── 锁层 ────────────────────────────────────────────────────────────────
    function render() {
      if (document.getElementById(ROOT_ID)) return
      ensureStyle()

      var root = document.createElement('div')
      root.id = ROOT_ID
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-modal', 'true')
      root.innerHTML = [
        '<div class="veil"></div>',
        '<div class="card" role="document">',
        '  <div class="bar"><span class="dot"></span><b>MOSS-LINK / HOST</b><span class="tag">LOCKED</span></div>',
        '  <div class="emblem">▲</div>',
        '  <div class="sub">SESSION SUSPENDED</div>',
        '  <div class="field"><div class="dots"></div></div>',
        '  <input type="password" autocomplete="current-password" aria-label="解锁密码">',
        '  <div class="msg"></div>',
        '  <div class="row">',
        '    <button class="primary" type="button">解 锁</button>',
        '    <button type="button" data-act="request">请求远程确认</button>',
        '  </div>',
        '  <div class="foot"><span class="idle"></span><span class="runs">任务仍在后台继续</span></div>',
        '</div>'
      ].join('')

      document.body.appendChild(root)
      document.documentElement.classList.add('dsh-link-locked')
      requestAnimationFrame(function () { root.classList.add('on') })

      var input = $('input', root)
      var field = $('.field', root)
      var card = $('.card', root)
      var msg = $('.msg', root)
      var dots = $('.dots', root)

      // 8 个空位（密码长度不固定，用"已输入几位"驱动，不暴露真实长度）
      for (var i = 0; i < MAX_DOTS; i++) dots.appendChild(document.createElement('i'))

      var syncDots = function () {
        var n = input.value.length
        var kids = dots.children
        for (var k = 0; k < kids.length; k++) kids[k].classList.toggle('on', k < Math.min(n, MAX_DOTS))
      }

      field.addEventListener('click', function () { input.focus() })
      input.addEventListener('input', syncDots)
      input.addEventListener('focus', function () { field.classList.add('focus') })
      input.addEventListener('blur', function () { field.classList.remove('focus') })

      // 焦点陷阱：Tab / Escape 都不许跑到背后的应用里
      root.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') { e.preventDefault(); input.focus() }
        if (e.key === 'Escape') e.preventDefault()
      }, true)

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit() }
      })

      var submit = function () {
        if (state.busy || input.value.length === 0) return
        state.busy = true
        setBusy(true)
        api('/lock/unlock', { password: input.value }).then(function (out) {
          state.busy = false
          if (out.status === 200) {
            state.locked = false
            unmount()
            try { window.dispatchEvent(new CustomEvent('dsh-link:unlocked')) } catch (e) { /* noop */ }
            return
          }
          setBusy(false)
          input.value = ''
          syncDots()
          state.fails++
          card.classList.remove('shake')
          void card.offsetWidth
          card.classList.add('shake')
          var left = out.body && out.body.details && typeof out.body.details.attemptsLeft === 'number'
            ? out.body.details.attemptsLeft : null
          msg.textContent = left === null
            ? (out.body && out.body.error ? String(out.body.error) : '密码错误')
            : '密码错误 · 还可尝试 ' + left + ' 次'
          if (state.fails >= 3 && left !== null) {
            msg.textContent += '　ATTEMPT ' + (MAX_DOTS - left) + ' / ' + MAX_DOTS
          }
          input.focus()
        }).catch(function () {
          state.busy = false
          setBusy(false)
          msg.textContent = '无法连接主机，请确认 dsh 仍在运行'
        })
      }

      var setBusy = function (on) {
        $('.primary', root).disabled = on
        $('.primary', root).textContent = on ? '校验中…' : '解 锁'
      }

      $('.primary', root).addEventListener('click', submit)

      // 远程确认：PC 侧没有第二个人时，这是"人就在这台电脑前"的替代证明。
      // 原来这里只改一行文案、什么都没发——请求根本没到宿主，必然超时。
      var requestBtn = $('[data-act="request"]', root)
      requestBtn.addEventListener('click', function () {
        if (requestBtn.disabled) return
        requestBtn.disabled = true
        requestBtn.textContent = '等待确认…'
        msg.textContent = '已向主机发送解锁请求，请在电脑上确认'
        // 本机浏览器就是"电脑前的那个人"：直接把这个待确认请求批准掉。
        // 远程设备（手机）走的是 RPC 的 lock.request，那条路进 pending 表后
        // 由这个页面轮询 /lock/pending 弹出确认窗。
        api('/lock/touch').catch(function () { /* 忽略：仅是活动标记 */ })
        approveSelf()
      })

      /** 本机 owner 的自助批准：取回 pending 里属于自己的那条并批准。 */
      var approveSelf = function () {
        api('/lock/pending').then(function (out) {
          var pending = (out.body && out.body.pending) || []
          // 本机请求没有 deviceId（owner 直接解锁是不需要审批的），
          // 所以这里只在确实存在待确认项时替它点确认；否则提示改用密码。
          if (pending.length === 0) {
            msg.textContent = '主机没有待确认的请求；请直接输入密码解锁'
            resetRequest()
            return
          }
          var target = pending[0]
          api('/lock/request', { deviceId: target.deviceId, approved: true }).then(function (res) {
            if (res.status === 200 && res.body && res.body.settled) {
              msg.textContent = '已批准 ' + (target.label || target.deviceId) + ' 的解锁请求'
            } else {
              msg.textContent = '确认失败，请重试或直接用密码'
            }
            resetRequest()
            poll()
          })
        }).catch(function () {
          msg.textContent = '无法连接主机，请确认 dsh 仍在运行'
          resetRequest()
        })
      }

      var resetRequest = function () {
        requestBtn.disabled = false
        requestBtn.textContent = '请求远程确认'
      }

      // 空闲时刻显示：给"我锁了多久"一个可感知的量
      var started = state.since || Date.now()
      var tick = function () {
        if (!document.getElementById(ROOT_ID)) return
        var sec = Math.max(0, Math.floor((Date.now() - started) / 1000))
        var mm = String(Math.floor(sec / 60)).padStart(2, '0')
        var ss = String(sec % 60).padStart(2, '0')
        var el = $('.idle', root)
        if (el) el.textContent = 'IDLE ' + mm + ':' + ss
        setTimeout(tick, 1000)
      }
      tick()

      // 看门狗：锁层脚本自己出问题时，宁可漏锁也不能白屏（moss 同款兜底）
      state.watchdog = setTimeout(function () {
        var el = document.getElementById(ROOT_ID)
        if (el && !el.classList.contains('on')) {
          el.remove()
          document.documentElement.classList.remove('dsh-link-locked')
        }
      }, 8000)

      setTimeout(function () { input.focus() }, 80)
      input.focus()
    }

    function unmount() {
      if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null }
      var el = document.getElementById(ROOT_ID)
      if (!el) {
        document.documentElement.classList.remove('dsh-link-locked')
        return
      }
      el.classList.remove('on')
      document.documentElement.classList.remove('dsh-link-locked')
      setTimeout(function () { el.remove() }, 420)
    }

    // 锁定时把"看内容 / 复制 / 右键 / 拖拽"这些顺手动作一并关掉
    var swallow = function (e) {
      if (document.getElementById(ROOT_ID)) { e.preventDefault(); e.stopPropagation() }
    }

    function apply(ctx) {
      // 注册设置页区块：这是"配置入口应该在哪"的正确答案。
      // dsh 的 slots 机制让插件把面板放进设置侧栏，与系统设置同级；
      // 独立 HTTP 页面（/dsh-link/setup）保留为无 JS 环境的兜底。
      // 必须走 ctx.get('slots', false) 软读：cordis 4 的严格代理下
      // 直接读 ctx.slots 会抛 "cannot get property without inject"，
      // 而且即使服务存在也会抛——那会把整条 apply 打断，锁层跟着不挂载。
      try {
        var slots = ctx.get('slots', false)
        if (slots && typeof slots.inject === 'function') {
          slots.inject('settings.section', function () {
            return slots.register({
              name: 'settings.section',
              id: 'dsh-link',
              order: 120,
              label: 'MOSS Link',
              // 五份 props 契约里的 inject 份额是必填的：没有它注册会抛。
              // 面板只需要两个宿主能力，其余从 HTTP 面自取。
              inject: function () { return {} }
            }, function () { return e(LinkSettings, {}) })
          })
        }
      } catch (err) {
        // 设置页不可用（老版本 dsh / slots 缺失）时不能让整条 apply 断掉：
        // 锁层与活动上报都在同一个 apply 里，抛出去等于整套功能消失。
        try { console.warn('[dsh-link] 设置面板未注册：', err && err.message) } catch (_) { /* noop */ }
      }

      // 全局快捷键（⌘K / ⌘P / ⌘⇧L…）在锁定时必须全部吞掉
      window.addEventListener('keydown', function (e) {
        if (!document.getElementById(ROOT_ID)) return
        var k = e.key.toLowerCase()
        if ((e.metaKey || e.ctrlKey) && k !== 'v') { e.preventDefault(); e.stopPropagation() }
      }, true)
      window.addEventListener('contextmenu', swallow, true)
      window.addEventListener('selectstart', swallow, true)
      window.addEventListener('dragstart', swallow, true)

      // ── 活动上报 ──────────────────────────────────────────────────────────
      // 宿主的空闲计时只认"真的有人在用"：网关 RPC 与这里的上报。
      // 少了这一段，在 PC 上正常聊天也会在 10 分钟后被锁在门外。
      // 去抖到 15s 一次：足够让 idleMinutes 有意义，又不会打满回环接口。
      var lastReport = 0
      var ACTIVITY_MIN_MS = 15 * 1000
      var reportActivity = function () {
        if (document.getElementById(ROOT_ID)) return // 锁着的时候不算活动
        var now = Date.now()
        if (now - lastReport < ACTIVITY_MIN_MS) return
        lastReport = now
        api('/lock', { action: 'touch' }).catch(function () { /* 宿主没起来时忽略 */ })
      }
      var onActivity = function () { reportActivity() }
      // 只认"开始做一件事"的事件；pointermove / scroll 不算（鼠标划过不代表在用）
      window.addEventListener('pointerdown', onActivity, true)
      window.addEventListener('keydown', onActivity, true)
      window.addEventListener('wheel', onActivity, true)
      window.addEventListener('touchstart', onActivity, true)
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') onActivity()
      })
      reportActivity()

      syncSetupPill()

      // 有钱能使鬼推磨，但没网络不能解锁：先拉一次，再按 1s 轮询
      poll()
      state.poll = setInterval(poll, POLL_MS)

      ctx.effect(function () {
        return function () {
          if (state.poll) clearInterval(state.poll)
          window.removeEventListener('pointerdown', onActivity, true)
          window.removeEventListener('keydown', onActivity, true)
          window.removeEventListener('wheel', onActivity, true)
          window.removeEventListener('touchstart', onActivity, true)
          var pill = document.getElementById(PILL_ID)
          if (pill) pill.remove()
          unmount()
        }
      }, 'dsh-link: lock overlay + activity')
    }


    // ── 设置面板（注册进 dsh 设置页）─────────────────────────────────────────
    // 样式与结构对齐 dsh-startup-moss 的配置面板：不硬编码颜色，全部走
    // --dsw-alias-* 主题变量。这样它跟随 dsh 的明暗与主题，看起来像原生设置项，
    // 而不是"一个被塞进来的网页"。
    var e = React.createElement

    var PANEL_CSS = [
      '.__dl_root{max-width:660px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.__dl_intro{display:flex;align-items:center;gap:10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.__dl_badge{font-family:ui-monospace,Menlo,monospace;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 7px;color:var(--dsw-alias-brand-primary)}',
      '.__dl_group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:13px 15px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.__dl_title{font-size:11px;font-weight:600;letter-spacing:.10em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.__dl_row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.__dl_label{display:flex;flex-direction:column;gap:3px}',
      '.__dl_name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.__dl_hint{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}',
      '.__dl_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font-size:13px;box-sizing:border-box;width:100%;outline:none}',
      '.__dl_input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.__dl_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:12.5px;cursor:pointer}',
      '.__dl_btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.__dl_btn:disabled{opacity:.5;cursor:default}',
      '.__dl_btnPri{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.__dl_btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.__dl_status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:18px}',
      '.__dl_ok{color:var(--dsw-alias-state-success-primary)}',
      '.__dl_err{color:var(--dsw-alias-state-error-primary)}',
      '.__dl_note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);border-left:2px solid var(--dsw-alias-border-l3);padding-left:9px}',
      '.__dl_code{font-family:ui-monospace,Menlo,monospace;font-size:26px;letter-spacing:9px;font-weight:700;color:var(--dsw-alias-brand-primary);text-align:center;padding:12px 0 2px}',
      '.__dl_codeHint{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center}',
      '.__dl_pending{border:1px solid var(--dsw-alias-state-warning-primary, #e8c24a);border-radius:8px;padding:10px 12px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-2)}',
      '.__dl_pendingTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warning-primary, #e8c24a);margin-bottom:8px}',
      '.__dl_pendingRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0}',
      '.__dl_dev{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.__dl_dev:first-of-type{border-top:0}',
      '.__dl_devName{font-size:12.5px;color:var(--dsw-alias-label-primary)}',
      '.__dl_devMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.__dl_btns{display:flex;gap:8px;flex-wrap:wrap}',
      '.__dl_qrWrap{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 0 4px}',
      '.__dl_qr{display:block;border-radius:8px;background:#fff;padding:0}',
      '.__dl_addr{display:flex;align-items:center;gap:8px;margin-top:8px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.__dl_addrLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.__dl_addr code{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.__dl_two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '@media (max-width:620px){.__dl_two{grid-template-columns:1fr}}'
    ].join('')

    var PANEL_STYLE_ID = 'dsh-link/panel.css'
    try {
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + PANEL_STYLE_ID + '"]') === null) {
        var panelStyle = document.createElement('style')
        panelStyle.dataset.plugin = 'dsh-link'
        panelStyle.dataset.pluginCss = PANEL_STYLE_ID
        panelStyle.textContent = PANEL_CSS
        document.head.appendChild(panelStyle)
      }
    } catch (err) {
      // 样式注入失败时面板仍然可用，只是没有外观
    }

    function usePanelApi() {
      return React.useMemo(function () {
        function call(path, body, method) {
          var opt = { method: method || (body === undefined ? 'GET' : 'POST') }
          if (body !== undefined) {
            opt.headers = { 'content-type': 'application/json' }
            opt.body = JSON.stringify(body)
          }
          return fetch(BASE + path, Object.assign({ credentials: 'same-origin' }, opt))
            .then(function (r) {
              return r.json().then(function (j) { return { status: r.status, body: j } })
            })
            .catch(function (err) { return { status: 0, body: { error: String(err) } } })
        }
        return {
          status: function () { return call('/lock') },
          setPassword: function (next, current) { return call('/lock/password', { next: next, current: current }) },
          clearPassword: function (current) { return call('/lock/password', { current: current }, 'DELETE') },
          lockNow: function () { return call('/lock', { action: 'lock' }) },
          getRelay: function () { return call('/config/relay') },
          setRelay: function (relayUrl) { return call('/config/relay', { relayUrl: relayUrl }) },
          startPair: function () { return call('/pair/start', {}) },
          // 手机自己发起的配对会在宿主留下待确认记录，PC 必须能看到并批准，
          // 否则手机端 pair.finish 永远 auth/forbidden —— 表现就是"配对超时"
          pendingPairs: function () { return call('/pair/pending') },
          approvePair: function (code) { return call('/pair/approve', { code }) },
          devices: function () { return call('/pair/devices') },
          revoke: function (deviceId) { return call('/pair/revoke', { deviceId }) },
          renameDevice: function (deviceId, label) { return call('/pair/rename', { deviceId, label }) }
        }
      }, [])
    }

    /**
     * 二维码画布。
     *
     * 为什么用 canvas 而不是一堆 div 画格子：
     *   33×33 是 1089 个节点，40×40 是 1600 个。设置面板在 React 里，
     *   这么多 DOM 节点会让每次状态更新（比如倒计时）都重排一次。
     *   canvas 只有 1 个节点，且二维码本来就该按像素画——
     *   DOM 格子很容易因为亚像素取整出现缝隙，扫不出来。
     *
     * 白底是必须的：深色背景下反色二维码（黑底白块）很多扫描器不认。
     */
    function QrCanvas(props) {
      var ref = React.useRef(null)
      var qr = props && props.qr
      var size = (props && props.size) || 188

      React.useEffect(function () {
        var canvas = ref.current
        if (!canvas || !qr || !Array.isArray(qr.modules)) return
        var n = qr.size
        // 静区（quiet zone）4 个模块是规范要求，少了扫不出来
        var quiet = 4
        var total = n + quiet * 2
        // 按设备像素比放大，避免高分屏上模块边缘发虚
        var dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
        canvas.width = size * dpr
        canvas.height = size * dpr
        canvas.style.width = size + 'px'
        canvas.style.height = size + 'px'
        var ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, size, size)
        ctx.fillStyle = '#000000'
        var cell = size / total
        for (var y = 0; y < n; y++) {
          for (var x = 0; x < n; x++) {
            if (!qr.modules[y][x]) continue
            // 用 Math.round 对齐边界：浮点坐标会让相邻模块之间出现 1px 白缝
            var px = Math.round((x + quiet) * cell)
            var py = Math.round((y + quiet) * cell)
            var pw = Math.round((x + quiet + 1) * cell) - px
            var ph = Math.round((y + quiet + 1) * cell) - py
            ctx.fillRect(px, py, pw, ph)
          }
        }
      }, [qr, size])

      return e('div', { className: '__dl_qrWrap' },
        e('canvas', { ref: ref, className: '__dl_qr' }),
        e('div', { className: '__dl_codeHint' }, '手机 App → 添加电脑 → 扫码配对'))
    }

    function LinkSettings() {
      var api = usePanelApi()
      var st = React.useState({ armed: false, hasPassword: false, locked: false, connections: 0 })
      var status = st[0], setStatus = st[1]
      var pw = React.useState({ next: '', current: '', msg: '', kind: '' })
      var pwState = pw[0], setPw = pw[1]
      // qr / wsUrl / candidates 显式初始化：虽然渲染时都有判空，
      // 但 state 形状完整能让"新增字段忘了初始化"这类问题一眼可见。
      var pair = React.useState({ code: '', left: 0, msg: '', kind: '', qr: null, wsUrl: '', candidates: [] })
      var pairState = pair[0], setPair = pair[1]
      var dev = React.useState({ list: [], msg: '', kind: '' })
      var devState = dev[0], setDev = dev[1]
      // 公网接入（nps / frp）：地址与当前生效状态
      var relay = React.useState({ url: '', current: '', endpoints: [], msg: '', kind: '' })
      var relayState = relay[0], setRelay = relay[1]
      // 手机发起的待确认配对请求
      var pend = React.useState([])
      var pending = pend[0], setPending = pend[1]

      var loadStatus = React.useCallback(function () {
        api.status().then(function (out) {
          if (out.status === 200) setStatus(out.body)
        })
      }, [api])

      var loadDevices = React.useCallback(function () {
        api.devices().then(function (out) {
          if (out.status === 200) setDev(function (d) { return Object.assign({}, d, { list: out.body.devices || [] }) })
        })
      }, [api])

      var loadRelay = React.useCallback(function () {
        api.getRelay().then(function (out) {
          if (out.status !== 200) return
          setRelay(function (r) {
            return Object.assign({}, r, {
              current: out.body.relayUrl || '',
              endpoints: out.body.endpoints || [],
            })
          })
        })
      }, [api])

      var loadPending = React.useCallback(function () {
        api.pendingPairs().then(function (out) {
          if (out.status === 200) setPending(out.body.pending || [])
        })
      }, [api])

      React.useEffect(function () {
        loadStatus()
        loadDevices()
        loadRelay()
        loadPending()
        // 只在挂载时读一次：设置面板的信息不需要实时刷新，
        // 每秒轮询会让它在后台一直发请求。
      }, [loadStatus, loadDevices, loadRelay, loadPending])

      // 待确认配对单独轮询：它有时效（2 分钟），且用户点开面板
      // 往往正是因为"手机上正在配"。5 秒一次，面板关掉就停。
      React.useEffect(function () {
        var t = setInterval(loadPending, 5000)
        return function () { clearInterval(t) }
      }, [loadPending])

      React.useEffect(function () {
        if (pairState.left <= 0) return
        var t = setTimeout(function () {
          setPair(function (p) { return Object.assign({}, p, { left: p.left - 1 }) })
        }, 1000)
        return function () { clearTimeout(t) }
      }, [pairState.left])

      function savePassword() {
        if (pwState.next.length < 8) {
          setPw(function (p) { return Object.assign({}, p, { msg: '密码至少 8 位', kind: 'err' }) })
          return
        }
        api.setPassword(pwState.next, status.hasPassword ? pwState.current : undefined).then(function (out) {
          if (out.status === 200) {
            setPw(function (p) { return Object.assign({}, p, { next: '', current: '', msg: '已保存，锁屏生效', kind: 'ok' }) })
            loadStatus()
          } else {
            setPw(function (p) { return Object.assign({}, p, { msg: (out.body && out.body.error) || '保存失败', kind: 'err' }) })
          }
        })
      }

      function clearPassword() {
        if (pwState.current.length === 0) {
          setPw(function (p) { return Object.assign({}, p, { msg: '先在「当前密码」里填入', kind: 'err' }) })
          return
        }
        api.clearPassword(pwState.current).then(function (out) {
          if (out.status === 200) {
            setPw(function (p) { return Object.assign({}, p, { current: '', msg: '已清除，锁屏不再生效', kind: 'ok' }) })
            loadStatus()
          } else {
            setPw(function (p) { return Object.assign({}, p, { msg: (out.body && out.body.error) || '清除失败', kind: 'err' }) })
          }
        })
      }

      function saveRelay() {
        var value = relayState.url.trim()
        if (value.length > 0 && !/^wss?:\/\//.test(value)) {
          setRelay(function (r) { return Object.assign({}, r, { msg: '必须填 ws:// 或 wss:// 开头的地址', kind: 'err' }) })
          return
        }
        api.setRelay(value).then(function (out) {
          if (out.status === 200) {
            setRelay(function (r) {
              return Object.assign({}, r, {
                url: '',
                current: out.body.relayUrl || '',
                endpoints: out.body.endpoints || [],
                msg: value.length === 0 ? '已清除，只用局域网' : '已保存，下次生成配对码即生效',
                kind: 'ok',
              })
            })
          } else {
            setRelay(function (r) { return Object.assign({}, r, { msg: (out.body && out.body.error) || '保存失败', kind: 'err' }) })
          }
        })
      }

      function approvePending(code) {
        api.approvePair(code).then(function (out) {
          if (out.status === 200) {
            setPending(function (list) { return list.filter(function (p) { return p.code !== code }) })
            loadDevices()
          } else {
            loadPending()
          }
        })
      }

      function makePair() {
        api.startPair().then(function (out) {
          if (out.status !== 200) {
            setPair(function (p) { return Object.assign({}, p, { msg: '生成失败', kind: 'err' }) })
            return
          }
          var left = Math.max(0, Math.round((out.body.expiresAt - Date.now()) / 1000))
          setPair({
            code: out.body.code,
            left: left,
            msg: '',
            kind: '',
            // 二维码矩阵由宿主算好（body.qr），这里只存下来供渲染。
            // 设置面板与独立设置页必须表现一致——之前只有独立页有二维码，
            // 从 dsh 设置里点「生成配对码」只看到 6 位数字，用户以为没生成。
            qr: out.body.qr || null,
            wsUrl: typeof out.body.wsUrl === 'string' ? out.body.wsUrl : '',
            candidates: Array.isArray(out.body.candidates) ? out.body.candidates : [],
          })
        })
      }

      function revoke(deviceId) {
        api.revoke(deviceId).then(function (out) {
          if (out.status === 200) {
            setDev(function (d) { return Object.assign({}, d, { msg: '已撤销', kind: 'ok' }) })
            loadDevices()
            loadStatus()
          } else {
            setDev(function (d) { return Object.assign({}, d, { msg: (out.body && out.body.error) || '撤销失败', kind: 'err' }) })
          }
        })
      }

      return e('div', { className: '__dl_root' },
        // ── 头部 ──
        e('div', { className: '__dl_intro' },
          e('span', { className: '__dl_badge' }, 'MOSS'),
          e('span', null, 'LINK · 远程访问与锁屏')
        ),
        e('div', { className: '__dl_group' },
          e('div', { className: '__dl_row' },
            e('div', { className: '__dl_label' },
              e('span', { className: '__dl_name' }, '锁屏状态'),
              e('span', { className: '__dl_hint' },
                status.armed ? '已启用' : '未生效（未设置密码）',
                ' · ',
                status.locked ? '已锁定' : '未锁',
                ' · 在线设备 ' + String(status.connections || 0))
            ),
            e('div', { className: '__dl_btns' },
              e('button', {
                type: 'button', className: '__dl_btn',
                onClick: function () { api.lockNow().then(function () { loadStatus() }) }
              }, '立即锁定')
            )
          ),
          e('div', { className: '__dl_note' },
            '锁的是 dsh 的操作能力，不是操作系统登录屏。正在运行的任务不会因为锁屏而暂停。')
        ),

        // ── 密码 ──
        e('div', { className: '__dl_group' },
          e('div', { className: '__dl_title' }, '锁屏密码'),
          status.hasPassword
            ? e('div', { className: '__dl_two' },
                e('label', { className: '__dl_label' },
                  e('span', { className: '__dl_hint' }, '新密码（至少 8 位）'),
                  e('input', {
                    className: '__dl_input', type: 'password', autoComplete: 'new-password',
                    value: pwState.next,
                    onChange: function (ev) { setPw(function (p) { return Object.assign({}, p, { next: ev.target.value }) }) }
                  })
                ),
                e('label', { className: '__dl_label' },
                  e('span', { className: '__dl_hint' }, '当前密码'),
                  e('input', {
                    className: '__dl_input', type: 'password', autoComplete: 'current-password',
                    value: pwState.current,
                    onChange: function (ev) { setPw(function (p) { return Object.assign({}, p, { current: ev.target.value }) }) }
                  })
                )
              )
            : e('label', { className: '__dl_label' },
                e('span', { className: '__dl_hint' }, '设置密码后锁屏才会生效'),
                e('input', {
                  className: '__dl_input', type: 'password', autoComplete: 'new-password',
                  placeholder: '至少 8 位',
                  value: pwState.next,
                  onChange: function (ev) { setPw(function (p) { return Object.assign({}, p, { next: ev.target.value }) }) }
                })
              ),
          e('div', { className: '__dl_btns' },
            e('button', { type: 'button', className: '__dl_btn __dl_btnPri', onClick: savePassword },
              status.hasPassword ? '修改密码' : '设置密码'),
            status.hasPassword
              ? e('button', { type: 'button', className: '__dl_btn __dl_btnDanger', onClick: clearPassword }, '清除密码')
              : null
          ),
          pwState.msg
            ? e('div', { className: '__dl_status ' + (pwState.kind === 'ok' ? '__dl_ok' : '__dl_err') }, pwState.msg)
            : null
        ),

        // ── 公网接入（nps / frp）──
        // 这一块之前只做在独立设置页里，而用户打开的是 dsh 设置面板——
        // 同一个功能两个入口只做一个，等于没做。
        e('div', { className: '__dl_group' },
          e('div', { className: '__dl_title' }, '公网接入（nps / frp）'),
          e('div', { className: '__dl_hint' },
            '不在同一局域网时，用 nps / frp 把 7443 映射到公网。填公网可达地址后，配对二维码优先用它。'),
          relayState.current
            ? e('div', { className: '__dl_note' }, '当前生效：' + relayState.current)
            : e('div', { className: '__dl_hint' },
                '当前只用局域网地址（' + String(relayState.endpoints.length) + ' 个）'),
          e('label', { className: '__dl_label', style: { marginTop: 10 } },
            e('span', { className: '__dl_hint' }, '中继地址'),
            e('input', {
              className: '__dl_input',
              type: 'text',
              placeholder: 'wss://your-domain.example/dshlink',
              value: relayState.url,
              onChange: function (ev) { setRelay(function (r) { return Object.assign({}, r, { url: ev.target.value }) }) },
            })
          ),
          e('div', { className: '__dl_btns', style: { marginTop: 10 } },
            e('button', { type: 'button', className: '__dl_btn __dl_btnPri', onClick: saveRelay }, '保存'),
            e('button', { type: 'button', className: '__dl_btn', onClick: function () {
              setRelay(function (r) { return Object.assign({}, r, { url: '' }) })
              api.setRelay('').then(function () { loadRelay() })
            } }, '清除')
          ),
          e('div', { className: '__dl_note', style: { marginTop: 10 } },
            '注意：nps 的 TCP 隧道是裸转发、不加 TLS，而本插件网关是明文 WebSocket。' +
            '没有域名时请只用局域网；有域名走「域名转发」才会是密文。'),
          relayState.msg
            ? e('div', { className: '__dl_status ' + (relayState.kind === 'ok' ? '__dl_ok' : '__dl_err') }, relayState.msg)
            : null
        ),

        // ── 配对 ──
        e('div', { className: '__dl_group' },
          e('div', { className: '__dl_title' }, '配对新设备'),
          // 手机点「扫码配对」时是**手机发起**的，宿主这边会留一条待确认记录。
          // 不把这个列表画出来，用户永远等不到结果——pair.finish 会一直是
          // auth/forbidden，表现就是"配对超时"。这是配对链路的关键一环。
          pending.length > 0
            ? e('div', { className: '__dl_pending' },
                e('div', { className: '__dl_pendingTitle' },
                  '有 ' + String(pending.length) + ' 台设备正在等待确认'),
                pending.map(function (p) {
                  return e('div', { key: p.code, className: '__dl_pendingRow' },
                    e('div', { style: { minWidth: 0 } },
                      e('div', { className: '__dl_devName' }, '配对码 ' + p.code),
                      e('div', { className: '__dl_devMeta' },
                        String(Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))) + ' 秒后失效')
                    ),
                    e('button', {
                      type: 'button',
                      className: '__dl_btn __dl_btnPri',
                      onClick: function () { approvePending(p.code) }
                    }, '允许')
                  )
                })
              )
            : null,
          e('div', { className: '__dl_hint' },
            '生成 6 位码，在手机 App 的「添加电脑」里输入。码 2 分钟内有效，只能用一次。'),
          pairState.code && pairState.left > 0
            ? e('div', null,
                pairState.qr ? e(QrCanvas, { qr: pairState.qr, size: 188 }) : null,
                e('div', { className: '__dl_code' }, pairState.code),
                e('div', { className: '__dl_codeHint' }, String(pairState.left) + ' 秒后失效'),
                pairState.wsUrl
                  ? e('div', { className: '__dl_addr' },
                      e('span', { className: '__dl_addrLabel' }, '地址'),
                      e('code', null, pairState.wsUrl))
                  : null,
                pairState.candidates.length > 1
                  ? e('div', { className: '__dl_hint' },
                      '连不上时换用：' + pairState.candidates.slice(1).map(function (c) { return c.wsUrl }).join(' / '))
                  : null)
            : pairState.code
              ? e('div', { className: '__dl_hint' }, '配对码已过期，请重新生成')
              : null,
          e('div', { className: '__dl_btns' },
            e('button', { type: 'button', className: '__dl_btn __dl_btnPri', onClick: makePair }, '生成配对码')
          ),
          pairState.msg
            ? e('div', { className: '__dl_status __dl_err' }, pairState.msg)
            : null
        ),

        // ── 设备 ──
        e('div', { className: '__dl_group' },
          e('div', { className: '__dl_title' }, '已配对设备'),
          devState.list.length === 0
            ? e('div', { className: '__dl_hint' }, '还没有配对任何设备')
            : devState.list.map(function (d) {
                return e('div', { key: d.deviceId, className: '__dl_dev' },
                  e('div', { style: { minWidth: 0, flex: 1 } },
                    e('div', { className: '__dl_devName' }, d.label),
                    e('div', { className: '__dl_devMeta' }, (d.platform || '?') + ' · ' + d.role)
                  ),
                  e('div', { className: '__dl_btns' },
                    e('button', {
                      type: 'button', className: '__dl_btn',
                      onClick: function () {
                        // 用浏览器 prompt 起名：设置面板里不值得为一次改命
                        // 引入一个完整的表单状态机。改名是低频、单字段操作。
                        var next = window.prompt('给这台设备起个名字', d.label)
                        if (next === null) return
                        var label = String(next).trim()
                        if (label.length === 0) return
                        api.renameDevice(d.deviceId, label).then(function (out) {
                          if (out.status === 200) { loadDevices() }
                          else setDev(function (s) { return Object.assign({}, s, { msg: (out.body && out.body.error) || '改名失败', kind: 'err' }) })
                        })
                      }
                    }, '改名'),
                    e('button', {
                      type: 'button', className: '__dl_btn __dl_btnDanger',
                      onClick: function () { revoke(d.deviceId) }
                    }, '撤销')
                  )
                )
              }),
          e('div', { className: '__dl_note' },
            '撤销后该设备的令牌立即失效，正在连接的也会被断开。'),
          devState.msg
            ? e('div', { className: '__dl_status ' + (devState.kind === 'ok' ? '__dl_ok' : '__dl_err') }, devState.msg)
            : null
        )
      )
    }

    exports.apply = apply
    // 刻意留空：slots 只用来注册设置面板，缺了它锁层仍要工作。
    // 声明 inject 会让"没有 slots 的组合"直接不加载这个插件——锁屏就没了。
    exports.inject = []
    return module.exports
  }
})
