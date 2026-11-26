// Hidden recorder page: records the screen (and game sound, and the mic when
// it's on) and hands main one second of video at a time.
(() => {
  let recorder = null;
  let tracks = [];
  let audioCtx = null;
  let writes = Promise.resolve();

  // H.264 is encoded by the graphics card on most PCs: far less CPU while a
  // game runs than VP8/VP9 in software
  const TYPES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];

  function cleanup() {
    for (const t of tracks) { try { t.stop(); } catch (_) {} }
    tracks = [];
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    recorder = null;
  }

  window.cap.onStart(async ({ sourceId, width, height, audio, mic }) => {
    try {
      const desktop = { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId };
      const screen = await navigator.mediaDevices.getUserMedia({
        audio: audio ? { mandatory: desktop } : false,
        video: { mandatory: { ...desktop, maxFrameRate: 60, ...(width && height ? { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height } : {}) } },
      });
      tracks.push(...screen.getTracks());
      const out = new MediaStream(screen.getVideoTracks());

      let micStream = null;
      if (mic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          tracks.push(...micStream.getTracks());
        } catch (_) { /* no mic: record without it */ }
      }
      const sound = [screen, micStream].filter((s) => s && s.getAudioTracks().length);
      if (sound.length === 1) {
        out.addTrack(sound[0].getAudioTracks()[0]);
      } else if (sound.length > 1) {
        // a recording keeps one sound track: mix game sound and mic into it
        audioCtx = new AudioContext();
        const mix = audioCtx.createMediaStreamDestination();
        for (const s of sound) audioCtx.createMediaStreamSource(s).connect(mix);
        out.addTrack(mix.stream.getAudioTracks()[0]);
      }

      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      recorder = new MediaRecorder(out, { mimeType, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 160_000 });
      writes = Promise.resolve();
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        // kept in order: each piece is read only after the one before it
        writes = writes.then(() => e.data.arrayBuffer()).then((b) => window.cap.chunk(new Uint8Array(b)));
      };
      recorder.onstop = () => {
        writes.then(() => { cleanup(); window.cap.done({ ok: true }); });
      };
      recorder.onerror = (e) => {
        cleanup();
        window.cap.done({ ok: false, error: (e && e.error && e.error.message) || 'The recorder stopped' });
      };
      // the screen went away (display unplugged, session locked)
      screen.getVideoTracks()[0].onended = () => { if (recorder && recorder.state !== 'inactive') recorder.stop(); };
      recorder.start(1000);
      window.cap.started();
    } catch (e) {
      cleanup();
      window.cap.done({ ok: false, error: e && e.message ? e.message : 'Could not start recording' });
    }
  });

  window.cap.onStop(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else { cleanup(); window.cap.done({ ok: false, error: 'Nothing was recorded' }); }
  });
})();
