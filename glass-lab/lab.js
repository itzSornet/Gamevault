(() => {
  const body = document.body;
  const initial = new URLSearchParams(location.search).get('variant');
  if (initial) {
    body.dataset.glass = initial;
    for (const b of document.querySelectorAll('[data-variant]')) b.classList.toggle('on', b.dataset.variant === initial);
  }

  // --- variants -----------------------------------------------------------
  for (const btn of document.querySelectorAll('[data-variant]')) {
    btn.onclick = () => {
      body.dataset.glass = btn.dataset.variant;
      for (const b of document.querySelectorAll('[data-variant]')) b.classList.toggle('on', b === btn);
    };
  }

  // --- fps hud ------------------------------------------------------------
  const fpsEl = document.getElementById('fps');
  const msEl = document.getElementById('ms');
  let frames = 0, t0 = performance.now(), last = t0;
  const beat = (now) => {
    frames += 1;
    if (now - t0 >= 500) {
      const fps = Math.round((frames * 1000) / (now - t0));
      fpsEl.textContent = fps;
      msEl.textContent = (1000 / Math.max(1, fps)).toFixed(1);
      frames = 0; t0 = now;
    }
    last = now;
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);

  // --- stress -------------------------------------------------------------
  const grid = document.getElementById('grid');
  let stressed = false;
  document.getElementById('stress').onclick = (e) => {
    stressed = !stressed;
    e.currentTarget.textContent = stressed ? 'Clear stress' : 'Stress ×300';
    if (stressed) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 300; i++) {
        const d = document.createElement('div');
        d.className = 'tile';
        d.innerHTML = `<img src="assets/cover${(i % 4) + 1}.jpg" alt=""><span>Game ${i + 1}</span><small>${(i * 1.7).toFixed(1)} h</small>`;
        frag.appendChild(d);
      }
      grid.appendChild(frag);
    } else {
      [...grid.querySelectorAll('.tile')].slice(4).forEach((n) => n.remove());
    }
  };

  // --- lens: real refraction via SVG displacement map ----------------------
  const sample = document.getElementById('lensSample');
  const defs = document.getElementById('lensDefs');
  const supported = CSS.supports('backdrop-filter', 'url(#lensF)') || CSS.supports('-webkit-backdrop-filter', 'url(#lensF)');
  if (!supported) {
    sample.style.display = 'none';
    return;
  }

  const W = 340, H = 190, R = 20;
  function sdf(x, y) {
    const qx = Math.abs(x - W / 2) - (W / 2 - R);
    const qy = Math.abs(y - H / 2) - (H / 2 - R);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - R;
  }
  function makeMap() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const s = sdf(x, y);
        // only the bezel refracts: strongest at the edge, decays inward
        const edge = Math.exp(-Math.max(s, 0) / 9) * (s < 0 ? 1 : 0.15);
        if (edge < 0.01) { d[i] = 128; d[i + 1] = 128; d[i + 2] = 128; d[i + 3] = 255; continue; }
        const gx = sdf(x + 1, y) - sdf(x - 1, y);
        const gy = sdf(x, y + 1) - sdf(x, y - 1);
        const len = Math.hypot(gx, gy) || 1;
        const nx = gx / len, ny = gy / len;
        d[i] = Math.round(128 + nx * edge * 127);
        d[i + 1] = Math.round(128 + ny * edge * 127);
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  const url = makeMap();
  defs.innerHTML = `
    <filter id="lensF" x="0" y="0" width="${W}" height="${H}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feImage href="${url}" x="0" y="0" width="${W}" height="${H}" result="map" />
      <feDisplacementMap in="SourceGraphic" in2="map" scale="34" xChannelSelector="R" yChannelSelector="G" />
    </filter>`;
  sample.style.backdropFilter = 'url(#lensF)';
})();
