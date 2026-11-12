/* GameVault sound effects. Every sound is synthesized with the Web Audio
 * API at play time: no audio files to ship or license, nothing to load.
 *
 * Two original styles, picked in Settings → General → Sound:
 *   crisp — the default: short and tactile, like a good physical button
 *           (a click transient on top of a tight pitched blip, almost dry)
 *   airy  — soft, rounded, glassy tones in a little room (gentle attacks,
 *           bell-like partials, a roomy tail)
 *
 * Sfx.play(name, priority?, { pan, pitch }?) — sounds asked for within the
 * same ~20 ms (a click that opens a dialog, a pad press that switches a tab)
 * collapse into one: the highest priority wins, so nothing doubles up.
 * pan (-1…1) and pitch (semitones) place a sound where it happened on
 * screen: things to the left sound a touch left, higher up a touch higher.
 *
 * In the renderer this lands on window.Sfx; in Node it exports the sound
 * list for tests (there's no AudioContext there, play() is a no-op).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Sfx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // default priority per sound: higher wins when two land together
  const PRIORITY = {
    move: 1, click: 1, bump: 1,
    select: 2, back: 2,
    tab: 3, toggleOn: 3, toggleOff: 3,
    open: 4, close: 4, notify: 4, success: 4,
    error: 5, launch: 6,
  };
  // how much of each sound goes into the room
  const WET = { airy: 0.34, crisp: 0.09 };

  let ctx = null;
  let master = null;
  let send = null;
  let noiseBuf = null;
  let enabled = true;
  let volume = 0.6;
  let theme = 'crisp';
  let nav = true;
  let pending = null;           // { name, prio, opts, timer }
  const lastAt = Object.create(null);
  // the voice being built: where its nodes connect, and its pitch factor
  let out = null;
  let pm = 1;

  const level = (v) => Math.pow(Math.max(0, Math.min(1, v)), 1.5) * 0.9;

  // a small, dark room: decaying noise, smoothed so the tail isn't hissy
  function makeRoom(c, seconds, curve) {
    const len = Math.floor(c.sampleRate * seconds);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.32;
        d[i] = lp * Math.pow(1 - i / len, curve);
      }
    }
    return ir;
  }

  function ensure() {
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC({ latencyHint: 'interactive' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      master = ctx.createGain();
      master.gain.value = level(volume);
      master.connect(comp);
      comp.connect(ctx.destination);
      // room: voices -> send -> pre-delay -> convolver -> master
      send = ctx.createGain();
      send.gain.value = WET[theme];
      const pre = ctx.createDelay(0.1);
      pre.delayTime.value = 0.018;
      const room = ctx.createConvolver();
      room.buffer = makeRoom(ctx, 1.3, 3.4);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5200;
      send.connect(pre);
      pre.connect(room);
      room.connect(tone);
      tone.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function env(g, t0, gain, attack, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  function tone(t0, { type = 'sine', f, f2, dur, gain = 0.1, attack = 0.004 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f * pm, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2 * pm, t0 + dur);
    const g = ctx.createGain();
    env(g, t0, gain, attack, dur);
    o.connect(g);
    g.connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  function noise(t0, { dur, gain = 0.05, f = 1200, f2, q = 1, type = 'bandpass', attack = 0.005 }) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f, t0);
    if (f2) filter.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    const g = ctx.createGain();
    env(g, t0, gain, attack, dur);
    s.connect(filter);
    filter.connect(g);
    g.connect(out);
    s.start(t0);
    s.stop(t0 + dur + 0.03);
  }

  // glass: a sine with two quiet, faster-fading inharmonic partials
  function bell(t, f, { dur = 0.5, gain = 0.08, attack = 0.004 } = {}) {
    tone(t, { f, dur, gain, attack });
    tone(t, { f: f * 2.76, dur: dur * 0.35, gain: gain * 0.2, attack: attack * 0.5 });
    tone(t, { f: f * 5.4, dur: dur * 0.15, gain: gain * 0.06, attack: 0.001 });
  }
  // a dry, very short click transient
  function tick(t, f, gain = 0.03) {
    noise(t, { dur: 0.012, gain, f, q: 2.5, attack: 0.0008 });
  }

  const jitter = () => 1 + (Math.random() - 0.5) * 0.04;

  const THEMES = {
    airy: {
      // a soft round "tok", mid-low, no sharp edge
      move(t) {
        const j = jitter();
        tone(t, { f: 740 * j, f2: 700 * j, dur: 0.07, gain: 0.06, attack: 0.004 });
        tone(t, { f: 1480 * j, dur: 0.03, gain: 0.009, attack: 0.002 });
      },
      bump(t) { tone(t, { f: 165, f2: 120, dur: 0.13, gain: 0.11, attack: 0.006 }); },
      click(t) {
        const j = jitter();
        tone(t, { f: 990 * j, f2: 900 * j, dur: 0.05, gain: 0.045, attack: 0.003 });
      },
      select(t) {
        bell(t, 880, { dur: 0.32, gain: 0.07 });
        bell(t + 0.06, 1318.5, { dur: 0.5, gain: 0.065 });
      },
      back(t) {
        tone(t, { f: 784, f2: 740, dur: 0.09, gain: 0.065, attack: 0.005 });
        tone(t + 0.065, { f: 587, f2: 560, dur: 0.2, gain: 0.06, attack: 0.006 });
      },
      // a page or dialog breathes in
      open(t) {
        noise(t, { dur: 0.32, gain: 0.028, f: 500, f2: 3800, q: 0.7, attack: 0.09 });
        tone(t, { f: 440, f2: 660, dur: 0.3, gain: 0.04, attack: 0.06 });
        tone(t + 0.03, { f: 660, f2: 990, dur: 0.3, gain: 0.028, attack: 0.06 });
      },
      close(t) {
        noise(t, { dur: 0.26, gain: 0.026, f: 3200, f2: 450, q: 0.7, attack: 0.04 });
        tone(t, { f: 740, f2: 440, dur: 0.24, gain: 0.042, attack: 0.03 });
      },
      tab(t) {
        const j = jitter();
        tone(t, { f: 1046.5 * j, dur: 0.06, gain: 0.048, attack: 0.004 });
        tone(t + 0.05, { f: 1396.9 * j, dur: 0.09, gain: 0.042, attack: 0.004 });
      },
      toggleOn(t) {
        tone(t, { f: 660, f2: 990, dur: 0.12, gain: 0.065, attack: 0.006 });
        tone(t + 0.01, { f: 1980, dur: 0.05, gain: 0.01 });
      },
      toggleOff(t) { tone(t, { f: 880, f2: 560, dur: 0.12, gain: 0.06, attack: 0.006 }); },
      // three glass notes rising
      notify(t) {
        bell(t, 1046.5, { dur: 0.6, gain: 0.05 });
        bell(t + 0.09, 1568, { dur: 0.7, gain: 0.045 });
        bell(t + 0.18, 2093, { dur: 0.8, gain: 0.03 });
      },
      success(t) {
        bell(t, 784, { dur: 0.4, gain: 0.06 });
        bell(t + 0.08, 1175, { dur: 0.6, gain: 0.055 });
      },
      error(t) {
        tone(t, { type: 'triangle', f: 330, f2: 315, dur: 0.14, gain: 0.09, attack: 0.006 });
        tone(t + 0.15, { type: 'triangle', f: 262, f2: 247, dur: 0.22, gain: 0.09, attack: 0.006 });
      },
      // a game starts: a warm chord swells up, a glass note on top
      launch(t) {
        [261.6, 392, 523.3, 659.3, 784].forEach((f, i) => tone(t + i * 0.05, { f, dur: 1.0 + i * 0.08, gain: 0.042, attack: 0.12 }));
        noise(t, { dur: 0.9, gain: 0.026, f: 250, f2: 6000, q: 0.6, attack: 0.4 });
        bell(t + 0.32, 1568, { dur: 1.0, gain: 0.04 });
      },
    },

    crisp: {
      // a tight click with a tiny pitched blip under it
      move(t) {
        const j = jitter();
        tick(t, 3800 * j, 0.026);
        tone(t, { type: 'triangle', f: 1250 * j, f2: 1150 * j, dur: 0.022, gain: 0.045, attack: 0.001 });
      },
      bump(t) {
        tone(t, { f: 140, f2: 90, dur: 0.07, gain: 0.12, attack: 0.002 });
        tick(t, 900, 0.028);
      },
      click(t) {
        tick(t, 4200, 0.028);
        tone(t, { type: 'triangle', f: 1500, dur: 0.016, gain: 0.034, attack: 0.001 });
      },
      // a low "thock" then a bright blip: pressed, accepted
      select(t) {
        tone(t, { f: 320, f2: 170, dur: 0.05, gain: 0.11, attack: 0.001 });
        tick(t, 3000, 0.032);
        tone(t + 0.035, { type: 'triangle', f: 1760, dur: 0.05, gain: 0.048, attack: 0.002 });
      },
      back(t) {
        tone(t, { type: 'triangle', f: 1320, dur: 0.03, gain: 0.048, attack: 0.001 });
        tone(t + 0.03, { f: 260, f2: 150, dur: 0.05, gain: 0.095, attack: 0.001 });
        tick(t + 0.03, 2200, 0.024);
      },
      // a short swish, then it lands
      open(t) {
        noise(t, { dur: 0.13, gain: 0.032, f: 700, f2: 5000, q: 1.2, attack: 0.03 });
        tone(t + 0.09, { type: 'triangle', f: 1568, dur: 0.05, gain: 0.04, attack: 0.002 });
      },
      close(t) {
        noise(t, { dur: 0.11, gain: 0.028, f: 4500, f2: 700, q: 1.2, attack: 0.01 });
        tone(t + 0.05, { f: 300, f2: 180, dur: 0.05, gain: 0.075, attack: 0.001 });
      },
      tab(t) {
        tick(t, 3600, 0.028);
        tone(t, { type: 'triangle', f: 1175, dur: 0.02, gain: 0.04, attack: 0.001 });
        tick(t + 0.045, 4200, 0.028);
        tone(t + 0.045, { type: 'triangle', f: 1568, dur: 0.025, gain: 0.04, attack: 0.001 });
      },
      toggleOn(t) {
        tick(t, 4000, 0.028);
        tone(t, { type: 'triangle', f: 880, f2: 1320, dur: 0.05, gain: 0.058, attack: 0.001 });
      },
      toggleOff(t) {
        tick(t, 3000, 0.028);
        tone(t, { type: 'triangle', f: 1100, f2: 660, dur: 0.05, gain: 0.052, attack: 0.001 });
      },
      notify(t) {
        tone(t, { f: 1318.5, dur: 0.12, gain: 0.058, attack: 0.002 });
        tone(t + 0.075, { f: 1975.5, dur: 0.2, gain: 0.052, attack: 0.002 });
      },
      success(t) {
        tone(t, { type: 'triangle', f: 988, dur: 0.06, gain: 0.065, attack: 0.001 });
        tone(t + 0.06, { type: 'triangle', f: 1480, dur: 0.12, gain: 0.065, attack: 0.001 });
      },
      error(t) {
        tone(t, { type: 'triangle', f: 196, dur: 0.07, gain: 0.11, attack: 0.001 });
        tone(t + 0.09, { type: 'triangle', f: 165, dur: 0.1, gain: 0.11, attack: 0.001 });
        tick(t, 1200, 0.03);
      },
      // a rising swish that snaps into a bright chord
      launch(t) {
        noise(t, { dur: 0.45, gain: 0.032, f: 400, f2: 7000, q: 0.9, attack: 0.3 });
        tone(t, { f: 220, f2: 440, dur: 0.42, gain: 0.045, attack: 0.3 });
        tone(t + 0.4, { f: 360, f2: 180, dur: 0.09, gain: 0.12, attack: 0.001 });
        tick(t + 0.4, 2600, 0.036);
        [523.3, 784, 1046.5].forEach((f) => tone(t + 0.4, { type: 'triangle', f, dur: 0.45, gain: 0.038, attack: 0.003 }));
      },
    },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function fire(name, opts) {
    // never over a game or another app
    if (root.document && typeof root.document.hasFocus === 'function' && !root.document.hasFocus()) return;
    const now = (root.performance && root.performance.now()) || Date.now();
    if (lastAt[name] && now - lastAt[name] < 30) return;
    lastAt[name] = now;
    if (!ensure()) return;
    try {
      // one small voice bus per sound: pan it, send it to the room
      out = ctx.createGain();
      let tail = out;
      const pan = opts && Number(opts.pan);
      if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        out.connect(p);
        tail = p;
      }
      tail.connect(master);
      tail.connect(send);
      pm = Math.pow(2, clamp(Number(opts && opts.pitch) || 0, -3, 3) / 12);
      THEMES[theme][name](ctx.currentTime + 0.004);
    } catch (_) { /* never let a sound break the UI */ }
  }

  function play(name, prio, opts) {
    if (!enabled || !THEMES[theme][name]) return;
    if (name === 'move' && !nav) return;
    const p = prio == null ? (PRIORITY[name] || 1) : prio;
    if (pending) {
      if (p <= pending.prio) return;
      clearTimeout(pending.timer);
    }
    pending = {
      name, prio: p, opts,
      timer: setTimeout(() => { const { name: n, opts: o } = pending; pending = null; fire(n, o); }, 18),
    };
  }

  /** Play right now, skipping the merge window (settings preview). */
  function preview(name, opts) {
    if (!enabled || !THEMES[theme][name]) return;
    // drop the click that asked for it, so the preview plays on its own
    if (pending) { clearTimeout(pending.timer); pending = null; }
    lastAt[name] = 0;
    fire(name, opts);
  }

  /** A short demo of the current style: two moves, then a select. */
  function previewTheme() {
    preview('move', { pan: -0.35, pitch: -1 });
    setTimeout(() => preview('move', { pan: 0.1, pitch: 0 }), 120);
    setTimeout(() => preview('select', { pan: 0.3 }), 300);
  }

  function setTheme(name) {
    theme = THEMES[name] ? name : 'crisp';
    if (send && ctx) send.gain.setTargetAtTime(WET[theme], ctx.currentTime, 0.02);
  }
  function setNav(on) { nav = !!on; }
  function setEnabled(on) { enabled = !!on; }
  function setVolume(v) {
    volume = clamp(Number(v) || 0, 0, 1);
    if (master && ctx) master.gain.setTargetAtTime(level(volume), ctx.currentTime, 0.02);
  }

  return {
    play, preview, previewTheme, setEnabled, setVolume, setTheme, setNav,
    names: Object.keys(THEMES.airy), THEMES: Object.keys(THEMES), PRIORITY,
  };
});
