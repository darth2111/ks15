/* Solo simulator of the "Seeker's Unity" mini-game.
   Rules (fitted from the recorded game, see PLAN.md): 26 targets of the room's pool, list window of 6 (2x3, shifts left on a find),
   75 s timer, points per find = 100 * multiplier-bar cells, accuracy 2000 - 200 per error, speed = remaining seconds * 200. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const simEl = $('#sim'), mapEl = $('#map'), statusEl = $('#status');
  const tabBtns = [...document.querySelectorAll('.tab')];
  const SERIES_LEN = 20;
  const HIT_TOL = 1.5;            // scene px of forgiveness around an item's mask (the game itself is strict)
  const DECOY_CHANCE = 0.75;      // chance for a pool item that is not a target to stand in the scene anyway
  const fmt = n => Math.round(n).toLocaleString('ru-RU');

  let R = null, rules = null;
  let phase = 'menu';              // menu | countdown | play | result | series
  let round = null, series = null, stats = null, opts = { weak: false };
  let els = {}, raf = 0, fitSize = { W: 0, H: 0 };

  // ------------------------------------------------------------ storage (may be unavailable)
  const KEY = k => 'finder.' + k + '.' + R.room.id;
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(KEY(k))); return v == null ? d : v; } catch (_) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(KEY(k), JSON.stringify(v)); } catch (_) { /* ignore */ } };

  // ------------------------------------------------------------ rules with defaults
  function readRules() {
    const r = R.room.rules || {}, m = r.multiplier || {};
    rules = {
      targets: Math.min(r.targets || 26, R.items.length), timer: r.timerSec || 75, base: r.basePoints || 100,
      accStart: r.accuracyStart || 2000, accPen: r.accuracyPenalty || 200, speed: r.speedPerSec || 200,
      grace: r.graceMs != null ? r.graceMs : 1000, offListIsMiss: r.offListIsMiss !== false,
      maxCells: m.maxCells || 6, decay: m.decayCellsPerSec || 1.5, hold: m.holdSec != null ? m.holdSec : 0.75,
    };
  }

  // ------------------------------------------------------------ round setup
  function pickTargets() {
    const items = R.items, n = rules.targets;
    const avg = items.map(it => { const s = stats.items[it.name]; return s && s.n ? s.sum / s.n : null; });
    const known = avg.filter(v => v != null);
    const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    // weighted sample without replacement (Efraimidis-Spirakis); weights are flat unless "weak items" is on
    const keyed = items.map((it, i) => {
      let w = 1;
      if (opts.weak && avg[i] != null) w = 0.4 + Math.pow(avg[i] / mean, 2);
      return [Math.pow(Math.random(), 1 / w), i];
    });
    keyed.sort((a, b) => b[0] - a[0]);
    return keyed.slice(0, n).map(k => k[1]);
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function newRound() {
    const targets = pickTargets(), tset = new Set(targets);
    const present = new Set(targets);
    R.items.forEach((_, i) => { if (!tset.has(i) && Math.random() < DECOY_CHANCE) present.add(i); });
    const queue = shuffle(targets.slice());
    round = {
      targets: tset, present, queue, visible: queue.splice(0, 6), appear: {}, found: new Map(), misses: [], recent: [],
      L: 0, Lt: 0, errors: 0, tStart: 0, tLast: 0, lastFind: 0, done: false, allFound: false,
    };
    round.visible.forEach(i => { round.appear[i] = 0; });
  }
  // multiplier bar: holds for rules.hold seconds after a find, then falls rules.decay cells per second
  const curL = now => Math.max(0, round.L - rules.decay * Math.max(0, (now - round.Lt) / 1000 - rules.hold));

  // ------------------------------------------------------------ DOM
  function build() {
    simEl.innerHTML = `
      <div class="sim-top">
        <button class="sim-back" type="button" hidden>← Выйти</button>
        <span class="chip" id="simTimer" hidden>⏱ <b>75</b> сек.</span>
        <span class="sim-attempt" id="simAttempt"></span>
        <span class="chip" id="simCount" hidden><b>0</b>/26</span>
      </div>
      <div class="sim-stage"><div id="simScene">
        <img class="base" alt="" draggable="false">
        <div class="sprites"></div>
        <div class="bar" hidden></div>
        <div class="fx"></div>
        <div class="heat" hidden></div>
        <div class="cd" hidden><div>Таймер начала</div><b>3</b></div>
      </div></div>
      <div class="sim-bottom"><div class="list" hidden></div><div class="panel"></div></div>`;
    els = {
      back: simEl.querySelector('.sim-back'), timer: simEl.querySelector('#simTimer'), count: simEl.querySelector('#simCount'),
      attempt: simEl.querySelector('#simAttempt'), stage: simEl.querySelector('.sim-stage'), scene: simEl.querySelector('#simScene'),
      base: simEl.querySelector('img.base'), sprites: simEl.querySelector('.sprites'), bar: simEl.querySelector('.bar'),
      fx: simEl.querySelector('.fx'), heat: simEl.querySelector('.heat'), cd: simEl.querySelector('.cd'),
      bottom: simEl.querySelector('.sim-bottom'), list: simEl.querySelector('.list'), panel: simEl.querySelector('.panel'),
    };
    els.base.src = R.base + R.room.plate;   // empty room: items are separate sprites, so a found item really disappears
    const [sw, sh] = R.room.size;
    R.items.forEach((it, i) => {
      const img = document.createElement('img');
      img.className = 'sp'; img.src = R.base + it.sprite; img.alt = ''; img.draggable = false;
      Object.assign(img.style, { left: it.bbox[0] / sw * 100 + '%', top: it.bbox[1] / sh * 100 + '%', width: it.bbox[2] / sw * 100 + '%', height: it.bbox[3] / sh * 100 + '%' });
      it.simEl = img; els.sprites.append(img);
    });
    els.bar.innerHTML = [2, 3, 4, 5, 6, 7].slice(0, rules.maxCells).map(m => `<i><u></u><span>${m}X</span></i>`).join('');
    els.back.addEventListener('click', () => { abortRound(); setPhase('menu'); });
    els.scene.addEventListener('pointerdown', onTap);
    new ResizeObserver(fit).observe(simEl);
  }

  // Fit the scene into the free area; the bottom panel height depends on the phase
  function fit() {
    const W = simEl.clientWidth, H = simEl.clientHeight;
    if (!W || !H || !els.stage) return;
    fitSize = { W, H };
    const topH = els.back.parentNode.offsetHeight;
    const wantBottom = phase === 'play' || phase === 'countdown' ? 108 : (phase === 'menu' ? 172 : 250);
    const bottomH = Math.min(wantBottom, Math.max(90, H * 0.45));
    const availH = H - topH - bottomH - 6, availW = W;
    const [sw, sh] = R.room.size;
    const s = Math.max(0.1, Math.min(availW / sw, availH / sh, 1.3));
    Object.assign(els.scene.style, { width: sw * s + 'px', height: sh * s + 'px' });
    els.bottom.style.height = bottomH + 'px';
    els.bottom.style.width = Math.min(W, 600) + 'px';
    els.scene.style.setProperty('--s', s);
  }

  // ------------------------------------------------------------ phases / panels
  function setPhase(p) {
    phase = p;
    const playing = p === 'play' || p === 'countdown';
    els.back.hidden = !playing; els.timer.hidden = !playing; els.count.hidden = !playing;
    els.list.hidden = !playing; els.panel.hidden = playing;
    els.bar.hidden = true; els.cd.hidden = p !== 'countdown';
    els.heat.hidden = p !== 'result'; els.scene.classList.toggle('blur', p === 'countdown');
    const k = series.attempts.length + 1;
    els.attempt.textContent = playing ? '' : (p === 'series' ? 'Итоги серии' : 'Попытка ' + Math.min(k, SERIES_LEN) + ' из ' + SERIES_LEN);
    if (p === 'menu') renderMenu();
    if (p === 'result') renderResult();
    if (p === 'series') renderSeries();
    if (p === 'menu' || p === 'series') showIdleScene();
    fit();
  }

  function showIdleScene() {
    els.fx.innerHTML = ''; els.heat.innerHTML = '';
    R.items.forEach(it => { it.simEl.style.display = ''; it.simEl.className = 'sp idle'; });
  }

  function renderMenu() {
    const k = series.attempts.length + 1;
    const hasStats = Object.keys(stats.items).length > 0;
    const done = series.attempts.length;
    const best = done ? Math.max.apply(null, series.attempts.map(a => a.total)) : 0;
    els.panel.innerHTML = `
      <div class="menu">
        <p class="hint">${rules.targets} предметов из ${R.items.length}, ${rules.timer} секунд.${done ? ` Сыграно ${done} из ${SERIES_LEN}, лучший результат ${fmt(best)}.` : ''}</p>
        <label class="opt"><input type="checkbox" id="optWeak" ${opts.weak ? 'checked' : ''} ${hasStats ? '' : 'disabled'}> Чаще давать предметы, которые я долго ищу${hasStats ? '' : ' (после первой попытки)'}</label>
        <div class="btns"><button class="primary" id="btnStart" type="button">${k > SERIES_LEN ? 'Новая серия' : 'Начать'}</button>
        ${done ? '<button id="btnSeries" type="button">Итоги серии</button>' : ''}${done ? '<button id="btnReset" type="button">Сбросить</button>' : ''}</div>
      </div>`;
    els.panel.querySelector('#btnStart').onclick = () => { if (series.attempts.length >= SERIES_LEN) newSeries(); startCountdown(); };
    const w = els.panel.querySelector('#optWeak'); if (w) w.onchange = () => { opts.weak = w.checked; };
    const bs = els.panel.querySelector('#btnSeries'); if (bs) bs.onclick = () => setPhase('series');
    const br = els.panel.querySelector('#btnReset'); if (br) br.onclick = () => { if (confirm('Сбросить серию? Статистика по предметам останется.')) { newSeries(); setPhase('menu'); } };
  }
  function newSeries() { series = { attempts: [] }; save('series', series); }

  // ------------------------------------------------------------ countdown / play
  function startCountdown() {
    newRound();
    R.items.forEach((it, i) => { it.simEl.className = 'sp'; it.simEl.style.display = round.present.has(i) ? '' : 'none'; });
    els.fx.innerHTML = '';
    renderList(true);
    updateCounter();
    setPhase('countdown');
    let n = 3; els.cd.querySelector('b').textContent = n;
    const tick = setInterval(() => {
      if (phase !== 'countdown') { clearInterval(tick); return; }
      n--;
      if (n <= 0) { clearInterval(tick); startPlay(); } else els.cd.querySelector('b').textContent = n;
    }, 1000);
  }
  function startPlay() {
    setPhase('play');
    els.scene.classList.remove('blur');
    round.tStart = performance.now(); round.Lt = round.tStart; round.lastFind = round.tStart;
    loop();
  }
  function abortRound() { cancelAnimationFrame(raf); round = null; }

  function loop() {
    if (phase !== 'play') return;
    const now = performance.now();
    const rem = rules.timer - (now - round.tStart) / 1000;
    els.timer.querySelector('b').textContent = Math.max(0, Math.ceil(rem));
    updateBar(curL(now));
    if (rem <= 0) { endRound(false, now); return; }
    raf = requestAnimationFrame(loop);
  }
  function updateBar(L) {
    if (round.found.size === 0) return;
    els.bar.hidden = false;
    [...els.bar.children].forEach((c, j) => {
      const f = Math.max(0, Math.min(1, L - j));
      c.firstChild.style.width = f * 100 + '%';
      c.classList.toggle('on', f > 0.02);
    });
  }
  function updateCounter() { els.count.innerHTML = `<b>${round.found.size}</b>/${rules.targets}`; }

  // ------------------------------------------------------------ list (window of 6, shifts left)
  function renderList(initial) {
    const list = els.list;
    if (initial) { list.innerHTML = ''; round.btn = new Map(); }
    // remove buttons that left the window
    for (const [i, b] of round.btn) if (!round.visible.includes(i)) { b.classList.add('out'); setTimeout(() => b.remove(), 250); round.btn.delete(i); }
    round.visible.forEach((i, slot) => {
      let b = round.btn.get(i);
      if (!b) {
        b = document.createElement('div'); b.className = 'item' + (R.items[i].name.split(' ').some(w => w.length > 12) ? ' long' : ''); b.innerHTML = '<span></span>'; b.firstChild.textContent = R.items[i].name;
        b.style.setProperty('--c', 2); b.style.setProperty('--r', 1);   // enters at the end
        list.append(b); round.btn.set(i, b);
        void b.offsetWidth;
      }
      b.style.setProperty('--c', slot % 3); b.style.setProperty('--r', Math.floor(slot / 3));
    });
  }

  // ------------------------------------------------------------ taps
  function sceneXY(e) {
    const r = els.scene.getBoundingClientRect(), k = r.width / R.room.size[0];
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }
  function hitAt(x, y, idxs) {
    let hit = -1, ha = 1e18;
    for (const i of idxs) {
      const it = R.items[i];
      if (x < it.bbox[0] - HIT_TOL || x > it.bbox[0] + it.bbox[2] + HIT_TOL || y < it.bbox[1] - HIT_TOL || y > it.bbox[1] + it.bbox[3] + HIT_TOL) continue;
      if (R.maskNear(it, x, y, HIT_TOL) && it.area < ha) { hit = i; ha = it.area; }
    }
    return hit;
  }
  function onTap(e) {
    if (phase !== 'play' || !round || e.button > 0) return;
    e.preventDefault();
    const now = performance.now(), { x, y } = sceneXY(e);
    const live = [...round.present].filter(i => !round.found.has(i));
    const hit = hitAt(x, y, live);
    if (hit >= 0 && round.visible.includes(hit)) return find(hit, now);
    if (hit >= 0) {                                    // decoy, or a target that is not in the list yet
      if (round.targets.has(hit) && !rules.offListIsMiss) return;
      return miss(x, y, now);
    }
    // just-found item tapped again within the grace window: no error
    const recent = round.recent.filter(r => now - r.t <= rules.grace).map(r => r.i);
    if (recent.length && hitAt(x, y, recent) >= 0) return;
    miss(x, y, now);
  }
  function fx(html, cls, x, y, ms) {
    const d = document.createElement('div');
    d.className = cls; d.innerHTML = html;
    d.style.left = x / R.room.size[0] * 100 + '%'; d.style.top = y / R.room.size[1] * 100 + '%';
    els.fx.append(d); setTimeout(() => d.remove(), ms);
  }
  function miss(x, y, now) {
    round.errors++; round.misses.push({ x, y });
    fx('<svg viewBox="0 0 24 24"><path d="M4 4L20 20M20 4L4 20"/></svg>', 'xmark', x, y, 650);
  }
  function find(i, now) {
    const it = R.items[i];
    const L = Math.min(rules.maxCells, Math.ceil(curL(now) - 1e-9) + 1);
    round.L = L; round.Lt = now;
    const pts = rules.base * L;
    const dt = (now - Math.max(round.lastFind, round.tStart + (round.appear[i] || 0))) / 1000;
    round.found.set(i, { dt, pts, t: now });
    round.lastFind = now; round.tLast = now; round.recent.push({ i, t: now });
    it.simEl.classList.add('found'); setTimeout(() => { it.simEl.style.display = 'none'; it.simEl.classList.remove('found'); }, 420);
    fx(fmt(pts), 'pop', R.room.size[0] / 2, R.room.size[1] * 0.42, 1000);
    // list: remove from window, remaining shift left, next from the queue enters at the end
    round.visible.splice(round.visible.indexOf(i), 1);
    if (round.queue.length) { const nx = round.queue.shift(); round.visible.push(nx); round.appear[nx] = (now - round.tStart); }
    renderList(false); updateCounter(); updateBar(L);
    if (round.found.size >= rules.targets) endRound(true, now);
  }

  // ------------------------------------------------------------ results
  function endRound(all, now) {
    cancelAnimationFrame(raf);
    round.done = true; round.allFound = all;
    const itemsPts = [...round.found.values()].reduce((s, f) => s + f.pts, 0);
    const accuracy = round.found.size ? Math.max(0, rules.accStart - rules.accPen * round.errors) : 0;
    const remaining = all ? Math.max(0, rules.timer - (round.tLast - round.tStart) / 1000) : 0;
    const speed = Math.floor(remaining) * rules.speed;
    const total = itemsPts + accuracy + speed;
    const times = {};
    for (const [i, f] of round.found) {
      const nm = R.items[i].name; times[nm] = +f.dt.toFixed(2);
      const s = stats.items[nm] || (stats.items[nm] = { n: 0, sum: 0 }); s.n++; s.sum += f.dt;
    }
    round.result = { all, items: itemsPts, accuracy, speed, total, errors: round.errors, found: round.found.size,
      sec: +(((all ? round.tLast : now) - round.tStart) / 1000).toFixed(1), times };
    series.attempts.push({ ...round.result }); save('series', series); save('stats', stats);
    setPhase('result');
  }

  function heatColor(dt, lo, hi) {   // green (fast) .. red (slow) relative to this round
    const t = hi > lo ? Math.max(0, Math.min(1, (dt - lo) / (hi - lo))) : 0;
    return `hsl(${Math.round(120 - 120 * t)} 85% 48%)`;
  }
  function renderResult() {
    const res = round.result, k = series.attempts.length;
    els.attempt.textContent = 'Попытка ' + k + ' из ' + SERIES_LEN;
    // heat map over the scene
    const dts = [...round.found.values()].map(f => f.dt).sort((a, b) => a - b);
    const lo = dts.length ? dts[0] : 0, hi = dts.length ? dts[Math.floor(dts.length * 0.9)] : 1;
    let html = '';
    const [sw, sh] = R.room.size;
    for (const i of round.targets) {
      const it = R.items[i], f = round.found.get(i);
      const x = it.anchor[0] / sw * 100, y = it.anchor[1] / sh * 100;
      html += f ? `<div class="dot" style="left:${x}%;top:${y}%;--c:${heatColor(f.dt, lo, hi)}"><span>${f.dt < 10 ? f.dt.toFixed(1) : Math.round(f.dt)}</span></div>`
                : `<div class="dot nf" style="left:${x}%;top:${y}%"><span>—</span></div>`;
    }
    for (const m of round.misses) html += `<div class="xm" style="left:${m.x / sw * 100}%;top:${m.y / sh * 100}%"><svg viewBox="0 0 24 24"><path d="M4 4L20 20M20 4L4 20"/></svg></div>`;
    els.heat.innerHTML = html;
    R.items.forEach((it, i) => { it.simEl.style.display = round.present.has(i) && !round.found.has(i) ? '' : 'none'; });
    const slow = Object.entries(res.times).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const last = k >= SERIES_LEN;
    els.panel.innerHTML = `
      <div class="res">
        <h2>${res.all ? 'Все предметы найдены' : 'Время вышло: ' + res.found + ' из ' + rules.targets}</h2>
        <table>
          <tr><td>Очки за предметы</td><td>${fmt(res.items)}</td></tr>
          <tr><td>Очки за точность (ошибок: ${res.errors})</td><td>${fmt(res.accuracy)}</td></tr>
          <tr><td>Очки за скорость</td><td>${fmt(res.speed)}</td></tr>
          <tr class="tot"><td>Итого</td><td>${fmt(res.total)}</td></tr>
        </table>
        ${slow.length ? `<p class="hint">Дольше всего: ${slow.map(([n, t]) => n + ' ' + t.toFixed(1) + ' с').join(', ')}. Время у предмета на карте: секунды от предыдущей находки (а для только что появившихся в списке — от их появления) до тапа.</p>` : ''}
        <div class="btns"><button class="primary" id="btnNext" type="button">${last ? 'Итоги серии' : 'Следующая попытка ' + (k + 1)}</button><button id="btnMenu" type="button">Меню</button></div>
      </div>`;
    els.panel.querySelector('#btnNext').onclick = () => { if (last) setPhase('series'); else startCountdown(); };
    els.panel.querySelector('#btnMenu').onclick = () => setPhase('menu');
  }

  function renderSeries() {
    const a = series.attempts, n = a.length;
    const totals = a.map(x => x.total);
    const sum = totals.reduce((s, v) => s + v, 0);
    const weak = Object.entries(stats.items).filter(([, s]) => s.n >= 3).map(([name, s]) => [name, s.sum / s.n, s.n])
      .sort((x, y) => y[1] - x[1]).slice(0, 8);
    els.panel.innerHTML = `
      <div class="res">
        <h2>Серия: ${n} из ${SERIES_LEN}</h2>
        <table>
          <tr><td>Сумма очков</td><td>${fmt(sum)}</td></tr>
          <tr><td>В среднем за попытку</td><td>${n ? fmt(sum / n) : '—'}</td></tr>
          <tr><td>Лучшая / худшая</td><td>${n ? fmt(Math.max.apply(null, totals)) + ' / ' + fmt(Math.min.apply(null, totals)) : '—'}</td></tr>
        </table>
        ${weak.length ? `<p class="hint">Дольше всего ищу (среднее, с): ${weak.map(([nm, t]) => nm + ' ' + t.toFixed(1)).join('; ')}.</p>` : ''}
        <div class="btns"><button class="primary" id="btnNew" type="button">Новая серия</button><button id="btnMenu" type="button">Меню</button></div>
      </div>`;
    els.panel.querySelector('#btnNew').onclick = () => { newSeries(); setPhase('menu'); };
    els.panel.querySelector('#btnMenu').onclick = () => setPhase('menu');
  }

  // ------------------------------------------------------------ tabs
  function showTab(t) {
    const sim = t === 'sim';
    if (!sim && phase !== 'menu') { abortRound(); phase = 'menu'; }
    mapEl.hidden = sim; simEl.hidden = !sim; statusEl.hidden = sim;
    tabBtns.forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    try { history.replaceState(null, '', sim ? '#sim' : location.pathname + location.search); } catch (_) { /* ignore */ }
    if (sim) { if (!els.stage) return; if (phase === 'menu') setPhase('menu'); fit(); }
  }

  function boot() {
    R = window.FinderRoom; readRules();
    series = load('series', { attempts: [] }); stats = load('stats', { items: {} });
    build();
    tabBtns.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    setPhase('menu');
    if (location.hash === '#sim') showTab('sim');
    window.__sim = { get round() { return round; }, get phase() { return phase; }, rules, startCountdown, find, endRound: () => endRound(false, performance.now()), get series() { return series; } };
  }
  if (window.FinderRoom) boot(); else document.addEventListener('finder:ready', boot, { once: true });
})();
