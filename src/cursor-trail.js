/* ══════════════════════════════════════════════════════════════════════
   HIGH-PERFORMANCE ZERO-CPU BLUE CARET (ZERO LAYOUT THRASHING)
   ══════════════════════════════════════════════════════════════════════ */
(function initCursorTrail() {
  if (typeof window === 'undefined') return;

  let canvas = document.getElementById('cursor-trail-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'cursor-trail-canvas';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;transform:translate3d(0,0,0);';
    document.body.appendChild(canvas);
  }

  const ctx = canvas.getContext('2d', { alpha: true });
  let dpr = window.devicePixelRatio || 1;

  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas, { passive: true });

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');

  let activeEl = null;
  let targetX = 0;
  let targetY = 0;
  let targetH = 22;
  let currX = 0;
  let currY = 0;
  let currH = 22;
  let prevTargetX = 0;
  let prevTargetY = 0;
  
  let opacity = 0;
  let targetOpacity = 0;
  let lastTypingTime = 0;
  let focusTime = 0;
  let isTyping = false;
  let history = [];
  let isRunning = false;
  let rafId = null;

  // Cached styles to eliminate layout thrashing
  let cachedStyle = {
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    borderLeft: 0,
    borderTop: 0,
    fontSize: 14.5,
    font: '14.5px Inter, sans-serif',
    letterSpacing: 'normal'
  };
  let cachedTextWidth = 0;
  let cachedRect = null;
  const cursorColor = '#0A84FF';

  function cacheElementStyles(el) {
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 14.5;
    cachedStyle = {
      paddingLeft: parseFloat(cs.paddingLeft) || 0,
      paddingRight: parseFloat(cs.paddingRight) || 0,
      paddingTop: parseFloat(cs.paddingTop) || 0,
      borderLeft: parseFloat(cs.borderLeftWidth) || 0,
      borderTop: parseFloat(cs.borderTopWidth) || 0,
      fontSize: fontSize,
      font: `${cs.fontWeight || '400'} ${fontSize}px ${cs.fontFamily || 'Inter, sans-serif'}`,
      letterSpacing: cs.letterSpacing || 'normal'
    };
    measureCtx.font = cachedStyle.font;
    measureCtx.letterSpacing = cachedStyle.letterSpacing;
  }

  function updateTextMeasurement(el) {
    if (!el) return;
    const val = el.value || '';
    let selStart = typeof el.selectionStart === 'number' ? el.selectionStart : val.length;
    let textBefore = val.substring(0, selStart);
    if (el.type === 'password') textBefore = '•'.repeat(selStart);
    cachedTextWidth = measureCtx.measureText(textBefore).width;
  }

  function computeCoordinates(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const caretHeight = Math.min(rect.height, Math.max(20, cachedStyle.fontSize * 1.42));
    let x = rect.left + cachedStyle.borderLeft + cachedStyle.paddingLeft + cachedTextWidth - (el.scrollLeft || 0);
    let y = rect.top + cachedStyle.borderTop + (rect.height - cachedStyle.borderTop * 2 - caretHeight) / 2;

    const minX = rect.left + cachedStyle.borderLeft + cachedStyle.paddingLeft;
    const maxX = rect.right - cachedStyle.paddingRight;
    x = Math.max(minX, Math.min(maxX, x));

    return { x, y, h: caretHeight };
  }

  function updateTargetPosition(instant = false) {
    if (!activeEl) return;
    updateTextMeasurement(activeEl);
    const coords = computeCoordinates(activeEl);
    if (!coords) return;

    const now = performance.now();
    const dist = Math.hypot(coords.x - prevTargetX, coords.y - prevTargetY);
    if (dist > 0.4) {
      lastTypingTime = now;
      isTyping = true;
    }

    prevTargetX = targetX;
    prevTargetY = targetY;
    targetX = coords.x;
    targetY = coords.y;
    targetH = coords.h;

    if (instant) {
      currX = targetX;
      currY = targetY;
      currH = targetH;
      prevTargetX = targetX;
      prevTargetY = targetY;
    }
  }

  function startRenderLoop() {
    if (isRunning) return;
    isRunning = true;
    rafId = requestAnimationFrame(render);
  }

  function isTrackableInput(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'password', 'url', 'email', 'number'].includes(type);
    }
    return false;
  }

  document.addEventListener('focusin', (e) => {
    if (isTrackableInput(e.target)) {
      activeEl = e.target;
      activeEl.style.setProperty('caret-color', 'transparent', 'important');
      targetOpacity = 1;
      history = [];
      const now = performance.now();
      lastTypingTime = now;
      focusTime = now;
      cacheElementStyles(activeEl);
      updateTargetPosition(true);
      startRenderLoop();
    }
  }, { passive: true });

  document.addEventListener('focusout', (e) => {
    if (e.target === activeEl) {
      targetOpacity = 0;
      activeEl = null;
    }
  }, { passive: true });

  ['input', 'keydown', 'keyup', 'click', 'select', 'mouseup'].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (activeEl) {
        updateTargetPosition(false);
        startRenderLoop();
      }
    }, { passive: true });
  });

  function render(now) {
    // Opacity interpolation
    opacity += (targetOpacity - opacity) * 0.28;

    // SLEEP CHECK: If completely idle and faded out, stop the loop (0% CPU)
    if (opacity < 0.005 && history.length === 0 && !activeEl) {
      opacity = 0;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      isRunning = false;
      return;
    }

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    if (activeEl) {
      // Only sample getBoundingClientRect during the first 350ms of focus transition or when typing
      const timeSinceFocus = now - focusTime;
      if (timeSinceFocus < 350 || isTyping) {
        const coords = computeCoordinates(activeEl);
        if (coords) {
          targetX = coords.x;
          targetY = coords.y;
          targetH = coords.h;
        }
      }

      // Smooth spring lerp
      const dx = targetX - currX;
      const dy = targetY - currY;
      const dist = Math.hypot(dx, dy);

      const lerpFactor = 0.48;
      currX += dx * lerpFactor;
      currY += dy * lerpFactor;
      currH += (targetH - currH) * lerpFactor;

      if (dist > 0.4) {
        history.push({
          x: currX,
          y: currY,
          h: currH,
          time: now
        });
      }
    }

    if (now - lastTypingTime > 180) {
      isTyping = false;
    }

    // 1. Fluid Motion Trail
    const maxTrailLifetime = 200; // ms
    history = history.filter(item => (now - item.time) < maxTrailLifetime);

    if (history.length > 1) {
      ctx.save();
      for (let i = 0; i < history.length - 1; i++) {
        const p1 = history[i];
        const p2 = history[i + 1];
        const age = now - p1.time;
        const lifeRatio = 1 - (age / maxTrailLifetime);
        const trailAlpha = lifeRatio * 0.42 * opacity;

        if (trailAlpha > 0.01) {
          ctx.strokeStyle = cursorColor;
          ctx.globalAlpha = trailAlpha;
          ctx.lineWidth = 2.2;
          ctx.lineCap = 'round';

          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y + p1.h / 2);
          ctx.lineTo(p2.x, p2.y + p2.h / 2);
          ctx.stroke();
        }
      }

      for (let i = 0; i < history.length; i += 2) {
        const item = history[i];
        const age = now - item.time;
        const lifeRatio = 1 - (age / maxTrailLifetime);
        const ghostAlpha = lifeRatio * 0.3 * opacity;

        if (ghostAlpha > 0.02) {
          ctx.fillStyle = cursorColor;
          ctx.globalAlpha = ghostAlpha;
          const barW = 1.8;
          ctx.fillRect(item.x - barW / 2, item.y, barW, item.h);
        }
      }
      ctx.restore();
    }

    // 2. Clean Crisp Normal Blue Caret |
    if (activeEl && opacity > 0.02) {
      ctx.save();

      let cursorAlpha = opacity;
      if (!isTyping && (now - lastTypingTime) > 380) {
        const blinkCycle = ((now - lastTypingTime - 380) % 1060) / 1060;
        cursorAlpha = blinkCycle < 0.5 ? opacity : 0;
      }

      ctx.globalAlpha = cursorAlpha;
      ctx.fillStyle = cursorColor;

      const cursorWidth = 2.0;
      ctx.fillRect(Math.round(currX) - 1, Math.round(currY), cursorWidth, Math.round(currH));
      ctx.restore();
    }

    rafId = requestAnimationFrame(render);
  }
})();
