/* Interactive map: scene in the middle, labels around it; click a label -> item lights up, tap an item -> label.
   Pinch / wheel zoom + drag pan. Leader lines are optional (SHOW_LINES). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug');

  // ---------------------------------------------------------------- switches
  // Leader lines from labels to items. Off by default; turn on here or with ?lines=1 in the URL.
  const SHOW_LINES = params.get('lines') === '1';
  const MAX_ZOOM = 6;

  const mapEl = $('#map'), statusEl = $('#status');
  // label font tiers (small: phones, large: tablets/desktop); lh = height of a two-line label
  const TIERS = {
    small: { fs: 11.5, maxLine: 70, lh: 33, P: { pad: 5, gap: 10, vgap: 3, hgap: 4, maxS: 1.25 } },
    large: { fs: 13.5, maxLine: 104, lh: 37, P: { pad: 8, gap: 16, vgap: 4, hgap: 6, maxS: 1.25 } },
  };
  let T = TIERS.large, tierName = '';
  const fontOf = () => '700 ' + T.fs + 'px Nunito, system-ui, sans-serif';

  let room = null, base = '', items = [], sel = -1, lay = null;
  let worldEl, sceneEl, hlImg, svg, resetBtn;
  let z = 1, tx = 0, ty = 0, contentH = 0;

  const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const loadImg = u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // ---------------------------------------------------------------- label text metrics
  const mctx = document.createElement('canvas').getContext('2d');
  function wrapLabel(text) {
    mctx.font = fontOf();
    const w = t => mctx.measureText(t).width;
    if (w(text) <= T.maxLine) return { lines: [text], width: Math.ceil(w(text)) + 12 };
    const words = text.split(' ');
    let best = null;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      const m = Math.max(w(a), w(b));
      if (!best || m < best.m) best = { lines: [a, b], m };
    }
    if (!best) best = { lines: [text], m: w(text) };
    return { lines: best.lines, width: Math.ceil(best.m) + 12 };
  }
  function styleLabel(it) {
    it.el.innerHTML = '<span>' + it.wrap.lines.map(esc).join('<br>') + '</span>';
    it.el.style.width = it.wrap.width + 'px'; it.el.style.height = T.lh + 'px';
    it.el.style.fontSize = T.fs + 'px'; it.el.style.lineHeight = (T.fs + 1) + 'px';
  }

  // ---------------------------------------------------------------- masks (hit test, outline points for the layout)
  async function loadMasks() {
    await Promise.all(items.map(async it => {
      const img = await loadImg(base + it.sprite);
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const m = new Uint8Array(c.width * c.height);
      let area = 0;
      for (let i = 0; i < m.length; i++) if (d[i * 4 + 3] > 60) { m[i] = 1; area++; }
      const pts = [];
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (!m[y * c.width + x]) continue;
        const edge = x === 0 || y === 0 || x === c.width - 1 || y === c.height - 1 || !m[y * c.width + x - 1] || !m[y * c.width + x + 1] || !m[(y - 1) * c.width + x] || !m[(y + 1) * c.width + x];
        if (edge && ((x + y) % 2 === 0)) pts.push([it.bbox[0] + x, it.bbox[1] + y]);
      }
      if (pts.length > 90) { const st = Math.ceil(pts.length / 90); it.pts = pts.filter((_, k) => k % st === 0); } else it.pts = pts.length ? pts : [it.anchor];
      it.mask = m; it.mw = c.width; it.mh = c.height; it.area = area;
    }));
  }
  function maskNear(it, x, y, r) { // any mask pixel within r (scene px) of scene point (x,y)
    const lx = Math.round(x - it.bbox[0]), ly = Math.round(y - it.bbox[1]);
    r = Math.ceil(r);
    for (let dy = -r; dy <= r; dy++) {
      const yy = ly + dy; if (yy < 0 || yy >= it.mh) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = lx + dx; if (xx < 0 || xx >= it.mw) continue;
        if (it.mask[yy * it.mw + xx] && dx * dx + dy * dy <= r * r) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- DOM
  let suppressClick = false;
  function build() {
    mapEl.innerHTML = '';
    worldEl = document.createElement('div'); worldEl.id = 'world';
    sceneEl = document.createElement('div'); sceneEl.id = 'scene';
    const baseImg = document.createElement('img'); baseImg.className = 'base'; baseImg.src = base + room.full; baseImg.alt = ''; baseImg.draggable = false;
    const dim = document.createElement('div'); dim.className = 'dim';
    hlImg = document.createElement('img'); hlImg.className = 'hl'; hlImg.alt = ''; hlImg.draggable = false;
    sceneEl.append(baseImg, dim, hlImg);
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'lines';
    worldEl.append(sceneEl, svg);
    items.forEach((it, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'lbl' + (it.kind === 'engraving' ? ' eng' : '');
      it.el = b; styleLabel(it);
      b.addEventListener('click', e => { e.stopPropagation(); if (suppressClick) return; select(sel === i ? -1 : i); });
      worldEl.append(b);
    });
    resetBtn = document.createElement('button'); resetBtn.type = 'button'; resetBtn.id = 'zoomReset'; resetBtn.textContent = '⤢ 1×';
    resetBtn.title = 'Вернуть масштаб'; resetBtn.hidden = true;
    resetBtn.addEventListener('click', () => { z = 1; tx = ty = 0; applyView(); });
    mapEl.append(worldEl, resetBtn);
    window.addEventListener('keydown', e => { if (e.key === 'Escape') select(-1); });
    initGestures();
  }

  function doLayout() {
    mapEl.style.minHeight = '0';
    const W = mapEl.clientWidth, H = mapEl.clientHeight;
    if (!W || !H) return;
    const tn = W < 520 ? 'small' : 'large';
    if (tn !== tierName) { tierName = tn; T = TIERS[tn]; items.forEach(it => { it.wrap = wrapLabel(it.name); styleLabel(it); }); }
    lay = FinderLayout.layout({ W, H, room: room.size, widths: items.map(i => i.wrap.width), lh: T.lh,
      anchors: items.map(i => i.anchor), maskPts: items.map(i => i.pts), P: T.P, iters: SHOW_LINES ? 90000 : 0 });
    const { s, sceneX, sceneY, sceneW, sceneH } = lay;
    Object.assign(sceneEl.style, { left: sceneX + 'px', top: sceneY + 'px', width: sceneW + 'px', height: sceneH + 'px' });
    contentH = Math.max(H, lay.totalH);
    if (lay.totalH > H + 1) mapEl.style.minHeight = lay.totalH + 'px';   // tiny screens: let the page scroll
    Object.assign(worldEl.style, { width: W + 'px', height: contentH + 'px' });
    svg.setAttribute('width', W); svg.setAttribute('height', contentH); svg.style.width = W + 'px';
    svg.innerHTML = '';
    items.forEach((it, i) => {
      const k = lay.assign[i], sl = lay.slots[k], c = lay.conn[k];
      const w = it.wrap.width;
      let left;
      if (sl.side === 'L') left = sl.cx - w; else if (sl.side === 'R') left = sl.cx; else left = sl.cx - w / 2;
      left = Math.max(2, Math.min(W - w - 2, left));
      it.el.style.left = left + 'px'; it.el.style.top = (sl.cy - T.lh / 2) + 'px';
      it.g = null;
      if (SHOW_LINES) {
        const ex = lay.ends[i][0], ey = lay.ends[i][1];
        const g = document.createElementNS(svg.namespaceURI, 'g');
        const d = 'M' + c[0].toFixed(1) + ' ' + c[1].toFixed(1) + 'L' + ex.toFixed(1) + ' ' + ey.toFixed(1);
        g.innerHTML = '<path class="halo" d="' + d + '"/><path class="core" d="' + d + '"/><circle class="dot" r="2.6" cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1) + '"/>';
        svg.appendChild(g); it.g = g;
      }
    });
    mapEl.classList.toggle('no-lines', !SHOW_LINES);
    statusEl.textContent = DEBUG
      ? 'масштаб ' + s.toFixed(2) + ' · ряды ' + lay.structure.rt + '/' + lay.structure.rb + ' · линии ' + (SHOW_LINES ? 'вкл, пересечений ' + lay.crossings + ', через подписи ' + lay.lineThroughLabel : 'выкл')
      : '';
    applyView();
    if (sel >= 0) applySelection();
  }

  function applySelection() {
    mapEl.classList.toggle('has-sel', sel >= 0);
    items.forEach((it, i) => { it.el.classList.toggle('sel', i === sel); if (it.g) it.g.classList.toggle('sel', i === sel); });
    svg.querySelectorAll('.ring').forEach(n => n.remove());
    if (sel < 0) return;
    const it = items[sel], s = lay.s;
    hlImg.src = base + it.sprite;
    Object.assign(hlImg.style, { left: it.bbox[0] * s + 'px', top: it.bbox[1] * s + 'px', width: it.bbox[2] * s + 'px', height: it.bbox[3] * s + 'px' });
    const cx = lay.sceneX + it.anchor[0] * s, cy = lay.sceneY + it.anchor[1] * s;
    const r = Math.max(it.bbox[2], it.bbox[3]) * s / 2 + 9;
    const ring = document.createElementNS(svg.namespaceURI, 'circle');
    ring.setAttribute('class', 'ring'); ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', r);
    svg.appendChild(ring);
    if (it.g) it.g.parentNode.appendChild(it.g);   // bring the selected leader on top
  }
  function select(i) { sel = i; applySelection(); }

  // ---------------------------------------------------------------- zoom / pan
  function clampView() {
    const W = mapEl.clientWidth, H = mapEl.clientHeight;
    if (z <= 1.001) { z = 1; tx = 0; ty = 0; return; }
    tx = Math.min(0, Math.max(W - W * z, tx));
    ty = Math.min(0, Math.max(H - contentH * z, ty));
  }
  function applyView() {
    clampView();
    worldEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
    resetBtn.hidden = z <= 1.001;
  }
  function zoomAt(cx, cy, nz) {  // cx, cy in map-element coordinates
    nz = Math.min(MAX_ZOOM, Math.max(1, nz));
    const wx = (cx - tx) / z, wy = (cy - ty) / z;
    z = nz; tx = cx - wx * z; ty = cy - wy * z;
    applyView();
  }

  function onSceneTap(e) {
    const r = sceneEl.getBoundingClientRect(), k = r.width / room.size[0];   // screen px per scene px
    const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
    const tol = Math.max(1.5, (e.pointerType === 'touch' ? 8 : 3) / k);
    let hit = -1, ha = 1e18;
    items.forEach((it, i) => {
      if (x < it.bbox[0] - tol || x > it.bbox[0] + it.bbox[2] + tol || y < it.bbox[1] - tol || y > it.bbox[1] + it.bbox[3] + tol) return;
      if (maskNear(it, x, y, tol) && it.area < ha) { hit = i; ha = it.area; }
    });
    select(hit >= 0 && hit !== sel ? hit : -1);
  }

  function initGestures() {
    const ptrs = new Map();
    let moved = false, pinch = null, startTarget = null;
    const rectLeft = () => mapEl.getBoundingClientRect();
    mapEl.addEventListener('pointerdown', e => {
      if (e.target === resetBtn) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, max: 0 });
      if (ptrs.size === 1) { moved = false; startTarget = e.target; }
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], r = rectLeft();
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: z, wx: ((a.x + b.x) / 2 - r.left - tx) / z, wy: ((a.y + b.y) / 2 - r.top - ty) / z };
        moved = true;
      }
    });
    mapEl.addEventListener('pointermove', e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      p.max = Math.max(p.max, Math.hypot(e.clientX - p.sx, e.clientY - p.sy));
      if (ptrs.size >= 2 && pinch) {
        const [a, b] = [...ptrs.values()], r = rectLeft();
        const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        z = Math.min(MAX_ZOOM, Math.max(1, pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
        tx = cx - pinch.wx * z; ty = cy - pinch.wy * z;
        applyView();
      } else if (ptrs.size === 1) {
        if (!moved && z > 1.001 && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) { moved = true; try { mapEl.setPointerCapture(e.pointerId); } catch (_) {} }
        if (moved) { tx += dx; ty += dy; applyView(); }
      }
    });
    const end = e => {
      const rec = ptrs.get(e.pointerId);
      if (!rec) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0) {
        const wasTap = !moved && e.type === 'pointerup' && rec.max <= 10;   // a drag (even without zoom) is not a tap
        if (moved || rec.max > 10) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 60); }
        if (wasTap && startTarget) {
          if (sceneEl.contains(startTarget)) onSceneTap(e);
          else if (startTarget === mapEl || startTarget === worldEl || startTarget === svg) select(-1);
        }
        moved = false; startTarget = null;
      }
    };
    mapEl.addEventListener('pointerup', end);
    mapEl.addEventListener('pointercancel', end);
    mapEl.addEventListener('wheel', e => {
      e.preventDefault();
      const r = rectLeft();
      zoomAt(e.clientX - r.left, e.clientY - r.top, z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    mapEl.addEventListener('dblclick', e => {   // double click: zoom in / back out
      const r = rectLeft();
      if (z > 1.001) { z = 1; tx = ty = 0; applyView(); } else zoomAt(e.clientX - r.left, e.clientY - r.top, 2.5);
    });
  }

  // ---------------------------------------------------------------- init
  async function init() {
    try {
      const idx = await get('rooms/index.json');
      const sel0 = $('#roomSel');
      // newest room first; it opens by default (?room=<id> picks another one)
      idx.sort((a, b) => (b.added || '').localeCompare(a.added || ''));
      const want = params.get('room');
      const id = want && idx.some(r => r.id === want) ? want : idx[0].id;
      if (idx.length > 1) {
        sel0.hidden = false;
        idx.forEach(r => sel0.add(new Option(r.title, r.id)));
        sel0.value = id;
        sel0.onchange = () => { location.search = '?room=' + sel0.value; };   // reload keeps #sim
      }
      base = 'rooms/' + id + '/';
      room = await get(base + 'room.json');
      $('#roomTitle').textContent = idx.length > 1 ? '' : room.title;
      document.title = room.title + ' — карта';
      items = room.items.slice();
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await loadMasks();
      tierName = mapEl.clientWidth < 520 ? 'small' : 'large'; T = TIERS[tierName];
      items.forEach(it => { it.wrap = wrapLabel(it.name); });
      build(); doLayout();
      let t = 0;
      new ResizeObserver(() => { clearTimeout(t); t = setTimeout(doLayout, 60); }).observe(mapEl);
      window.FinderRoom = { room, items, base, maskNear };
      document.dispatchEvent(new CustomEvent('finder:ready'));
      window.__finder = { items, get lay() { return lay; }, select, get sel() { return sel; }, get view() { return { z, tx, ty }; } };
    } catch (e) {
      statusEl.textContent = 'Ошибка загрузки: ' + e.message;
      console.error(e);
    }
  }
  init();
})();
