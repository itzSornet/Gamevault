/*
 * Fluid background — palette-colored blobs drifting behind the glass.
 *
 * Started from the user's "Cutting Mat" Wallpaper Engine wallpaper (a warped
 * noise surface), then stylized: no lighting, just a few big soft-edged blobs
 * of flat palette color that drift and merge slowly. The colors come from the
 * --wave-1/2/3 and --bg tokens in style.css, so it follows the palette.
 *
 * Cheap by design: it renders at ~1/4 of the window size (the browser scales it
 * up, and everything over it is blurred anyway), steps at ~20 fps, and stops
 * entirely when the window is hidden, on the Lite tier, under software
 * rendering, or with reduced motion (one still frame instead).
 * While it runs, #ambient gets .has-fluid and the CSS bands step aside.
 */
(function () {
  'use strict';

  const FPS = 20;
  const SCALE = 0.25;           // canvas pixels per CSS pixel
  const MAX_W = 520;            // cap for very large windows
  const SPEED = 0.03;           // noise-time units per second (wallpaper ≈ 0.1)

  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';

  // Ashima simplex noise (MIT), as used by the wallpaper.
  const FS = `precision mediump float;
uniform vec2 uRes;uniform float uT;
uniform vec3 cBase;uniform vec3 c1;uniform vec3 c2;uniform vec3 c3;
uniform float uAmt;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
/* stylized: big, flat blobs with soft edges — no normals, no highlights */
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*uRes)/uRes.y;
  float t=uT;
  vec2 w=vec2(snoise(vec3(uv*0.55,t*0.7)),snoise(vec3(uv*0.55+vec2(5.2,1.3),t*0.7)));
  vec2 q=uv+w*0.3;
  float n1=snoise(vec3(q*1.15,t));
  float n2=snoise(vec3(q*0.95+vec2(9.1,3.7),t*0.85));
  float A=smoothstep(0.04,0.44,n1);           /* main blobs */
  float B=smoothstep(0.34,0.7,n2)*(1.0-0.85*A); /* third color: rarer, smaller patches */
  float C=smoothstep(0.5,0.9,n1);            /* lighter core inside the main blobs */
  vec3 col=cBase;
  col=mix(col,c1,A*0.92);
  col=mix(col,c3,B*0.7);
  col=mix(col,c2,C*0.8);
  /* calm corners so the glass edges stay quiet */
  float v=smoothstep(1.25,0.35,length(uv*vec2(0.85,1.0)));
  col=mix(cBase,col,uAmt*(0.7+0.3*v));
  gl_FragColor=vec4(col,1.0);
}`;

  const root = document.documentElement;
  const host = document.getElementById('ambient');
  if (!host) return;

  let canvas = null, gl = null, prog = null, U = null;
  let raf = 0, lastMs = 0, acc = 0, t = Math.random() * 40;
  let running = false;

  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function rgbVar(name, fallback) {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    let parts;
    if (raw.startsWith('#')) {
      const h = raw.length === 4 ? raw.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : raw;
      parts = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
    } else {
      parts = raw.split(',').map((s) => parseFloat(s));
    }
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) parts = fallback;
    return parts.slice(0, 3).map((n) => n / 255);
  }

  function setup() {
    canvas = document.createElement('canvas');
    canvas.className = 'ambient-fluid';
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) { canvas = null; return false; }
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('ambient shader', gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) { teardown(); return false; }
    prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { teardown(); return false; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    U = {};
    ['uRes', 'uT', 'cBase', 'c1', 'c2', 'c3', 'uAmt'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); teardown(); sync(); });
    host.prepend(canvas);
    resize();
    applyColors();
    return true;
  }

  function teardown() {
    stop();
    if (canvas) canvas.remove();
    canvas = null; gl = null; prog = null; U = null;
    host.classList.remove('has-fluid');
  }

  function resize() {
    if (!gl) return;
    const w = Math.max(2, Math.min(MAX_W, Math.round(window.innerWidth * SCALE)));
    const h = Math.max(2, Math.round(w * window.innerHeight / Math.max(1, window.innerWidth)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(U.uRes, w, h);
      if (!running) draw();
    }
  }

  function applyColors() {
    if (!gl) return;
    const light = root.dataset.palette === 'paper';
    gl.uniform3fv(U.cBase, rgbVar('--bg', light ? [243, 240, 233] : [8, 9, 12]));
    gl.uniform3fv(U.c1, rgbVar('--wave-1', [76, 125, 255]));
    gl.uniform3fv(U.c2, rgbVar('--wave-2', [124, 92, 255]));
    gl.uniform3fv(U.c3, rgbVar('--wave-3', [32, 190, 160]));
    const amt = parseFloat(getComputedStyle(root).getPropertyValue('--fluid-amt'));
    gl.uniform1f(U.uAmt, Number.isFinite(amt) ? amt : (light ? 0.45 : 0.8));
    if (!running) draw();
  }

  function draw() {
    if (!gl) return;
    gl.uniform1f(U.uT, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(ms) {
    raf = requestAnimationFrame(frame);
    const dt = lastMs ? Math.min(ms - lastMs, 100) : 0;
    lastMs = ms;
    acc += dt;
    if (acc < 1000 / FPS - 1) return;
    t += acc * 0.001 * SPEED;
    acc = 0;
    draw();
  }

  function start() {
    if (running) return;
    running = true; lastMs = 0; acc = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Decide what the background should be doing right now.
  function sync() {
    const allowed = root.dataset.tier !== 'lite' && root.dataset.software !== '1';
    if (!allowed) { teardown(); return; }
    if (!gl && !setup()) return;          // no WebGL: the CSS bands stay
    host.classList.add('has-fluid');
    const still = (reduced && reduced.matches) || document.hidden;
    if (root.dataset.busy === '1') stop();            // a layout animation is running: hold the last frame
    else if (still) { stop(); draw(); } else start();
  }

  new MutationObserver((list) => {
    if (list.some((m) => m.attributeName === 'data-palette')) applyColors();
    sync();
  }).observe(root, { attributes: true, attributeFilter: ['data-palette', 'data-tier', 'data-software', 'data-busy'] });
  document.addEventListener('visibilitychange', sync);
  if (reduced && reduced.addEventListener) reduced.addEventListener('change', sync);
  window.addEventListener('resize', resize);

  sync();
})();
