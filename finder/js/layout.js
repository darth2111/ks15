/* Ring layout: scene in the middle, labels around it, leader lines without crossings (best effort).
   Pure functions, no DOM. Exposed as window.FinderLayout. */
(function () {
  'use strict';

  // Min-cost assignment (rows <= cols), O(n^2 m). Returns assign[row] = col.
  function hungarian(cost) {
    const n = cost.length, m = cost[0].length;
    const INF = 1e18;
    const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Float64Array(m + 1).fill(INF);
      const used = new Uint8Array(m + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0];
        let delta = INF, j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (!used[j]) {
            const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
            if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
            if (minv[j] < delta) { delta = minv[j]; j1 = j; }
          }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const assign = new Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) assign[p[j] - 1] = j - 1;
    return assign;
  }

  function segCross(a, b) {
    // proper intersection of segments a=[x1,y1,x2,y2], b likewise
    const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const A = [a[0], a[1]], B = [a[2], a[3]], C = [b[0], b[1]], D = [b[2], b[3]];
    const d1 = d(A, B, C), d2 = d(A, B, D), d3 = d(C, D, A), d4 = d(C, D, B);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
  }

  function countCrossings(segs) {
    let c = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segCross(segs[i], segs[j])) c++;
    return c;
  }

  function quantile(arr, q) {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }


  function segRect(sg, r) { // does segment sg=[x1,y1,x2,y2] cross/enter rect r=[x0,y0,x1,y1] (shrunk by 1px)?
    const x0 = r[0] + 1, y0 = r[1] + 1, x1 = r[2] - 1, y1 = r[3] - 1;
    if (x1 <= x0 || y1 <= y0) return false;
    const inside = (x, y) => x > x0 && x < x1 && y > y0 && y < y1;
    if (inside(sg[0], sg[1]) || inside(sg[2], sg[3])) return true;
    let t0 = 0, t1 = 1; const dx = sg[2] - sg[0], dy = sg[3] - sg[1];
    const p = [-dx, dx, -dy, dy], q = [sg[0] - x0, x1 - sg[0], sg[1] - y0, y1 - sg[1]];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; }
      else { const t = q[i] / p[i]; if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
    }
    return t1 - t0 > 1e-6 && t0 < 1 && t1 > 0;
  }

  // Simulated annealing over the item->slot assignment (M >= N slots, spare ones stay empty).
  // Energy = crossings + lines through foreign labels + total line length.
  function annealOnce(N, M, assign0, ep, rectOf, okPair, iters, seed0, energyOut) {
    const W1 = 1000, W2 = 500;
    const a = assign0.slice();
    const occ = new Int32Array(M).fill(-1);
    for (let i = 0; i < N; i++) occ[a[i]] = i;
    const seg = i => ep[i][a[i]].seg, rect = i => rectOf(i, a[i]);
    const pairE = (i, j) => {
      const si = seg(i), sj = seg(j);
      let e = 0;
      if (segCross(si, sj)) e += W1;
      if (segRect(si, rect(j))) e += W2;
      if (segRect(sj, rect(i))) e += W2;
      return e;
    };
    const localE = (i, j) => {            // energy terms touching item i (and j if j >= 0)
      let e = ep[i][a[i]].len;
      if (j >= 0) e += ep[j][a[j]].len;
      for (let m = 0; m < N; m++) {
        if (m !== i) e += pairE(i, m);
        if (j >= 0 && m !== j && m !== i) e += pairE(j, m);
      }
      return e;
    };
    const total = () => {
      let e = 0;
      for (let i = 0; i < N; i++) { e += ep[i][a[i]].len; for (let j = i + 1; j < N; j++) e += pairE(i, j); }
      return e;
    };
    let E = total(), bestE = E, best = a.slice();
    let seed = seed0; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const T0 = 400, T1 = 2;
    for (let it = 0; it < iters; it++) {
      const T = T0 * Math.pow(T1 / T0, it / iters);
      const i = Math.floor(rnd() * N), k = Math.floor(rnd() * M), ki = a[i];
      if (k === ki || !okPair(i, k)) continue;
      const j = occ[k];
      if (j >= 0 && !okPair(j, ki)) continue;
      const before = localE(i, j);
      a[i] = k; occ[k] = i; if (j >= 0) { a[j] = ki; occ[ki] = j; } else occ[ki] = -1;
      const d = localE(i, j) - before;
      if (d <= 0 || rnd() < Math.exp(-d / T)) { E += d; if (E < bestE - 1e-9) { bestE = E; best = a.slice(); } }
      else { a[i] = ki; occ[ki] = i; if (j >= 0) { a[j] = k; occ[k] = j; } else occ[k] = -1; }
    }
    energyOut.e = bestE;
    return best;
  }


  // several annealing runs from the min-length matching, then keep the lowest-energy result
  function refineAssignment(N, M, assign0, ep, rectOf, okPair, iters) {
    let best = assign0, bestE = 1e18;
    const runs = 3;
    for (let r = 0; r < runs; r++) {
      const out = { e: 0 };
      const a = annealOnce(N, M, assign0, ep, rectOf, okPair, Math.floor(iters / runs), 12345 + 7919 * r, out);
      if (out.e < bestE) { bestE = out.e; best = a; }
    }
    return best;
  }

  /* opts: W,H (container), room:[sw,sh], widths:[label box widths], lh, anchors:[[x,y] in scene px],
     P: {pad,gap,vgap,hgap,maxS}.
     Narrow labels go to the side columns, wide ones to the rows above/below the scene. */
  function chooseStructure(opts, ignoreHeight) {
    const { W, H, room: [sw, sh], widths, lh, P } = opts;
    const N = widths.length;
    const sorted = widths.slice().sort((a, b) => a - b);
    const cands = Array.from(new Set([0, 0.2, 0.35, 0.5, 0.65, 0.8, 1].map(q => q === 0 ? 0 : quantile(sorted, Math.min(q, 0.999)))));
    let best = null;
    for (const c of cands) {
      for (let R = 0; R <= 9; R++) {
        for (let rt = 0; rt <= R; rt++) {
          const rb = R - rt;
          if (Math.abs(rt - rb) > 1) continue;
          const bandH = R * (lh + P.vgap) + (rt ? P.gap : 0) + (rb ? P.gap : 0);
          const availH = ignoreHeight ? 1e9 : H - 2 * P.pad - bandH;
          const availW = W - 2 * P.pad - (c ? 2 * (c + P.gap) : 0);
          const s = Math.min(availW / sw, availH / sh, P.maxS);
          if (!(s > 0.12)) continue;
          const sideCap = c ? Math.floor((sh * s + P.vgap) / (lh + P.vgap)) : 0;
          const narrow = c ? widths.filter(w => w <= c).length : 0;
          const wideW = widths.filter(w => w > c);
          const sideUse = Math.min(2 * sideCap, narrow);
          const rowLabels = N - sideUse;
          const wmaxRow = wideW.length ? Math.max.apply(null, wideW) : (rowLabels ? c : 0);
          const rowK = rowLabels ? Math.floor((W - 2 * P.pad + P.hgap) / (wmaxRow + P.hgap)) : 1;
          if (rowLabels && rowK < 1) continue;
          const need = rowLabels ? Math.ceil(rowLabels / rowK) : 0;
          if (R < need) continue;
          const score = s - 0.003 * R;
          if (!best || score > best.score) best = { c, rt, rb, s, sideCap, sideUse, rowLabels, rowK, wmaxRow, score };
        }
      }
    }
    return best;
  }

  function distribute(n, k) { // n items over k bins as evenly as possible (earlier bins first)
    const out = new Array(k).fill(Math.floor(n / k));
    for (let i = 0; i < n - out.reduce((a, b) => a + b, 0); i++) out[i]++;
    return out;
  }

  function layout(opts) {
    const { W, H, room: [sw, sh], widths, lh, anchors, P } = opts;
    const N = widths.length;
    let st = chooseStructure(opts, false), overflowH = false;
    if (!st) { st = chooseStructure(opts, true); overflowH = true; }   // page will scroll
    const s = st.s;
    const sceneW = sw * s, sceneH = sh * s;
    const bandTop = st.rt * (lh + P.vgap) + (st.rt ? P.gap : 0);
    const bandBot = st.rb * (lh + P.vgap) + (st.rb ? P.gap : 0);
    const usedH = bandTop + sceneH + bandBot;
    const sceneX = (W - sceneW) / 2;
    const sceneY = Math.max(P.pad, (H - usedH) / 2) + bandTop;
    const slots = [];
    const nSide = st.c ? st.sideCap : 0;
    for (let j = 0; j < nSide; j++) slots.push({ side: 'L', cx: sceneX - P.gap, cy: sceneY + (j + 0.5) * sceneH / nSide, maxW: st.c });
    for (let j = 0; j < nSide; j++) slots.push({ side: 'R', cx: sceneX + sceneW + P.gap, cy: sceneY + (j + 0.5) * sceneH / nSide, maxW: st.c });
    const R = st.rt + st.rb;
    if (R) {
      const k = Math.max(1, st.rowK);
      const pitch = (W - 2 * P.pad) / k;
      for (let r = 0; r < R; r++) {
        const top = r < st.rt, idx = top ? r : r - st.rt;
        const y = top ? sceneY - P.gap - idx * (lh + P.vgap) - lh / 2
                      : sceneY + sceneH + P.gap + idx * (lh + P.vgap) + lh / 2;
        for (let j = 0; j < k; j++) slots.push({ side: top ? 'T' : 'B', cx: P.pad + (j + 0.5) * pitch, cy: y, maxW: pitch - P.hgap });
      }
    }
    const M = slots.length;
    const scr = anchors.map(a => [sceneX + a[0] * s, sceneY + a[1] * s]);
    const conn = slots.map(sl => sl.side === 'T' ? [sl.cx, sl.cy + lh / 2] : sl.side === 'B' ? [sl.cx, sl.cy - lh / 2] : [sl.cx, sl.cy]);
    const okPair = (i, k) => widths[i] <= slots[k].maxW + 0.5;
    const rectOf = (i, k) => {
      const sl = slots[k], w = widths[i];
      let x0 = sl.side === 'L' ? sl.cx - w : sl.side === 'R' ? sl.cx : sl.cx - w / 2;
      x0 = Math.max(2, Math.min(W - w - 2, x0));
      return [x0, sl.cy - lh / 2, x0 + w, sl.cy + lh / 2];
    };
    const RT = widths.map((_, i) => slots.map((_, k) => rectOf(i, k)));   // precomputed label rectangles
    const rectAt = (i, k) => RT[i][k];
    // nearest point of each item's outline (sampled) to each slot connection point
    const pts = opts.maskPts || anchors.map(a => [a]);
    const ep = pts.map((pp, i) => conn.map((c, k) => {
      let bx = 0, by = 0, bd = 1e18;
      for (const p of pp) {
        const X = sceneX + p[0] * s, Y = sceneY + p[1] * s, d = (X - c[0]) * (X - c[0]) + (Y - c[1]) * (Y - c[1]);
        if (d < bd) { bd = d; bx = X; by = Y; }
      }
      return { seg: [c[0], c[1], bx, by], len: Math.sqrt(bd), end: [bx, by] };
    }));
    const BIG = 1e7;
    const cost = ep.map((row, i) => row.map((e, k) => okPair(i, k) ? e.len : BIG));
    let assign = hungarian(cost);
    const iters = opts.iters != null ? opts.iters : 90000;
    if (iters > 0) assign = refineAssignment(N, M, assign, ep, rectAt, okPair, iters);
    const segs = scr.map((_, i) => ep[i][assign[i]].seg);
    const crossings = countCrossings(segs);
    let lineThroughLabel = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j && segRect(segs[i], rectAt(j, assign[j]))) lineThroughLabel++;
    const ends = scr.map((_, i) => ep[i][assign[i]].end);
    return { s, sceneX, sceneY, sceneW, sceneH, slots, conn, scr, assign, ends, crossings, lineThroughLabel, structure: st,
             totalH: overflowH ? usedH + 2 * P.pad : H };
  }

  window.FinderLayout = { layout, hungarian, segCross, countCrossings };
})();
