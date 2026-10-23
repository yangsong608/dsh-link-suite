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

    var BASE = '/dsh-link'
    var ROOT_ID = 'dsh-link-lock'
    var POLL_MS = 1000
    var MAX_DOTS = 8

    var state = {
      armed: false,
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
        state.locked = out.body.locked === true
        state.soft = out.body.soft === true
        state.since = out.body.since || 0
        state.reason = out.body.reason || ''
        state.attemptsLeft = out.body.attemptsLeft
        if (state.locked && !was) render()
        if (!state.locked && was) unmount()
      }).catch(function () { /* 宿主没起来时静默，下一次再试 */ })
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
        '  <div class="bar"><span class="dot"></span><b>DSH-LINK / HOST</b><span class="tag">LOCKED</span></div>',
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
      $('[data-act="request"]', root).addEventListener('click', function () {
        msg.textContent = '已向主机发送解锁请求，请在电脑上确认'
      })

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
      // 全局快捷键（⌘K / ⌘P / ⌘⇧L…）在锁定时必须全部吞掉
      window.addEventListener('keydown', function (e) {
        if (!document.getElementById(ROOT_ID)) return
        var k = e.key.toLowerCase()
        if ((e.metaKey || e.ctrlKey) && k !== 'v') { e.preventDefault(); e.stopPropagation() }
      }, true)
      window.addEventListener('contextmenu', swallow, true)
      window.addEventListener('selectstart', swallow, true)
      window.addEventListener('dragstart', swallow, true)

      // 有钱能使鬼推磨，但没网络不能解锁：先拉一次，再按 1s 轮询
      poll()
      state.poll = setInterval(poll, POLL_MS)

      ctx.effect(function () {
        return function () {
          if (state.poll) clearInterval(state.poll)
          unmount()
        }
      }, 'dsh-link: lock overlay')
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  }
})
