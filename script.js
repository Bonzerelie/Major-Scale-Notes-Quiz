/* /script.js */
(() => {
  "use strict";

  // -------------------- Config --------------------
  const AUDIO_DIR = "audio";
  const FADE_OUT_SEC = 0.12;
  const LIMITER_THRESHOLD_DB = -6;

  // Per-question input keyboard: 3 octaves (large / easy to use)
  const Q_KBD_START_OCT = 3; // C3
  const Q_KBD_OCTAVES = 3;
  const Q_KBD_INCLUDE_END_C = true;

  
  // Scale selection rules
  const SCALE_UNIQUE_DEGREES = 7; // 1..7
  const SCALE_ALLOW_OCTAVE_ROOT = true; // allow selecting the root twice (octave)
  const SCALE_MAX_SELECTIONS = SCALE_UNIQUE_DEGREES + (SCALE_ALLOW_OCTAVE_ROOT ? 1 : 0);
// Results mini keyboards: 3 octaves C3..B5 (+ final C)
  const MINI_KBD_START_OCT = 3;
  const MINI_KBD_OCTAVES = 3;
  const MINI_KBD_INCLUDE_END_C = true;

  // Task sheet printed keyboards
  const TASK_KBD_START_OCT = 3;
  const TASK_KBD_OCTAVES = 3;
  const TASK_KBD_INCLUDE_END_C = true;

  // Task sheet questions per page (single column, bigger questions)
  const TASK_Q_PER_PAGE = 4;

  // PDF margins (pt)
  const PDF_MARGIN_PT = 18;

  const PC_TO_STEM = {
    0: "c",
    1: "csharp",
    2: "d",
    3: "dsharp",
    4: "e",
    5: "f",
    6: "fsharp",
    7: "g",
    8: "gsharp",
    9: "a",
    10: "asharp",
    11: "b",
  };

  const PC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const PC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const ACC_PCS = new Set([1, 3, 6, 8, 10]);

  const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];

  // -------------------- DOM --------------------
  const $ = (id) => document.getElementById(id);

  const beginModal = $("beginModal");
  const beginBtn = $("beginBtn");
  const questionCountSelect = $("questionCountSelect");
  const pageAdvice = $("pageAdvice");

  const infoBtn = $("infoBtn");
  const infoModal = $("infoModal");
  const infoOk = $("infoOk");

  const downloadTaskBtn = $("downloadTaskBtn");
  const downloadScorecardBtn = $("downloadScorecardBtn");
  const resetBtn = $("resetBtn");
  const resetBtn2 = $("resetBtn2");

  const quizMeta = $("quizMeta");
  const questionsList = $("questionsList");
  const submitBtn = $("submitBtn");

  const resultsPanel = $("resultsPanel");
  const resultsSummary = $("resultsSummary");

  const taskSheetTemplate = $("taskSheetTemplate");
  const scorecardTemplate = $("scorecardTemplate");

  // -------------------- Audio (WebAudio) --------------------
  let audioCtx = null;
  let masterGain = null;
  let limiter = null;

  const bufferPromiseCache = new Map();
  const activeVoices = new Set();

  function ensureAudioGraph() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      alert("Your browser doesn’t support Web Audio (required for playback).");
      return null;
    }

    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;

    limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;

    masterGain.connect(limiter);
    limiter.connect(audioCtx.destination);
    return audioCtx;
  }

  async function resumeAudioIfNeeded() {
    const ctx = ensureAudioGraph();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch {}
    }
  }

  function stopAllNotes(fadeSec = 0.06) {
    const ctx = ensureAudioGraph();
    if (!ctx) return;

    const now = ctx.currentTime;
    const fade = Math.max(0.02, Number.isFinite(fadeSec) ? fadeSec : 0.06);

    for (const v of Array.from(activeVoices)) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, fade / 6);
        const stopAt = Math.max(now + fade, (v.startTime || now) + 0.001);
        v.src.stop(stopAt + 0.02);
      } catch {}
    }
  }

  function trackVoice(src, gain, startTime) {
    const voice = { src, gain, startTime };
    activeVoices.add(voice);
    src.onended = () => activeVoices.delete(voice);
    return voice;
  }

  function noteUrl(stem, octaveNum) {
    return `${AUDIO_DIR}/${stem}${octaveNum}.mp3`;
  }

  function loadBuffer(url) {
    if (bufferPromiseCache.has(url)) return bufferPromiseCache.get(url);

    const p = (async () => {
      const ctx = ensureAudioGraph();
      if (!ctx) return null;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        return await ctx.decodeAudioData(ab);
      } catch {
        return null;
      }
    })();

    bufferPromiseCache.set(url, p);
    return p;
  }

  function pcFromPitch(p) {
    return ((p % 12) + 12) % 12;
  }
  function octFromPitch(p) {
    return Math.floor(p / 12);
  }
  function pitchFromPcOct(pc, oct) {
    return oct * 12 + pc;
  }

  function rangeHiPitch(startPitch, octaves, includeEndC = false) {
    const totalSemis = Math.max(0, Math.round(octaves)) * 12;
    let hi = startPitch + totalSemis - 1;
    if (includeEndC && pcFromPitch(startPitch) === 0) hi += 1;
    return hi;
  }

  function getStemForPc(pc) {
    return PC_TO_STEM[(pc + 12) % 12] || null;
  }

  async function loadPitchBuffer(pitch) {
    const pc = pcFromPitch(pitch);
    const oct = octFromPitch(pitch);
    const stem = getStemForPc(pc);
    if (!stem) return { missingUrl: null, buffer: null };

    const url = noteUrl(stem, oct);
    const buf = await loadBuffer(url);
    if (!buf) return { missingUrl: url, buffer: null };
    return { missingUrl: null, buffer: buf };
  }

  function playBufferWindowed(buffer, whenSec, playSec, fadeOutSec, gain = 1, fadeStartAtSec = null) {
  const ctx = ensureAudioGraph();
  if (!ctx || !masterGain) return null;

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const g = ctx.createGain();
  const safeGain = Math.max(0, Number.isFinite(gain) ? gain : 1);

  const fadeIn = 0.01;
  const endAt = whenSec + Math.max(0.05, playSec);

  g.gain.setValueAtTime(0, whenSec);
  g.gain.linearRampToValueAtTime(safeGain, whenSec + fadeIn);

  const fadeOut = Math.max(0.01, Number.isFinite(fadeOutSec) ? fadeOutSec : 0.06);

  const fadeStart = Number.isFinite(fadeStartAtSec)
    ? Math.max(whenSec + 0.02, Math.min(fadeStartAtSec, endAt - 0.001))
    : Math.max(whenSec + 0.02, endAt - Math.max(0.06, fadeOut));

  g.gain.setValueAtTime(safeGain, fadeStart);
  g.gain.linearRampToValueAtTime(0, Math.min(endAt, fadeStart + fadeOut));

  src.connect(g);
  g.connect(masterGain);

  trackVoice(src, g, whenSec);
  src.start(whenSec);
  src.stop(endAt + 0.03);
  return src;
}

  async function playPitchesSequentialOverlap(pitches, stepSec = 0.4, fadeOutSec = 0.03, lastTailSec = 1.0) {
  await resumeAudioIfNeeded();
  const ctx = ensureAudioGraph();
  if (!ctx) return false;

  const when0 = ctx.currentTime + 0.03;
  const seq = (Array.isArray(pitches) ? pitches : []).map((p) => Math.round(p));

  const results = await Promise.all(seq.map(loadPitchBuffer));
  const missing = results.find((r) => r?.missingUrl);
  if (missing?.missingUrl) {
    alert(`Missing audio sample: ${missing.missingUrl}`);
    return false;
  }

  const bufs = results.map((r) => r?.buffer);
  if (!bufs.length || bufs.some((b) => !b)) return false;

  const perNoteGain = 0.8;

  for (let i = 0; i < bufs.length; i++) {
    const start = when0 + i * stepSec;
    const isLast = i === bufs.length - 1;

    if (isLast) {
      const playSec = Math.max(0.05, lastTailSec);
      playBufferWindowed(bufs[i], start, playSec, fadeOutSec, perNoteGain, start + playSec - fadeOutSec);
    } else {
      const nextStart = when0 + (i + 1) * stepSec;
      const playSec = Math.max(0.05, (nextStart - start) + fadeOutSec);
      playBufferWindowed(bufs[i], start, playSec, fadeOutSec, perNoteGain, nextStart);
    }
  }

  return true;
}

