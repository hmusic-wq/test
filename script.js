/* ==========================================================
   日本の音階 ― script.js
   Web Audio API で琴・三線・笛の音をブラウザ内で合成します。
   外部ライブラリなし。
   ========================================================== */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const h = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  /* ---------- 定義 ---------- */
  const ROWS = 11;                       // 音階の音 5つ × 2オクターブ + 上の主音
  const IV_NAME = { 1: '半音', 2: '全音', 3: '1音半', 4: '2音' };

  // intervals: 主音からの半音数
  const SCALES = {
    in: {
      name: '陰音階', kana: 'いんおんかい',
      alias: '別名「都節音階(みやこぶしおんかい)」',
      intervals: [0, 1, 5, 7, 8], defaultTonic: 4, timbre: 'koto', color: '#141d33',
      feel: '半音を2か所ふくむ、しっとりとした哀愁のある響きです。日本の伝統的な旋律の切なさは、この半音から生まれます。',
      extra: '「さくらさくら」はこの音階でできています。'
    },
    yo: {
      name: '陽音階', kana: 'ようおんかい',
      alias: '',
      intervals: [0, 2, 5, 7, 9], defaultTonic: 2, timbre: 'koto', color: '#efe8d6',
      feel: '半音をふくまない、明るくのびやかな響きです。全音と1音半だけで、すっきりと並んでいます。',
      extra: '※教科書によって、陽音階のとらえ方(始まる音)が異なる場合があります。ここでは「全音・1音半・全音・全音・1音半」の並びを使っています。'
    },
    ryukyu: {
      name: '沖縄音階', kana: 'おきなわおんかい',
      alias: '別名「琉球音階(りゅうきゅうおんかい)」',
      intervals: [0, 4, 5, 7, 11], defaultTonic: 0, timbre: 'shamisen', color: '#fff0bd',
      feel: '半音が2か所あり、2音(長3度)の大きなジャンプもある、明るく南国らしい響きです。',
      extra: '「島唄」「てぃんさぐぬ花」など、沖縄の歌や三線の音楽で親しまれています。'
    }
  };

  const NOTE_NAMES = {
    solfege: ['ド', 'レ♭', 'レ', 'ミ♭', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ラ♭', 'ラ', 'シ♭', 'シ'],
    abc: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'],
    iroha: ['ハ', '変ニ', 'ニ', '変ホ', 'ホ', 'ヘ', '嬰ヘ', 'ト', '変イ', 'イ', '変ロ', 'ロ']
  };

  const KINDS = {
    koto:     { type: 'pluck', decay: 0.9978, soft: 0.55, dur: 3.2, gain: 0.95 },
    shamisen: { type: 'pluck', decay: 0.9962, soft: 0.12, dur: 2.4, gain: 0.8 },
    flute:    { type: 'wind' }
  };

  /* ---------- 状態 ---------- */
  const state = {
    scale: 'in',
    tonic: 4,
    tonicTouched: false,
    notation: 'solfege',
    timbre: 'koto',
    timbreTouched: false,
    bpm: 88,
    steps: 16,
    tool: 2,
    loop: false,
    drone: false,
    notes: [],   // 各マスの音(行番号 0〜10、休みは -1)
    tie: []      // true: 直前の音ののばし
  };

  // はじめから入っている例(2小節)
  (function initSample() {
    const sample = [5, '~', 6, '~', 8, '~', 7, 6, 5, '~', 7, 6, 5, '~', '~', '~'];
    state.notes = sample.map((v, i) => (v === '~' ? sample[i - 1 >= 0 ? lastRow(sample, i) : 0] : v));
    state.tie = sample.map(v => v === '~');
    function lastRow(arr, i) { let j = i; while (arr[j] === '~') j--; return j; }
  })();

  /* ---------- 音の計算 ---------- */
  const tonicMidi = () => 55 + ((state.tonic + 5) % 12);   // G3〜F♯4 の範囲に主音を置く
  const degreeSemis = k => SCALES[state.scale].intervals[k % 5] + 12 * Math.floor(k / 5);
  const midiOfDegree = k => tonicMidi() + degreeSemis(k);
  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = pc => NOTE_NAMES[state.notation][((pc % 12) + 12) % 12];
  const altName = pc => NOTE_NAMES[state.notation === 'abc' ? 'solfege' : 'abc'][((pc % 12) + 12) % 12];

  /* ==========================================================
     オーディオ
     ========================================================== */
  let ctx = null, master = null, bus = null, noiseBuf = null;
  const pluckCache = new Map();
  const voices = new Set();

  function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { say('このブラウザでは音を出せません。別のブラウザでお試しください。'); return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.85;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      master.connect(comp); comp.connect(ctx.destination);

      bus = ctx.createGain();
      bus.connect(master);
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(1.8, 2.6);
      const wet = ctx.createGain();
      wet.gain.value = 0.2;
      bus.connect(conv); conv.connect(wet); wet.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function makeImpulse(sec, decay) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function getNoise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  // Karplus-Strong 法で弦をはじく音をつくる(音程は再生速度で微調整)
  function getPluck(kindKey, midi) {
    const key = kindKey + ':' + midi;
    if (pluckCache.has(key)) return pluckCache.get(key);
    const k = KINDS[kindKey];
    const sr = ctx.sampleRate;
    const f = midiToFreq(midi);
    const N = Math.max(2, Math.round(sr / f - 0.5));
    const fActual = sr / (N + 0.5);
    const len = Math.floor(sr * k.dur);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const line = new Float32Array(N);
    let s = 0, mean = 0, mx = 0;
    for (let i = 0; i < N; i++) {
      s = k.soft * s + (1 - k.soft) * (Math.random() * 2 - 1);
      line[i] = s; mean += s;
    }
    mean /= N;
    for (let i = 0; i < N; i++) { line[i] -= mean; mx = Math.max(mx, Math.abs(line[i])); }
    for (let i = 0; i < N; i++) line[i] /= (mx || 1);
    let idx = 0;
    for (let n = 0; n < len; n++) {
      const a = line[idx], b = line[(idx + 1) % N];
      out[n] = a;
      line[idx] = k.decay * 0.5 * (a + b);
      idx = (idx + 1) % N;
    }
    const fade = Math.min(len, Math.floor(sr * 0.08));
    for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
    const entry = { buf, rate: f / fActual };
    pluckCache.set(key, entry);
    return entry;
  }

  function playPluck(kindKey, midi, when, vel) {
    const { buf, rate } = getPluck(kindKey, midi);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = 0.55 * vel * KINDS[kindKey].gain;
    src.connect(g); g.connect(bus);
    src.start(when);
    const v = {
      onend: null,
      release() {
        const now = ctx.currentTime;
        try { g.gain.cancelScheduledValues(now); g.gain.setTargetAtTime(0, now, 0.04); src.stop(now + 0.25); } catch (e) { /* noop */ }
      }
    };
    src.onended = () => { g.disconnect(); if (v.onend) v.onend(); };
    return v;
  }

  function playFlute(midi, when, dur, vel) {
    const f = midiToFreq(midi);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(bus);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(f * 4, 6000);
    lp.connect(g);

    const stopT = when + Math.max(dur, 0.12) + 0.2;
    const nodes = [];
    const mk = (mult, amp) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(lp);
      // ビブラート(ゆっくり深くなる)
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, when);
      lg.gain.linearRampToValueAtTime(f * mult * 0.0045, when + 0.45);
      lfo.connect(lg); lg.connect(o.frequency);
      o.start(when); o.stop(stopT); lfo.start(when); lfo.stop(stopT);
      nodes.push(o, lfo);
      return o;
    };
    const first = mk(1, 1); mk(2, 0.22); mk(3, 0.06);

    // 息の音
    const n = ctx.createBufferSource();
    n.buffer = getNoise(); n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 1.2;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    n.connect(bp); bp.connect(ng); ng.connect(g);
    n.start(when); n.stop(stopT);
    nodes.push(n);

    const peak = 0.3 * vel;
    const end = when + Math.max(dur, 0.12);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.07);
    g.gain.setValueAtTime(peak * 0.9, Math.max(when + 0.08, end - 0.08));
    g.gain.linearRampToValueAtTime(0, end + 0.08);

    const v = {
      onend: null,
      release() {
        const now = ctx.currentTime;
        try {
          g.gain.cancelScheduledValues(now);
          g.gain.setTargetAtTime(0, now, 0.03);
          nodes.forEach(x => x.stop(now + 0.2));
        } catch (e) { /* noop */ }
      }
    };
    first.onended = () => { g.disconnect(); if (v.onend) v.onend(); };
    return v;
  }

  function playTone(midi, when, dur, vel = 1) {
    const kind = KINDS[state.timbre];
    const v = kind.type === 'pluck' ? playPluck(state.timbre, midi, when, vel) : playFlute(midi, when, dur, vel);
    voices.add(v);
    v.onend = () => voices.delete(v);
    return v;
  }

  function releaseAll() {
    voices.forEach(v => v.release());
    voices.clear();
  }

  function previewMidi(midi) {
    if (!ensureAudio()) return;
    playTone(midi, ctx.currentTime + 0.01, 0.9);
  }

  /* ---------- ドローン(主音+5度をのばす) ---------- */
  let drone = null;
  function setDrone(on) {
    state.drone = on;
    if (on) {
      if (!ensureAudio() || drone) return;
      const f = midiToFreq(tonicMidi() - 12);
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      lp.connect(g); g.connect(master);
      const mk = (type, mult, amp) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult;
        const og = ctx.createGain(); og.gain.value = amp;
        o.connect(og); og.connect(lp); o.start();
        return { o, mult };
      };
      const oscs = [mk('triangle', 1, 1), mk('triangle', Math.pow(2, 7 / 12), 0.6), mk('sine', 2, 0.5)];
      g.gain.setTargetAtTime(0.1, ctx.currentTime, 0.25);
      drone = { g, oscs };
    } else if (drone) {
      const d = drone; drone = null;
      d.g.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      setTimeout(() => { d.oscs.forEach(x => { try { x.o.stop(); } catch (e) { /* noop */ } }); d.g.disconnect(); }, 800);
    }
  }
  function retuneDrone() {
    if (!drone) return;
    const f = midiToFreq(tonicMidi() - 12);
    drone.oscs.forEach(x => x.o.frequency.setTargetAtTime(f * x.mult, ctx.currentTime, 0.05));
  }

  /* ==========================================================
     画面:一(音階を知る)・二(弦)
     ========================================================== */
  let statusTimer = 0;
  function say(msg) {
    const el = $('#status');
    el.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function renderTheme() {
    document.body.dataset.scale = state.scale;
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', SCALES[state.scale].color);
    $$('.tab').forEach(t => t.setAttribute('aria-pressed', String(t.dataset.scale === state.scale)));
  }

  function renderInfo() {
    const sc = SCALES[state.scale];
    $('#scale-name').textContent = sc.name;
    $('#scale-kana').textContent = sc.kana;
    $('#scale-alias').textContent = sc.alias;
    $('#scale-feel').textContent = sc.feel;
    $('#scale-extra').textContent = sc.extra;
  }

  function renderRuler() {
    const wrap = $('#ruler');
    wrap.textContent = '';
    const iv = SCALES[state.scale].intervals;
    for (let i = 0; i <= 12; i++) {
      const on = i === 12 || iv.includes(i);
      const pc = (state.tonic + i) % 12;
      const b = h('button', 'rcell ' + (on ? 'in' : 'out'));
      b.type = 'button';
      b.dataset.s = i;
      b.setAttribute('aria-label', noteName(pc) + (on ? '(この音階の音)' : '(この音階では使わない音)'));
      b.innerHTML = '<span class="rn">' + noteName(pc) + '</span>';
      wrap.appendChild(b);
    }
  }

  function renderPattern() {
    const iv = SCALES[state.scale].intervals;
    const parts = [];
    for (let k = 0; k < 5; k++) {
      parts.push('<span class="pn">' + noteName(state.tonic + iv[k]) + '</span>');
      const gap = (k < 4 ? iv[k + 1] : 12) - iv[k];
      parts.push('<span class="pg">' + IV_NAME[gap] + '</span>');
    }
    parts.push('<span class="pn">' + noteName(state.tonic) + '</span>');
    $('#pattern').innerHTML = parts.join('');
  }

  function renderStrings() {
    const wrap = $('#koto');
    wrap.textContent = '';
    for (let i = 0; i <= 5; i++) {
      const s = degreeSemis(i);
      const pc = (state.tonic + s) % 12;
      const isTonic = i % 5 === 0;
      const b = h('button', 'string');
      b.type = 'button';
      b.dataset.i = i;
      b.style.setProperty('--bp', (s / 12 * 0.85).toFixed(3));
      b.setAttribute('aria-label', noteName(pc) + (isTonic ? '(主音)' : '') + 'をはじく');
      b.innerHTML = '<span class="bridge"></span><span class="str-name"><b>' + noteName(pc) +
        '</b><small>' + altName(pc) + (isTonic ? ' 主音' : '') + '</small></span>';
      wrap.appendChild(b);
    }
  }

  function renderTonicOptions() {
    const sel = $('#tonic');
    sel.textContent = '';
    for (let pc = 0; pc < 12; pc++) {
      const o = h('option');
      o.value = pc;
      o.textContent = noteName(pc) + '(' + altName(pc) + ')';
      sel.appendChild(o);
    }
    sel.value = state.tonic;
  }

  function flash(el, cls, ms) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  const flashString = i => flash($('.string[data-i="' + i + '"]'), 'plucked', 750);
  const flashRuler = s => flash($('.rcell[data-s="' + s + '"]'), 'hit', 220);

  function triggerString(i) {
    previewMidi(midiOfDegree(i));
    flashString(i);
    flashRuler(degreeSemis(i));
  }

  /* 音階をのぼる・くだる */
  let seqTimers = [];
  function stopSequence() {
    seqTimers.forEach(clearTimeout);
    seqTimers = [];
  }
  function playDegrees(list) {
    if (!ensureAudio()) return;
    stopPlayback();
    stopSequence();
    releaseAll();
    const gap = 0.46;
    const t0 = ctx.currentTime + 0.06;
    list.forEach((k, idx) => {
      const t = t0 + idx * gap;
      playTone(midiOfDegree(k), t, gap * 0.95);
      seqTimers.push(setTimeout(() => { flashString(k); flashRuler(degreeSemis(k)); }, (t - ctx.currentTime) * 1000));
    });
  }
  const UP = [0, 1, 2, 3, 4, 5];
  const DOWN = [5, 4, 3, 2, 1, 0];
  const UPDOWN = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0];

  /* ==========================================================
     画面:三(メロディーをつくる)
     ========================================================== */
  let cells = [], heads = [], labels = [];

  function buildGrid() {
    const grid = $('#grid');
    grid.textContent = '';
    grid.dataset.steps = state.steps;
    grid.style.setProperty('--cols', state.steps);
    cells = []; heads = []; labels = [];

    grid.appendChild(h('div', 'gcorner'));
    for (let c = 0; c < state.steps; c++) {
      const hc = h('div', 'hcell' + (c % 2 === 0 ? ' bar' : ''));
      hc.textContent = c % 2 === 0 ? String((c / 2) % 4 + 1) : '・';
      grid.appendChild(hc);
      heads.push(hc);
      cells.push([]);
    }
    for (let r = ROWS - 1; r >= 0; r--) {
      const lab = h('div', 'rlabel' + (r % 5 === 0 ? ' tonic' : ''));
      grid.appendChild(lab);
      labels[r] = lab;
      for (let c = 0; c < state.steps; c++) {
        const b = h('button', 'cell' + (Math.floor(c / 8) % 2 ? ' alt' : '') + (r % 5 === 0 ? ' trow' : ''));
        b.type = 'button';
        b.dataset.c = c;
        b.dataset.r = r;
        grid.appendChild(b);
        cells[c][r] = b;
      }
    }
    updateLabels();
    updateCells();
  }

  const REGISTER = ['低', '中', '高'];
  function updateLabels() {
    for (let r = 0; r < ROWS; r++) {
      const nm = noteName(midiOfDegree(r) % 12);
      labels[r].innerHTML = nm + '<small>' + REGISTER[Math.floor(r / 5)] + '</small>';
      for (let c = 0; c < state.steps; c++) {
        cells[c][r].setAttribute('aria-label', (c + 1) + 'マス目 ' + nm + REGISTER[Math.floor(r / 5)]);
      }
    }
  }

  function updateCells() {
    const n = state.steps;
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < ROWS; r++) {
        const on = state.notes[c] === r;
        const b = cells[c][r];
        b.classList.toggle('on', on);
        b.classList.toggle('tie', on && state.tie[c]);
        b.classList.toggle('cont', on && c + 1 < n && state.tie[c + 1] && state.notes[c + 1] === r);
        b.setAttribute('aria-pressed', String(on));
      }
    }
  }

  function clearFrom(c) {
    state.notes[c] = -1; state.tie[c] = false;
    let j = c + 1;
    while (j < state.steps && state.tie[j]) { state.notes[j] = -1; state.tie[j] = false; j++; }
  }

  function placeNote(c, r, len) {
    clearFrom(c);
    state.notes[c] = r; state.tie[c] = false;
    for (let j = 1; j < len && c + j < state.steps; j++) {
      clearFrom(c + j);
      state.notes[c + j] = r; state.tie[c + j] = true;
    }
  }

  function onCellClick(e) {
    const b = e.target.closest('.cell');
    if (!b) return;
    const c = +b.dataset.c, r = +b.dataset.r;
    if (state.notes[c] === r) {
      clearFrom(c);
    } else {
      placeNote(c, r, state.tool);
      previewMidi(midiOfDegree(r));
      flashString(r % 5);
    }
    updateCells();
  }

  function resizeSteps(n) {
    const nn = Array(n).fill(-1), tt = Array(n).fill(false);
    for (let i = 0; i < Math.min(n, state.steps); i++) { nn[i] = state.notes[i]; tt[i] = state.tie[i]; }
    stopPlayback();
    state.notes = nn; state.tie = tt; state.steps = n;
    buildGrid();
  }

  /* ---------- 再生 ---------- */
  const player = { playing: false, start: 0, stepDur: 0, next: null, timer: 0, last: -1 };

  function scheduleMelody(t0, stepDur) {
    const n = state.steps;
    for (let i = 0; i < n; i++) {
      const r = state.notes[i];
      if (r < 0 || state.tie[i]) continue;
      let len = 1;
      while (i + len < n && state.tie[i + len] && state.notes[i + len] === r) len++;
      playTone(midiOfDegree(r), t0 + i * stepDur, len * stepDur * 0.98);
    }
  }

  function startPlayback() {
    if (!ensureAudio()) return;
    stopSequence();
    if (!state.notes.some(r => r >= 0)) { say('まだ音が入っていません。四角をおして音を置いてみましょう。'); return; }
    releaseAll();
    player.playing = true;
    player.stepDur = 60 / state.bpm / 2;
    player.start = ctx.currentTime + 0.1;
    player.next = null;
    player.last = -1;
    scheduleMelody(player.start, player.stepDur);
    $('#btn-play').textContent = 'ていし';
    $('#btn-play').classList.add('playing');
    clearInterval(player.timer);
    player.timer = setInterval(tick, 30);
  }

  function tick() {
    if (!player.playing) return;
    const now = ctx.currentTime;
    const total = state.steps * player.stepDur;
    let elapsed = now - player.start;

    if (state.loop && !player.next && elapsed > total - Math.min(1.1, total * 0.5)) {
      const sd = 60 / state.bpm / 2;
      player.next = { start: player.start + total, stepDur: sd };
      scheduleMelody(player.next.start, sd);
    }
    if (elapsed >= total) {
      if (player.next) {
        player.start = player.next.start;
        player.stepDur = player.next.stepDur;
        player.next = null;
        elapsed = now - player.start;
      } else {
        stopPlayback(true);
        return;
      }
    }
    const step = Math.max(0, Math.min(state.steps - 1, Math.floor(elapsed / player.stepDur)));
    if (step !== player.last) {
      setPlayhead(step);
      player.last = step;
    }
  }

  function setPlayhead(step) {
    clearPlayhead();
    heads[step].classList.add('ph');
    for (let r = 0; r < ROWS; r++) cells[step][r].classList.add('ph');
    if (state.notes[step] >= 0 && !state.tie[step]) flashString(state.notes[step] % 5);
    const w = $('#gridwrap');
    const left = heads[step].offsetLeft;
    if (left < w.scrollLeft + 70 || left > w.scrollLeft + w.clientWidth - 60) w.scrollLeft = Math.max(0, left - 90);
  }

  function clearPlayhead() {
    $$('#grid .ph').forEach(el => el.classList.remove('ph'));
  }

  function stopPlayback(natural) {
    if (!player.playing && !$('#grid .ph')) { return; }
    player.playing = false;
    clearInterval(player.timer);
    player.next = null;
    if (ctx && !natural) releaseAll();     // 自然に終わったときは、最後の音の余韻を残す
    clearPlayhead();
    const b = $('#btn-play');
    b.textContent = 'さいせい';
    b.classList.remove('playing');
  }

  /* ---------- おまかせ作曲 ---------- */
  function generateMelody() {
    const n = state.steps;
    const notes = Array(n).fill(-1), tie = Array(n).fill(false);
    const put = (pos, row, len) => {
      notes[pos] = row;
      for (let j = 1; j < len && pos + j < n; j++) { notes[pos + j] = row; tie[pos + j] = true; }
    };
    let i = 0, cur = 5, first = true, prevRest = false;
    while (i < n) {
      const remain = n - i;
      if (remain <= 4) {                         // 終わりは主音でおちつく
        const cand = [0, 5, 10].reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a));
        put(i, cand, remain);
        break;
      }
      if (first) { put(i, 5, 2); i += 2; first = false; continue; }   // はじめは主音
      if (!prevRest && Math.random() < 0.08) { i += 1; prevRest = true; continue; }
      prevRest = false;
      const len = Math.min([1, 1, 2, 2, 2, 4][Math.floor(Math.random() * 6)], remain);
      const rnd = Math.random();
      let d = rnd < 0.34 ? 1 : rnd < 0.68 ? -1 : rnd < 0.8 ? 2 : rnd < 0.92 ? -2 : 0;
      if (cur >= 9 && d > 0) d = -d;
      if (cur <= 1 && d < 0) d = -d;
      cur = Math.max(0, Math.min(ROWS - 1, cur + d));
      put(i, cur, len);
      i += len;
    }
    state.notes = notes; state.tie = tie;
    updateCells();
    startPlayback();
    say('メロディーをつくりました。四角をおして自由に直せます。');
  }

  /* ---------- リンクで共有 ---------- */
  function encodeState() {
    const notes = state.notes.map((r, i) => (r < 0 ? '-' : state.tie[i] ? '~' : String(r))).join('.');
    return new URLSearchParams({
      s: state.scale, t: state.tonic, b: state.bpm, k: state.timbre, n: notes
    }).toString();
  }

  function loadFromHash() {
    if (!location.hash || location.hash.length < 2) return;
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      const s = p.get('s'), t = +p.get('t'), b = +p.get('b'), k = p.get('k'), n = p.get('n');
      if (s && SCALES[s]) state.scale = s;
      if (Number.isInteger(t) && t >= 0 && t <= 11 && p.has('t')) { state.tonic = t; state.tonicTouched = true; }
      else state.tonic = SCALES[state.scale].defaultTonic;
      if (b >= 50 && b <= 160) state.bpm = b;
      if (k && KINDS[k]) { state.timbre = k; state.timbreTouched = true; }
      else state.timbre = SCALES[state.scale].timbre;
      if (n) {
        const tokens = n.split('.');
        if ([8, 16, 32].includes(tokens.length)) {
          const notes = [], tie = [];
          let ok = true;
          tokens.forEach((tk, i) => {
            if (tk === '-') { notes.push(-1); tie.push(false); }
            else if (tk === '~') {
              if (i === 0 || notes[i - 1] < 0) { ok = false; notes.push(-1); tie.push(false); }
              else { notes.push(notes[i - 1]); tie.push(true); }
            } else {
              const r = parseInt(tk, 10);
              if (!(r >= 0 && r < ROWS)) { ok = false; notes.push(-1); } else notes.push(r);
              tie.push(false);
            }
          });
          if (ok) { state.notes = notes; state.tie = tie; state.steps = tokens.length; }
        }
      }
    } catch (e) { /* 読み込めなければ初期状態のまま */ }
  }

  function shareLink() {
    const url = location.origin + location.pathname + '#' + encodeState();
    const done = () => say('リンクをコピーしました。開くと、このメロディーが再現されます。');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(done, () => window.prompt('このリンクをコピーしてください', url));
    } else {
      window.prompt('このリンクをコピーしてください', url);
    }
  }

  /* ==========================================================
     組み立て・イベント
     ========================================================== */
  function renderAll() {
    renderTheme();
    renderInfo();
    renderTonicOptions();
    renderRuler();
    renderPattern();
    renderStrings();
    updateLabels();
    $('#notation').value = state.notation;
    $$('input[name="timbre"]').forEach(r => { r.checked = r.value === state.timbre; });
  }

  function setScale(key) {
    state.scale = key;
    const sc = SCALES[key];
    if (!state.tonicTouched) state.tonic = sc.defaultTonic;
    if (!state.timbreTouched) state.timbre = sc.timbre;
    renderAll();
    retuneDrone();
  }

  function init() {
    loadFromHash();
    state.tool = +($('input[name="tool"]:checked') || { value: 2 }).value;

    buildGrid();
    renderAll();
    $('#steps').value = String(state.steps);
    $('#bpm').value = state.bpm;
    $('#bpm-out').textContent = state.bpm;

    // 音階えらび
    const tabs = $$('.tab');
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => setScale(t.dataset.scale));
      t.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const j = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          tabs[j].focus();
          setScale(tabs[j].dataset.scale);
          e.preventDefault();
        }
      });
    });

    // 設定
    $('#tonic').addEventListener('change', e => {
      state.tonic = +e.target.value;
      state.tonicTouched = true;
      renderRuler(); renderPattern(); renderStrings(); updateLabels(); retuneDrone();
    });
    $('#notation').addEventListener('change', e => {
      state.notation = e.target.value;
      renderTonicOptions(); renderRuler(); renderPattern(); renderStrings(); updateLabels();
    });
    $$('input[name="timbre"]').forEach(r => r.addEventListener('change', () => {
      if (r.checked) { state.timbre = r.value; state.timbreTouched = true; previewMidi(midiOfDegree(0)); }
    }));

    // 一
    $('#btn-up').addEventListener('click', () => playDegrees(UP));
    $('#btn-down').addEventListener('click', () => playDegrees(DOWN));
    $('#btn-updown').addEventListener('click', () => playDegrees(UPDOWN));
    $('#drone').addEventListener('change', e => setDrone(e.target.checked));
    $('#ruler').addEventListener('click', e => {
      const b = e.target.closest('.rcell');
      if (!b) return;
      const s = +b.dataset.s;
      previewMidi(tonicMidi() + s);
      flash(b, 'hit', 220);
    });

    // 二
    $('#koto').addEventListener('click', e => {
      const b = e.target.closest('.string');
      if (b) triggerString(+b.dataset.i);
    });
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key >= '1' && e.key <= '6') { triggerString(+e.key - 1); }
    });

    // 三
    $('#grid').addEventListener('click', onCellClick);
    $$('input[name="tool"]').forEach(r => r.addEventListener('change', () => { if (r.checked) state.tool = +r.value; }));
    $('#steps').addEventListener('change', e => resizeSteps(+e.target.value));
    $('#bpm').addEventListener('input', e => {
      state.bpm = +e.target.value;
      $('#bpm-out').textContent = state.bpm;
    });
    $('#loop').addEventListener('change', e => { state.loop = e.target.checked; });
    $('#btn-play').addEventListener('click', () => { player.playing ? stopPlayback() : startPlayback(); });
    $('#btn-random').addEventListener('click', generateMelody);
    $('#btn-clear').addEventListener('click', () => {
      stopPlayback();
      state.notes.fill(-1); state.tie.fill(false);
      updateCells();
      say('すべて消しました。');
    });
    $('#btn-share').addEventListener('click', shareLink);
  }

  init();
})();