// Backwards-compat: older call sites used playSec as a single "duration" value.
async function playPitchesWindowed(pitches, playSec = 0.8) {
  return playPitchesSequentialOverlap(pitches, 0.3, 0.2, playSec);
}

  // -------------------- Iframe auto-height (kept) --------------------
  function postHeightToParent(height) {
    if (window.parent === window) return;
    window.parent.postMessage(
      {
        iframeHeight: Math.max(0, Math.round(height)),
        type: "scales:height",
        height: Math.max(0, Math.round(height)),
        frameId: document.documentElement.getAttribute("data-frame-id") || null,
      },
      "*"
    );
  }

  function measureDocHeightPx() {
    const de = document.documentElement;
    const body = document.body;
    return Math.max(
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      de?.clientHeight ?? 0,
      de?.scrollHeight ?? 0,
      de?.offsetHeight ?? 0
    );
  }

  function setupIframeAutoHeight() {
    const send = () => postHeightToParent(measureDocHeightPx());
    send();
    window.addEventListener("load", send, { passive: true });

    const ro = new ResizeObserver(() => send());
    const appRoot = document.getElementById("appRoot") || document.body;
    if (appRoot) ro.observe(appRoot);

    const mo = new MutationObserver(() => send());
    mo.observe(appRoot || document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    window.__scalesSendHeight = send;
  }

  // -------------------- Theory helpers --------------------
  function noteLabelForPc(pc) {
    const p = ((pc % 12) + 12) % 12;
    return ACC_PCS.has(p) ? `${PC_SHARP[p]}/${PC_FLAT[p]}` : PC_SHARP[p];
  }

  function majorScalePcs(rootPc) {
    const r = ((rootPc % 12) + 12) % 12;
    return MAJOR_SCALE_OFFSETS.map((o) => (r + o) % 12);
  }

  function scaleName(rootPc) {
    return `${noteLabelForPc(rootPc)} Major`;
  }

  function pcsToPretty(pcs) {
    return pcs.map(noteLabelForPc).join(", ");
  }

  function pcsToPrettyWithOctave(rootPc, pcs) {
    const r = ((rootPc % 12) + 12) % 12;
    const seq = (pcs || []).slice();
    seq.push(r);
    return seq.map(noteLabelForPc).join(", ");
  }

  function relativeSortFromRoot(rootPc, pcs) {
    const r = ((rootPc % 12) + 12) % 12;
    return pcs
      .slice()
      .map((pc) => ((pc % 12) + 12) % 12)
      .sort((a, b) => ((a - r + 12) % 12) - ((b - r + 12) % 12));
  }

  function nextPitchAtOrAbove(pc, minPitch) {
    const want = ((pc % 12) + 12) % 12;
    let p = Math.max(0, Math.floor(minPitch));
    while (pcFromPitch(p) !== want) p += 1;
    return p;
  }

  function pcsToAscendingPitchesFromRoot(rootPc, pcs, rootOct = 4, includeOctaveRoot = false) {
    const ordered = relativeSortFromRoot(rootPc, pcs);
    const rootPitch = pitchFromPcOct(((rootPc % 12) + 12) % 12, rootOct);

    const out = [];
    let cursor = rootPitch;
    for (let i = 0; i < ordered.length; i++) {
      const pc = ordered[i];
      const p = i === 0 ? nextPitchAtOrAbove(pc, cursor) : nextPitchAtOrAbove(pc, cursor + 1);
      out.push(p);
      cursor = p;
    }    if (includeOctaveRoot && out.length) {
      out.push(out[out.length - 1] + 1); // next semitone then corrected below
      const last = out[out.length - 2];
      const rootPcNorm = ((rootPc % 12) + 12) % 12;
      let p = last + 1;
      while (pcFromPitch(p) !== rootPcNorm) p += 1;
      out[out.length - 1] = p;
    }
    return out;
  }

  function uniquePcsFromPitches(pitches) {
    const seen = new Set();
    const out = [];
    for (const p of (pitches || [])) {
      const pc = pcFromPitch(p);
      if (seen.has(pc)) continue;
      seen.add(pc);
      out.push(pc);
    }
    return out;
  }

  // -------------------- Keyboard SVG --------------------
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs = {}, children = []) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      n.setAttribute(k, String(v));
    }
    for (const c of children) n.appendChild(c);
    return n;
  }

  function whiteIndexInOctave(pc) {
    const m = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
    return m[pc] ?? null;
  }

  function buildKeyboardSvg({
    startPitch,
    octaves,
    includeEndC = false,
    interactive = true,
    ariaLabel = "Keyboard",
    highlight = null, // Map<pitch, "hit"|"ok"|"bad">
    onKeyDown = null,
    theme = null, // { blackFill, whiteFill, blackStroke, whiteStroke, frameFill }
  }) {
    const lo = startPitch;
    const hi = rangeHiPitch(startPitch, octaves, includeEndC);

    const all = [];
    for (let p = lo; p <= hi; p++) all.push(p);

    const WHITE_W = 28;
    const WHITE_H = 124;
    const BLACK_W = 17;
    const BLACK_H = 78;
    const BORDER = 10;
    const RADIUS = 18;

    const t = {
      frameFill: theme?.frameFill ?? "#fff",
      whiteFill: theme?.whiteFill ?? "#fff",
      whiteStroke: theme?.whiteStroke ?? "#222",
      blackFill: theme?.blackFill ?? "#111",
      blackStroke: theme?.blackStroke ?? "#000",
    };

    const whitePitches = all.filter((p) => whiteIndexInOctave(pcFromPitch(p)) != null);
    const totalWhite = whitePitches.length;

    const innerW = totalWhite * WHITE_W;
    const outerW = innerW + BORDER * 2;
    const outerH = WHITE_H + BORDER * 2;

    const svg = svgEl("svg", {
      width: outerW,
      height: outerH,
      viewBox: `0 0 ${outerW} ${outerH}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": ariaLabel,
    });

    const style = svgEl("style");
    style.textContent = `
      .frame{ fill:${t.frameFill}; stroke:#000; stroke-width:${BORDER}; rx:${RADIUS}; ry:${RADIUS}; }
      .w rect{ fill:${t.whiteFill}; stroke:${t.whiteStroke}; stroke-width:1; }
      .b rect{ fill:${t.blackFill}; stroke:${t.blackStroke}; stroke-width:1; rx:3; ry:3; }
      .key { cursor: ${interactive ? "pointer" : "default"}; }
      .hit rect { fill: var(--kbdHit) !important; }
      .hitOk rect { fill: var(--kbdHitOk) !important; }
      .hitBad rect { fill: var(--kbdHitBad) !important; }
    `;
    svg.appendChild(style);

    svg.appendChild(
      svgEl("rect", {
        x: BORDER / 2,
        y: BORDER / 2,
        width: outerW - BORDER,
        height: outerH - BORDER,
        rx: RADIUS,
        ry: RADIUS,
        class: "frame",
      })
    );

    const gW = svgEl("g");
    const gB = svgEl("g");
    svg.appendChild(gW);
    svg.appendChild(gB);

    const startX = BORDER;
    const startY = BORDER;

    const whiteIndexByPitch = new Map();
    whitePitches.forEach((p, i) => whiteIndexByPitch.set(p, i));

    function classForPitch(p, base) {
      if (!highlight) return base;
      const c = highlight.get(p);
      if (!c) return base;
      if (c === "ok") return `${base} hitOk`;
      if (c === "bad") return `${base} hitBad`;
      return `${base} hit`;
    }

    // White keys
    for (let i = 0; i < whitePitches.length; i++) {
      const p = whitePitches[i];
      const x = startX + i * WHITE_W;

      const grp = svgEl("g", {
        class: `${classForPitch(p, "w")} key`,
        "data-pitch": String(p),
        tabindex: interactive ? "0" : "-1",
      });

      grp.appendChild(svgEl("rect", { x, y: startY, width: WHITE_W, height: WHITE_H }));
      if (interactive && typeof onKeyDown === "function") {
        grp.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          onKeyDown(p, grp);
        });
      }
      gW.appendChild(grp);
    }

    // Black keys
    const leftPcByBlack = { 1: 0, 3: 2, 6: 5, 8: 7, 10: 9 };
    for (let p = lo; p <= hi; p++) {
      const pc = pcFromPitch(p);
      if (!ACC_PCS.has(pc)) continue;

      const leftPc = leftPcByBlack[pc];
      if (leftPc == null) continue;

      const oct = octFromPitch(p);
      const leftWhitePitch = pitchFromPcOct(leftPc, oct);

      const wi = whiteIndexByPitch.get(leftWhitePitch);
      if (wi == null) continue;

      const leftX = startX + wi * WHITE_W;
      const x = leftX + WHITE_W - BLACK_W / 2;

      const grp = svgEl("g", {
        class: `${classForPitch(p, "b")} key`,
        "data-pitch": String(p),
        tabindex: interactive ? "0" : "-1",
      });
      grp.appendChild(svgEl("rect", { x, y: startY, width: BLACK_W, height: BLACK_H }));

      if (interactive && typeof onKeyDown === "function") {
        grp.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          onKeyDown(p, grp);
        });
      }
      gB.appendChild(grp);
    }

    return svg;
  }

  function flashKeyGroup(groupEl, ms = 240) {
    if (!groupEl) return;
    groupEl.classList.add("hit");
    window.setTimeout(() => groupEl.classList.remove("hit"), ms);
  }

  function buildPitchHighlightMapForRange({ startPitch, octaves, includeEndC = false, highlightByPitch }) {
    const lo = startPitch;
    const hi = rangeHiPitch(startPitch, octaves, includeEndC);
    if (!highlightByPitch || !highlightByPitch.size) return null;

    const map = new Map();
    for (let p = lo; p <= hi; p++) {
      const c = highlightByPitch.get(p);
      if (c) map.set(p, c);
    }
    return map;
  }

  // -------------------- Game state --------------------
  const state = {
    started: false,
    submitted: false,
    questions: [],
    questionCount: 10,
    createdOn: null,
    createdOnText: "",
  };

  function clampQuestions(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 10;
    return Math.min(12, Math.max(1, Math.round(v)));
  }

  function generateQuestions(count) {
    const target = clampQuestions(count);

    const pool = [];
    for (let rootPc = 0; rootPc < 12; rootPc++) pool.push({ rootPc });

    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const picked = pool.slice(0, target);
    return picked.map((q, idx) => ({
      id: `q${idx + 1}`,
      rootPc: q.rootPc,
      correctPcs: majorScalePcs(q.rootPc),
      selectedPitches: [],
      marks: 0,
    }));
  }

  function resetGameToInitial() {
    stopAllNotes(0.08);

    state.started = false;
    state.submitted = false;
    state.questions = [];
    state.createdOn = null;
    state.createdOnText = "";

    questionsList.innerHTML = "";
    resultsPanel.classList.add("hidden");
    resultsSummary.textContent = "—";

    submitBtn.disabled = true;
    downloadTaskBtn.disabled = true;
    downloadScorecardBtn.disabled = true;
    resetBtn.disabled = true;

    quizMeta.textContent = "—";
    beginModal.classList.remove("hidden");

    updatePageAdvice();
    window.__scalesSendHeight?.();
  }

  function startGame() {
    state.started = true;
    state.submitted = false;
    state.questions = generateQuestions(state.questionCount);

    state.createdOn = new Date();
    state.createdOnText = state.createdOn.toLocaleDateString("en-GB");

    renderQuiz();

    submitBtn.disabled = false;
    downloadTaskBtn.disabled = false;
    downloadScorecardBtn.disabled = true;
    resetBtn.disabled = false;

    beginModal.classList.add("hidden");
    window.__scalesSendHeight?.();
  }

  // -------------------- Begin modal advice --------------------
  function chunkArray(arr, size) {
    const out = [];
    const n = Math.max(1, Math.floor(size));
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function updatePageAdvice() {
    const qCount = clampQuestions(Number(questionCountSelect?.value ?? 10));
    state.questionCount = qCount;

    const pages = Math.ceil(qCount / TASK_Q_PER_PAGE);
    const perPage =
      qCount <= TASK_Q_PER_PAGE
        ? `${qCount} on 1 page`
        : `${TASK_Q_PER_PAGE} per page (last page ${qCount % TASK_Q_PER_PAGE || TASK_Q_PER_PAGE})`;

    if (pageAdvice) {
      pageAdvice.textContent = `Task sheet download printing tip: ${qCount} questions → ${pages} A4 page(s), ${perPage}.`;
    }
  }

  // -------------------- Rendering (Quiz) --------------------
  function clearQuestionAnswer(q) {
    q.selectedPitches = [];
  }

  function questionSelectedPcs(q) {
    return uniquePcsFromPitches(q.selectedPitches);
  }

  function syncSlots(q) {
    // Slots removed; keep for backwards compatibility.
  }

  function renderQuestionKeyboardMount(q, mountEl) {
    const mount = mountEl || $(`${q.id}-kbd-mount`);
    if (!mount) return;

    const startPitch = pitchFromPcOct(0, Q_KBD_START_OCT);

    const highlightByPitch = new Map();
    for (const p of q.selectedPitches || []) highlightByPitch.set(p, "hit");

    const hl = buildPitchHighlightMapForRange({
      startPitch,
      octaves: Q_KBD_OCTAVES,
      includeEndC: Q_KBD_INCLUDE_END_C,
      highlightByPitch,
    });

    mount.innerHTML = "";
    mount.appendChild(
      buildKeyboardSvg({
        startPitch,
        octaves: Q_KBD_OCTAVES,
        includeEndC: Q_KBD_INCLUDE_END_C,
        interactive: !state.submitted,
        ariaLabel: "Question keyboard",
        highlight: hl,
        onKeyDown: async (pitch, groupEl) => {
          if (state.submitted) return;

          await resumeAudioIfNeeded();
          stopAllNotes(0.02);
          await playPitchesWindowed([pitch], 0.7);
          flashKeyGroup(groupEl, 180);

          const pitches = Array.isArray(q.selectedPitches) ? q.selectedPitches.slice() : [];
          const idxPitch = pitches.indexOf(pitch);

          const rootPc = ((q.rootPc % 12) + 12) % 12;

          if (idxPitch >= 0) {
            pitches.splice(idxPitch, 1);
          } else {
            const pc = pcFromPitch(pitch);

            if (pc === rootPc && SCALE_ALLOW_OCTAVE_ROOT) {
              const existingRootCount = pitches.filter((p) => pcFromPitch(p) === rootPc).length;
              if (existingRootCount >= 2) return;
            } else {
              const existingIdx = pitches.findIndex((p) => pcFromPitch(p) === pc);
              if (existingIdx >= 0) pitches.splice(existingIdx, 1);
            }

            if (pitches.length >= SCALE_MAX_SELECTIONS) return;
            pitches.push(pitch);
          }
          pitches.sort((a, b) => a - b);
          q.selectedPitches = pitches;

          syncSlots(q);
          renderQuestionKeyboardMount(q, mount);
        },
      })
    );
  }

  function renderKeyboardInputForQuestion(q, li) {
    const wrap = document.createElement("div");
    wrap.className = "qKbdWrap";

    const mount = document.createElement("div");
    mount.className = "qKbdMount mount";
    mount.id = `${q.id}-kbd-mount`;

    const btnRow = document.createElement("div");
    btnRow.className = "qSlotBtnRow";
    btnRow.id = `${q.id}-kbd-actions`;

    const hearBtn = document.createElement("button");
    hearBtn.type = "button";
    hearBtn.textContent = "Hear selection";
    hearBtn.disabled = state.submitted;
    hearBtn.addEventListener("click", async () => {
      await resumeAudioIfNeeded();
      stopAllNotes(0.02);
      const pitches = (q.selectedPitches || []).slice().sort((a, b) => a - b);
      if (!pitches.length) return;
      await playPitchesWindowed(pitches, 1.8);
    });

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.disabled = state.submitted;
    clearBtn.addEventListener("click", () => {
      if (state.submitted) return;
      clearQuestionAnswer(q);
      syncSlots(q);
      renderQuestionKeyboardMount(q);
    });

    btnRow.appendChild(hearBtn);
    btnRow.appendChild(clearBtn);

    wrap.appendChild(mount);
    wrap.appendChild(btnRow);
    li.appendChild(wrap);

    syncSlots(q);
    renderQuestionKeyboardMount(q, mount);
  }

  function renderQuiz() {
    questionsList.innerHTML = "";

    quizMeta.textContent = `${state.questions.length} question(s)`;

    state.questions.forEach((q, index) => {
      const li = document.createElement("li");
      li.className = "qCard";
      li.dataset.qid = q.id;

      const top = document.createElement("div");
      top.className = "qTop";

      const title = document.createElement("div");
      title.className = "qTitle";
      title.textContent = `${index + 1}. ${scaleName(q.rootPc)} scale`;

      const marks = document.createElement("div");
      marks.className = "qMarks";
      marks.id = `${q.id}-marks`;
      marks.textContent = "0 / 1";

      top.appendChild(title);
      top.appendChild(marks);
      li.appendChild(top);

      renderKeyboardInputForQuestion(q, li);

      const feedback = document.createElement("div");
      feedback.className = "qFeedback hidden";
      feedback.id = `${q.id}-feedback`;
      li.appendChild(feedback);

      questionsList.appendChild(li);
    });

    window.__scalesSendHeight?.();
  }

  // -------------------- Results mini keyboards --------------------
  function makeMiniKeyboardBlock({ title, mountId, btnText, onPlay }) {
    const block = document.createElement("div");
    block.className = "miniKbdBlock";

    const t = document.createElement("div");
    t.className = "miniKbdTitle";
    t.textContent = title;

    const mount = document.createElement("div");
    mount.className = "mount miniMount";
    mount.id = mountId;

    const btnRow = document.createElement("div");
    btnRow.className = "miniBtnRow";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = btnText;
    btn.addEventListener("click", onPlay);
    btnRow.appendChild(btn);

    block.appendChild(t);
    block.appendChild(mount);
    block.appendChild(btnRow);
    return block;
  }

  function renderMiniKeyboardsForQuestion(q) {
    const fb = $(`${q.id}-feedback`);
    if (!fb) return;

    fb.innerHTML = "";
    fb.classList.remove("hidden");

    const row = document.createElement("div");
    row.className = "qFeedbackRow";

    const miniStartPitch = pitchFromPcOct(0, MINI_KBD_START_OCT);

    const correctPcs = q.correctPcs.slice();
    const correctSet = new Set(correctPcs);

    const answeredPitches = (q.selectedPitches || []).slice().sort((a, b) => a - b);
    const answeredPcs = uniquePcsFromPitches(answeredPitches);

    const answeredHighlightByPitch = new Map();
    for (const p of answeredPitches) {
      answeredHighlightByPitch.set(p, correctSet.has(pcFromPitch(p)) ? "ok" : "bad");
    }

    const correctPitches = pcsToAscendingPitchesFromRoot(q.rootPc, correctPcs, 4, true);
    const correctHighlightByPitch = new Map();
    for (const p of correctPitches) correctHighlightByPitch.set(p, "ok");

    const answeredMountId = `${q.id}-mini-answered`;
    const correctMountId = `${q.id}-mini-correct`;

    const answeredBlock = makeMiniKeyboardBlock({
      title: "Your answered notes",
      mountId: answeredMountId,
      btnText: "Play Answered Notes",
      onPlay: async () => {
        if (!answeredPitches.length) return;
        await playPitchesWindowed(answeredPitches, 1.8);
      },
    });

    const correctBlock = makeMiniKeyboardBlock({
      title: "Correct notes",
      mountId: correctMountId,
      btnText: "Play Correct Notes",
      onPlay: async () => {
        await playPitchesWindowed(correctPitches, 1.8);
      },
    });

    row.appendChild(answeredBlock);
    row.appendChild(correctBlock);
    fb.appendChild(row);

    const chosenText = pcsToPretty(relativeSortFromRoot(q.rootPc, answeredPcs));
    const correctText = pcsToPrettyWithOctave(q.rootPc, correctPcs);

    const line = document.createElement("div");
    line.className = "qAnswerLine";
    const okClass = q.marks === 1 ? "ok" : q.marks === 0 ? "bad" : "";
    line.innerHTML = `
      <span class="${okClass}">
        Marks: <strong>${q.marks} / 1</strong>
      </span>
      <br>
      You chose: <strong>${chosenText || "—"}</strong>
      <br>
      Correct: <strong>${correctText}</strong>
    `;
    fb.appendChild(line);

    const answeredMount = $(answeredMountId);
    const correctMount = $(correctMountId);

    if (answeredMount) {
      answeredMount.innerHTML = "";
      answeredMount.appendChild(
        buildKeyboardSvg({
          startPitch: miniStartPitch,
          octaves: MINI_KBD_OCTAVES,
          includeEndC: MINI_KBD_INCLUDE_END_C,
          interactive: false,
          ariaLabel: "Answered notes keyboard",
          highlight: buildPitchHighlightMapForRange({
            startPitch: miniStartPitch,
            octaves: MINI_KBD_OCTAVES,
            includeEndC: MINI_KBD_INCLUDE_END_C,
            highlightByPitch: answeredHighlightByPitch,
          }),
        })
      );
    }

    if (correctMount) {
      correctMount.innerHTML = "";
      correctMount.appendChild(
        buildKeyboardSvg({
          startPitch: miniStartPitch,
          octaves: MINI_KBD_OCTAVES,
          includeEndC: MINI_KBD_INCLUDE_END_C,
          interactive: false,
          ariaLabel: "Correct notes keyboard",
          highlight: buildPitchHighlightMapForRange({
            startPitch: miniStartPitch,
            octaves: MINI_KBD_OCTAVES,
            includeEndC: MINI_KBD_INCLUDE_END_C,
            highlightByPitch: correctHighlightByPitch,
          }),
        })
      );
    }
  }

  // -------------------- Marking --------------------
  function markAll() {
    state.submitted = true;

    submitBtn.disabled = true;

    let total = 0;
    const max = state.questions.length;

    for (const q of state.questions) {
      const correctSet = new Set(q.correctPcs);
      const chosenSet = new Set(uniquePcsFromPitches(q.selectedPitches));

      const isCorrect = q.correctPcs.every((pc) => chosenSet.has(pc)) && chosenSet.size === correctSet.size;
      const marks = isCorrect ? 1 : 0;
      q.marks = marks;
      total += marks;

      const marksEl = $(`${q.id}-marks`);
      if (marksEl) marksEl.textContent = `${marks} / 1`;

      const actions = $(`${q.id}-kbd-actions`);
      if (actions) actions.remove();

      const mount = $(`${q.id}-kbd-mount`);
      if (mount) mount.remove();

      renderMiniKeyboardsForQuestion(q);
    }

    resultsSummary.innerHTML = `
      Total: <strong>${total} / ${max}</strong>
      <br>
      Percentage: <strong>${Math.round((total / max) * 1000) / 10}%</strong>
    `;
    resultsPanel.classList.remove("hidden");

    downloadScorecardBtn.disabled = false;
    window.__scalesSendHeight?.();
  }

  // -------------------- PDF helpers --------------------
  function addCanvasToPdfPageCentered({ canvas, pdf, marginPt }) {
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    const usableW = pageW - marginPt * 2;
    const usableH = pageH - marginPt * 2;

    const scale = Math.min(usableW / canvas.width, usableH / canvas.height);
    const drawW = canvas.width * scale;
    const drawH = canvas.height * scale;

    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;

    const imgData = canvas.toDataURL("image/png");
    pdf.addImage(imgData, "PNG", x, y, drawW, drawH);
  }

  async function renderHtmlPagesToPdf({ hostEl, pages, filename }) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });

    hostEl.innerHTML = "";
    hostEl.classList.remove("hidden");

    for (let i = 0; i < pages.length; i++) {
      hostEl.innerHTML = "";
      hostEl.appendChild(pages[i]);

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const canvas = await window.html2canvas(hostEl, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
      });

      if (i > 0) pdf.addPage("a4", "portrait");
      addCanvasToPdfPageCentered({ canvas, pdf, marginPt: PDF_MARGIN_PT });
    }

    pdf.save(filename);

    hostEl.classList.add("hidden");
    hostEl.innerHTML = "";
  }

  // -------------------- Task sheet PDF (single column, 6 per page, images) --------------------
  function buildTaskSheetPages() {
    const loadedAt = state.createdOnText ? `Created On: ${state.createdOnText}` : "";
    const totalQ = state.questions.length;

    const chunks = chunkArray(state.questions, TASK_Q_PER_PAGE);
    const printStartPitch = pitchFromPcOct(0, TASK_KBD_START_OCT);

    return chunks.map((chunk, pageIndex) => {
      const page = document.createElement("div");
      page.className = "printPage";

      const header = document.createElement("div");
      header.className = "sheetHeader";
      header.innerHTML = `
        <picture>
          <source media="(max-width: 520px)" srcset="images/titlewrapped.png" />
          <img class="sheetHeroImg" src="images/titledownload.png" alt="Major Scales Quiz" />
        </picture>
        <div class="sheetSubtitle">The Major Scale</div>
      `;

      const meta = document.createElement("div");
      meta.className = "sheetMeta";
      meta.textContent = `${loadedAt ? loadedAt + " • " : ""}${totalQ} questions • Page ${pageIndex + 1} / ${chunks.length}`;

      const hint = document.createElement("div");
      hint.className = "sheetHint";
      hint.textContent =
        "Colour in or mark the notes of the scales for each question on the keyboard images — you can place the scale on any octave.";

      const list = document.createElement("ol");
      list.className = "sheetList";

      chunk.forEach((q, localIdx) => {
        const number = pageIndex * TASK_Q_PER_PAGE + localIdx + 1;

        const item = document.createElement("li");
        item.className = "sheetQ";

        const qname = document.createElement("div");
        qname.className = "sheetQName";
        qname.textContent = `${number}. ${scaleName(q.rootPc)} scale`;

        const kbdBox = document.createElement("div");
        kbdBox.className = "sheetKbd";

        const mount = document.createElement("div");
        mount.className = "mount";

        mount.appendChild(
          buildKeyboardSvg({
            startPitch: printStartPitch,
            octaves: TASK_KBD_OCTAVES,
            includeEndC: TASK_KBD_INCLUDE_END_C,
            interactive: false,
            ariaLabel: "Printable keyboard",
            theme: {
              frameFill: "#fff",
              whiteFill: "#fff",
              whiteStroke: "#000",
              blackFill: "#fff",
              blackStroke: "#000",
            },
          })
        );

        kbdBox.appendChild(mount);
        item.appendChild(qname);
        item.appendChild(kbdBox);
        list.appendChild(item);
      });

      page.appendChild(header);
      page.appendChild(meta);
      page.appendChild(hint);
      page.appendChild(list);
      return page;
    });
  }

  async function downloadTaskSheetPdf() {
    if (!state.started || !state.questions.length) return;

    const pages = buildTaskSheetPages();
    const fileStamp = new Date().toISOString().slice(0, 10);
    await renderHtmlPagesToPdf({
      hostEl: taskSheetTemplate,
      pages,
      filename: `Major Scales Task Sheet (${fileStamp}).pdf`,
    });
  }

  // -------------------- Scorecard PDF --------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[c]));
  }

  function buildScorecardPages(playerName, total, max) {
    const loadedAt = state.createdOnText ? `Created On: ${state.createdOnText}` : "";
    const totalQ = state.questions.length;
    const chunks = chunkArray(state.questions, 20);

    return chunks.map((chunk, pageIndex) => {
      const page = document.createElement("div");
      page.className = "printPage";

      const header = document.createElement("div");
      header.className = "sheetHeader";
      header.innerHTML = `
        <picture>
          <source media="(max-width: 520px)" srcset="images/titlewrapped.png" />
          <img class="sheetHeroImg" src="images/title.png" alt="Major Scales Quiz" />
        </picture>
      `;

      const meta = document.createElement("div");
      meta.className = "sheetMeta";
      meta.textContent = `${loadedAt ? loadedAt + " • " : ""}${totalQ} questions • Page ${pageIndex + 1} / ${chunks.length}`;

      page.appendChild(header);
      page.appendChild(meta);

      if (pageIndex === 0) {
        const top = document.createElement("div");
        top.className = "sheetQ";
        top.innerHTML = `
          <div class="sheetQName">Name: ${escapeHtml(playerName)}</div>
          <div style="font-weight:900; text-align:center;">
            Score: ${total} / ${max} (${Math.round((total / max) * 1000) / 10}%)
          </div>
        `;
        page.appendChild(top);
      }

      const list = document.createElement("ol");
      list.className = "sheetList";

      const startIdx = pageIndex * 20;
      chunk.forEach((q, localIdx) => {
        const idx = startIdx + localIdx;

        const item = document.createElement("li");
        item.className = "sheetQ";

        const answeredPcs = uniquePcsFromPitches(q.selectedPitches);
        const chosen = pcsToPretty(relativeSortFromRoot(q.rootPc, answeredPcs));
        const correct = pcsToPrettyWithOctave(q.rootPc, q.correctPcs);

        item.innerHTML = `
          <div class="sheetQName">${idx + 1}. ${scaleName(q.rootPc)} scale — ${q.marks} / 1</div>
          <div style="font-weight:800; font-size:12px; opacity:.9; line-height:1.45; text-align:center;">
            Your answer: <strong>${escapeHtml(chosen || "—")}</strong><br>
            Correct: <strong>${escapeHtml(correct)}</strong>
          </div>
        `;
        list.appendChild(item);
      });

      page.appendChild(list);
      return page;
    });
  }

  async function downloadScorecardPdf() {
    if (!state.submitted) {
      alert("Submit your answers first, then download the scorecard.");
      return;
    }

    const prev = localStorage.getItem("scales_player_name") || "";
    const name = (window.prompt("Enter your name for the scorecard:", prev) ?? "").trim();
    const playerName = name || "Player";
    if (name) localStorage.setItem("scales_player_name", name);

    const total = state.questions.reduce((a, q) => a + (q.marks || 0), 0);
    const max = state.questions.length;

    const pages = buildScorecardPages(playerName, total, max);
    const fileStamp = new Date().toISOString().slice(0, 10);
    await renderHtmlPagesToPdf({
      hostEl: scorecardTemplate,
      pages,
      filename: `Major Scales Scorecard (${playerName}) (${fileStamp}).pdf`,
    });
  }

  // -------------------- Events --------------------
  function bindEvents() {
    questionCountSelect?.addEventListener("change", updatePageAdvice);

    beginBtn.addEventListener("click", async () => {
      await resumeAudioIfNeeded();
      startGame();
    });

    infoBtn.addEventListener("click", () => infoModal.classList.remove("hidden"));
    infoOk.addEventListener("click", () => infoModal.classList.add("hidden"));
    infoModal.addEventListener("click", (e) => {
      if (e.target === infoModal) infoModal.classList.add("hidden");
    });

    downloadTaskBtn.addEventListener("click", downloadTaskSheetPdf);
    downloadScorecardBtn.addEventListener("click", downloadScorecardPdf);

    submitBtn.addEventListener("click", () => {
      if (!state.started || state.submitted) return;
      markAll();
    });

    resetBtn.addEventListener("click", resetGameToInitial);
    resetBtn2.addEventListener("click", resetGameToInitial);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!infoModal.classList.contains("hidden")) infoModal.classList.add("hidden");
      }
    });
  }

  // -------------------- Init --------------------
  function init() {
    setupIframeAutoHeight();
    bindEvents();
    updatePageAdvice();
    resetGameToInitial();
  }

  init();
})();