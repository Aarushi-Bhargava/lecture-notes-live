// Live Lecture Notes
//
// Records a lecture in the browser, transcribes it with the Web Speech API,
// and files the notes under whichever slide is currently showing. Optionally
// sends each chunk of speech to an LLM to condense it into bullet points.
//
// Everything runs client-side: notes and API keys are stored in localStorage.

'use strict';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch (e) {
      return false;
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  },
};

const uid = () => Math.random().toString(36).slice(2, 10);

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );

const fmtT = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return (
    (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) +
    ':' +
    String(s).padStart(2, '0')
  );
};

const wordCount = (s) => (s.trim().match(/\S+/g) || []).length;

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

let toastTimer;

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function setStatus(msg, err = false) {
  const s = $('#status');
  s.textContent = msg || '';
  s.title = msg || '';
  s.classList.toggle('err', !!err);
}

function confirmBox(title, body) {
  return new Promise((res) => {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    const m = $('#confirmModal');
    m.classList.add('open');
    const done = (v) => {
      m.classList.remove('open');
      $('#confirmYes').onclick = $('#confirmNo').onclick = null;
      res(v);
    };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

const safeName = (s) =>
  (s || 'lecture')
    .replace(/[^\w\- .]+/g, '')
    .trim()
    .replace(/\s+/g, '_') || 'lecture';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  groqKey: '',
  groqModel: 'openai/gpt-oss-120b',
  apiKey: '',
  model: 'claude-haiku-5-5',
  live: true,
  course:
    'MTE 241, University of Waterloo Mechatronics Engineering (2B). Expect computer-structures / embedded / real-time systems terminology.',
  chunkWords: 70,
  lang: 'en-CA',
  flush: true,
  audio: true,
};

let settings = Object.assign({}, DEFAULTS, LS.get('lnl.settings', {}));
const PROVIDERS = ['gemini', 'groq', 'claude'];
const PNAME = { gemini: 'Gemini', groq: 'Groq', claude: 'Claude' };

const keyOf = (p) =>
  (p === 'gemini'
    ? settings.geminiKey
    : p === 'groq'
      ? settings.groqKey
      : settings.apiKey || ''
  ).trim();

const aiOn = () => PROVIDERS.some((p) => keyOf(p));

// ---------------------------------------------------------------------------
// Lecture state (slides, notes, transcript) and autosave
// ---------------------------------------------------------------------------

function newSlide(text = '') {
  return { text, bullets: [], transcript: [], done: 0, marks: [] };
}

function newDeck() {
  return {
    id: uid(),
    name: 'Untitled lecture',
    pdfName: '',
    created: Date.now(),
    slides: [newSlide()],
    live: 0,
    view: 0,
    elapsed: 0,
  };
}

let deck = newDeck();
let pdfDoc = null;

function slideHasContent(s) {
  return s.bullets.length || s.transcript.length;
}

function deckHasContent() {
  return deck.slides.some(slideHasContent);
}

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  const ok = LS.set('lnl.session.' + deck.id, Object.assign({}, deck, { elapsed: elapsed() }));
  LS.set('lnl.last', deck.id);
  const idx = LS.get('lnl.index', {});
  idx[deck.id] = { name: deck.name, pdfName: deck.pdfName, t: Date.now() };
  LS.set('lnl.index', idx);
  if (!ok) setStatus('Browser storage is full; use Export → Save session file to be safe', true);
}

// ---------------------------------------------------------------------------
// Recording clock
// ---------------------------------------------------------------------------

let runningSince = null;

function elapsed() {
  return (deck.elapsed || 0) + (runningSince ? (Date.now() - runningSince) / 1000 : 0);
}

function baseElapsed() {
  return deck.elapsed || 0;
}

setInterval(() => {
  $('#timer').textContent = fmtT(elapsed());
}, 500);

// ---------------------------------------------------------------------------
// Speech recognition and audio backup
// ---------------------------------------------------------------------------

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

let rec = null,
  wantRec = false,
  interim = '',
  flushTarget = null,
  restartDelay = 150,
  lastResultAt = 0;

let mediaStream = null,
  mediaRec = null,
  audioChunks = [],
  wakeLock = null;

async function startRecording() {
  if (!SR) {
    setStatus(
      'This browser has no speech recognition. Open the file in Google Chrome or Microsoft Edge.',
      true
    );
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    setStatus(
      'Microphone blocked. Allow mic access for this page in the address bar, then try again.',
      true
    );
    return;
  }
  if (settings.audio && window.MediaRecorder) {
    try {
      if (!mediaRec) {
        mediaRec = new MediaRecorder(mediaStream);
        mediaRec.ondataavailable = (e) => {
          if (e.data && e.data.size) audioChunks.push(e.data);
        };
        mediaRec.start(5000);
      } else if (mediaRec.state === 'paused') {
        mediaRec.resume();
      } else if (mediaRec.state === 'inactive') {
        mediaRec = new MediaRecorder(mediaStream);
        mediaRec.ondataavailable = (e) => {
          if (e.data && e.data.size) audioChunks.push(e.data);
        };
        mediaRec.start(5000);
      }
    } catch (e) {
      console.warn('audio recorder failed', e);
    }
  }
  wantRec = true;
  runningSince = Date.now();
  markLive();
  createRec();
  safeStart();
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
  updateRecUI();
  render();
  setStatus(
    aiOn()
      ? settings.live
        ? 'Listening · AI notes on'
        : 'Listening · AI notes after lecture'
      : 'Listening · sentence-by-sentence notes (add a free key in Settings for AI bullets)'
  );
}

function createRec() {
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = settings.lang;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    lastResultAt = Date.now();
    restartDelay = 150;
    let inter = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) addSegment(r[0].transcript);
      else inter += r[0].transcript;
    }
    interim = inter;
    renderLiveBits();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      wantRec = false;
      stopRecording();
      setStatus(
        'Speech recognition was blocked. Allow the microphone and use Chrome or Edge.',
        true
      );
    } else if (e.error === 'network') {
      setStatus('Speech service unreachable (it needs internet). Retrying…', true);
      restartDelay = Math.min(restartDelay * 2, 5000);
    } else if (e.error === 'audio-capture') {
      setStatus('No microphone found.', true);
    }
    // 'no-speech' and 'aborted' are normal; onend restarts
  };
  rec.onend = () => {
    if (interim.trim()) {
      addSegment(interim);
      interim = '';
      renderLiveBits();
    }
    if (wantRec)
      setTimeout(() => {
        if (wantRec) safeStart();
      }, restartDelay);
  };
}

function safeStart() {
  try {
    rec.start();
  } catch (e) {
    /* already started */
  }
}
// Chrome sometimes goes quiet without firing onend; nudge it.
setInterval(() => {
  if (wantRec && rec && Date.now() - lastResultAt > 45000) {
    lastResultAt = Date.now();
    try {
      rec.stop();
    } catch (e) {}
  }
}, 5000);

function stopRecording() {
  wantRec = false;
  if (rec) {
    try {
      rec.stop();
    } catch (e) {}
  }
  if (runningSince) {
    deck.elapsed = elapsed();
    runningSince = null;
  }
  if (mediaRec && mediaRec.state === 'recording') {
    try {
      mediaRec.pause();
      mediaRec.requestData();
    } catch (e) {}
  }
  try {
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {}
  updateRecUI();
  saveNow();
  render();
  setStatus('Paused');
  setTimeout(aiTick, 600);
}

function updateRecUI() {
  $('#recBtn').classList.toggle('on', wantRec);
  $('#recLabel').textContent = wantRec
    ? 'Pause recording'
    : deckHasContent() || baseElapsed() > 0
      ? 'Resume recording'
      : 'Start recording';
}

function addSegment(text) {
  text = (text || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  let target = deck.live;
  if (flushTarget != null) {
    target = flushTarget;
    flushTarget = null;
  }
  const s = deck.slides[target];
  if (!s) return;
  const seg = { t: Math.max(0, elapsed() - Math.min(8, wordCount(text) * 0.35)), text };
  s.transcript.push(seg);
  if (!aiOn()) {
    s.bullets.push({ id: uid(), text: capFirst(text), level: 0, t: seg.t, src: 'raw' });
    s.done = s.transcript.length;
  }
  save();
  render();
}

const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

window.__addSegment = addSegment; // used for testing

// ---------------------------------------------------------------------------
// AI summarization (Gemini, Groq, Claude) with automatic failover
// ---------------------------------------------------------------------------

let aiBusy = false,
  aiPauseUntil = 0;

const SYSTEM = `You are a fast, accurate note-taker sitting in a live university engineering lecture for a student.
You receive: the text printed on the current slide, the bullet notes already written for this slide, and a NEW excerpt of the professor's speech from live speech recognition.
Speech recognition makes mistakes, especially on technical terms, acronyms, numbers and code. Silently correct obvious mishearings using the slide text and course context. Never invent content the professor did not say.

Write bullet notes for the NEW excerpt only:
- Capture what the professor adds beyond the slide: explanations, reasoning, examples, analogies, numbers, formulas, code, caveats, comparisons, and anything said to be important, tricky, or likely on an exam/assignment.
- Do not repeat bullets already written. Do not restate slide text unless the professor explains or extends it.
- Be concise but complete: a student who missed the lecture should understand. Prefer specific facts over vague summaries.
- Format: one bullet per line starting with "- ". Use "  - " (two spaces) for a sub-point. Use **bold** sparingly for key terms and \`backticks\` for code, registers, or identifiers. Write math in readable Unicode (e.g. U ≤ n(2^(1/n) − 1)), never LaTeX.
- Start a bullet with "⚠ " when the professor flags exam relevance, a common mistake, or says something is important.
- Start a bullet with "📌 " for admin info (deadlines, quiz dates, office hours, assignment details).
- If the excerpt is only filler, small talk or nothing substantive, output exactly: NONE
Output only the bullet lines, nothing else.`;

const SYSTEM_TIDY = `You are rewriting a student's notes for ONE slide of a university engineering lecture into clean, well-organized study notes.
You receive the slide's printed text, the full speech-recognition transcript of what the professor said while this slide was up (contains recognition errors; correct obvious mishearings of technical terms using the slide text and course context), and the student's own notes.
Produce organized bullet notes of everything substantive the professor said: explanations, examples, numbers, formulas, code, caveats, exam hints. Group related points with sub-bullets. Do not just restate the slide; focus on what the professor added, but you may include a slide point briefly when the professor elaborated on it. Never invent content.
Format: "- " bullets, "  - " sub-bullets, **bold** for key terms, \`backticks\` for code, math in readable Unicode (never LaTeX). Prefix "⚠ " for exam hints/common mistakes and "📌 " for admin info.
Do NOT include the student's own notes in your output (they are kept separately); use them only as context.
Output only the bullet lines.`;

const providerCooldown = {}; // provider -> timestamp until which we skip it

let lastProvider = '';

function httpErr(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function readErr(r) {
  let msg = 'HTTP ' + r.status;
  try {
    const j = await r.json();
    const m = (j.error && (j.error.message || j.error)) || j.message;
    if (m) msg = String(m).slice(0, 200);
  } catch (e) {}
  return httpErr(msg, r.status);
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function callProvider(p, system, user, maxTokens) {
  const key = keyOf(p);
  const to = withTimeout(45000);
  try {
    if (p === 'gemini') {
      const model = (settings.geminiModel || 'gemini-flash-latest').trim();
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model) +
          ':generateContent',
        {
          method: 'POST',
          signal: to.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: Math.max(4096, maxTokens * 3) },
          }),
        }
      );
      if (!r.ok) throw await readErr(r);
      const j = await r.json();
      const c = j.candidates && j.candidates[0];
      const txt =
        c &&
        c.content &&
        (c.content.parts || [])
          .filter((x) => !x.thought && x.text)
          .map((x) => x.text)
          .join('\n');
      if (!txt)
        throw httpErr(
          'empty response' + (c && c.finishReason ? ' (' + c.finishReason + ')' : ''),
          0
        );
      return txt;
    }
    if (p === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: to.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: (settings.groqModel || 'openai/gpt-oss-120b').trim(),
          temperature: 0.3,
          max_completion_tokens: Math.max(3000, maxTokens * 2),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!r.ok) throw await readErr(r);
      const j = await r.json();
      const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!txt) throw httpErr('empty response', 0);
      return txt;
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: to.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) throw await readErr(r);
    const j = await r.json();
    return (j.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  } catch (e) {
    if (e.name === 'AbortError') throw httpErr('timed out', 0);
    if (e instanceof TypeError) throw httpErr('network error (offline?)', 0);
    throw e;
  } finally {
    to.done();
  }
}
// Try the preferred provider, then any other provider that has a key.
async function callAI(system, user, maxTokens = 900, opts = {}) {
  const order = [settings.provider]
    .concat(PROVIDERS.filter((p) => p !== settings.provider))
    .filter((p) => keyOf(p));
  if (!order.length) throw httpErr('no API key set', 0);
  let lastErr = null;
  const now = Date.now();
  const usable = opts.ignoreCooldown ? order : order.filter((p) => !(providerCooldown[p] > now));
  for (const p of usable.length ? usable : order) {
    try {
      const out = await callProvider(p, system, user, maxTokens);
      if (lastProvider && lastProvider !== p) toast('AI notes now coming from ' + PNAME[p]);
      lastProvider = p;
      providerCooldown[p] = 0;
      return out;
    } catch (e) {
      e.provider = p;
      lastErr = e;
      const bad = e.status === 401 || e.status === 403 || e.status === 400 || e.status === 404;
      providerCooldown[p] = Date.now() + (bad ? 5 * 60000 : e.status === 429 ? 60000 : 20000);
      console.warn('AI provider failed', p, e.status, e.message);
    }
  }
  throw lastErr;
}

function parseBullets(txt) {
  txt = (txt || '').trim();
  if (!txt || /^NONE\.?$/i.test(txt)) return [];
  const out = [];
  for (const raw of txt.split('\n')) {
    if (!raw.trim() || /^NONE\.?$/i.test(raw.trim())) continue;
    const m = raw.match(/^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) out.push({ level: m[1].replace(/\t/g, '  ').length >= 2 ? 1 : 0, text: m[2].trim() });
    else out.push({ level: 0, text: raw.trim().replace(/^#+\s*/, '') });
  }
  return out.filter((b) => b.text);
}

function slideContextBlock(i) {
  const s = deck.slides[i];
  const slideText = s.text ? s.text.slice(0, 2500) : '(no slide text available)';
  return `Course: ${settings.course}\nLecture: ${deck.name}\nSlide ${i + 1}${pdfDoc ? ' of ' + deck.slides.length : ''} text:\n"""${slideText}"""`;
}

function pendingWords(i) {
  const s = deck.slides[i];
  return s.transcript.slice(s.done).reduce((n, x) => n + wordCount(x.text), 0);
}

async function summarize(i) {
  const s = deck.slides[i];
  const upto = s.transcript.length;
  const from = s.done;
  if (upto <= from) return;
  const chunk = s.transcript
    .slice(from, upto)
    .map((x) => x.text)
    .join(' ');
  const existing =
    s.bullets
      .filter((b) => b.src !== 'manual')
      .slice(-25)
      .map((b) => (b.level ? '  - ' : '- ') + b.text)
      .join('\n') || '(none yet)';
  const user = `${slideContextBlock(i)}\n\nBullets already written for this slide:\n${existing}\n\nNEW speech excerpt:\n"""${chunk}"""`;
  aiBusy = true;
  renderLiveBits();
  try {
    const out = await callAI(SYSTEM, user);
    const t = s.transcript[from].t;
    for (const b of parseBullets(out))
      s.bullets.push({ id: uid(), text: b.text, level: b.level, t, src: 'ai' });
    s.done = Math.max(s.done, upto);
    if (wantRec) setStatus('Listening · AI notes via ' + PNAME[lastProvider]);
    save();
  } catch (e) {
    handleAiError(e);
  } finally {
    aiBusy = false;
    render();
  }
}

function handleAiError(e) {
  const who = e.provider ? PNAME[e.provider] + ': ' : '';
  const hint =
    e.status === 401 || e.status === 403
      ? 'key rejected'
      : e.status === 429
        ? 'free limit reached for now'
        : e.message;
  setStatus(
    'AI unavailable (' +
      who +
      hint +
      '). Speech is still being saved and will be summarized when AI is back.',
    true
  );
  aiPauseUntil = Date.now() + (e.status === 429 ? 30000 : 15000);
}

function aiTick() {
  if (!aiOn() || aiBusy || Date.now() < aiPauseUntil) return;
  if (!settings.live && wantRec) return;
  if (!settings.live) return;
  // Finish off slides we've moved away from first.
  for (let i = 0; i < deck.slides.length; i++) {
    if (i !== deck.live && pendingWords(i) > 0) {
      summarize(i);
      return;
    }
  }
  const s = deck.slides[deck.live];
  const w = pendingWords(deck.live);
  if (!w) return;
  const oldest = s.transcript[s.done];
  const age = elapsed() - (oldest ? oldest.t : elapsed());
  if (w >= settings.chunkWords || (w >= 12 && age >= 35) || !wantRec) summarize(deck.live);
}

setInterval(aiTick, 2500);

async function tidySlide(i) {
  if (!aiOn()) {
    toast('Add a free Gemini or Groq key in Settings to use AI notes.');
    openSettings();
    return;
  }
  const s = deck.slides[i];
  if (!s.transcript.length) {
    toast('Nothing was transcribed on this slide yet.');
    return;
  }
  if (aiBusy) {
    toast('AI is busy, try again in a second.');
    return;
  }
  const transcript = s.transcript.map((x) => `[${fmtT(x.t)}] ${x.text}`).join('\n');
  const mine =
    s.bullets
      .filter((b) => b.src === 'manual')
      .map((b) => '- ' + b.text)
      .join('\n') || '(none)';
  const user = `${slideContextBlock(i)}\n\nFull transcript while this slide was up:\n"""${transcript.slice(-16000)}"""\n\nStudent's own notes:\n${mine}`;
  aiBusy = true;
  $('#rewriteBtn').disabled = true;
  $('#rewriteBtn').textContent = 'Tidying…';
  try {
    const out = await callAI(SYSTEM_TIDY, user, 2000, { ignoreCooldown: true });
    const parsed = parseBullets(out);
    if (!parsed.length) {
      toast('The AI found nothing substantive on this slide.');
      return;
    }
    const t0 = s.transcript[0].t;
    const manual = s.bullets.filter((b) => b.src === 'manual');
    s.bullets = parsed
      .map((b) => ({ id: uid(), text: b.text, level: b.level, t: t0, src: 'ai' }))
      .concat(manual);
    s.done = s.transcript.length;
    save();
    toast('Slide ' + (i + 1) + ' tidied');
  } catch (e) {
    handleAiError(e);
  } finally {
    aiBusy = false;
    $('#rewriteBtn').disabled = false;
    $('#rewriteBtn').textContent = '✨ Tidy this slide';
    render();
  }
}

// ---------------------------------------------------------------------------
// Slide navigation and rendering
// ---------------------------------------------------------------------------

function markLive() {
  if (wantRec || runningSince) {
    const s = deck.slides[deck.live];
    const t = Math.round(elapsed());
    if (!s.marks.length || Math.abs(s.marks[s.marks.length - 1] - t) > 2) s.marks.push(t);
  }
}

function setLive(i) {
  i = Math.max(0, Math.min(deck.slides.length - 1, i));
  if (i === deck.live) {
    deck.view = i;
    render();
    return;
  }
  const old = deck.live;
  if (wantRec && settings.flush && interim.trim() && rec) {
    flushTarget = old;
    try {
      rec.stop();
    } catch (e) {}
  }
  deck.live = i;
  deck.view = i;
  markLive();
  save();
  render();
  setTimeout(aiTick, 300);
}

function step(d) {
  if (!pdfDoc && d > 0 && deck.live === deck.slides.length - 1) {
    deck.slides.push(newSlide());
    renderThumbs();
  }
  setLive(deck.live + d);
}

function peek(i) {
  if (wantRec) {
    deck.view = i;
    render();
  } else setLive(i);
}

let renderTask = null,
  renderSeq = 0;

async function renderStage() {
  const canvas = $('#slideCanvas'),
    ph = $('#placeholder'),
    stage = $('#stage');
  if (!pdfDoc) {
    canvas.style.display = 'none';
    ph.style.display = '';
    if (deckHasContent() || wantRec || deck.slides.length > 1) {
      $('#phTitle').textContent = 'Section ' + (deck.view + 1);
      $('#phBody').innerHTML = deck.pdfName
        ? 'Re-upload <b>' +
          esc(deck.pdfName) +
          '</b> to see the slides again. Your notes stay matched by slide number.'
        : 'No slides loaded. <b>Next</b> starts a new section. Drop a PDF here any time; notes so far get matched to slides by number.';
    }
    return;
  }
  ph.style.display = 'none';
  canvas.style.display = 'block';
  const seq = ++renderSeq;
  const page = await pdfDoc.getPage(deck.view + 1);
  if (seq !== renderSeq) return;
  const vp1 = page.getViewport({ scale: 1 });
  const maxW = stage.clientWidth - 24,
    maxH = stage.clientHeight - 24;
  const scale = Math.max(0.1, Math.min(maxW / vp1.width, maxH / vp1.height));
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * dpr });
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch (e) {}
  }
  const off = document.createElement('canvas');
  off.width = vp.width;
  off.height = vp.height;
  renderTask = page.render({ canvasContext: off.getContext('2d'), viewport: vp });
  try {
    await renderTask.promise;
  } catch (e) {
    return;
  }
  if (seq !== renderSeq) return;
  canvas.width = vp.width;
  canvas.height = vp.height;
  canvas.style.width = vp.width / dpr + 'px';
  canvas.style.height = vp.height / dpr + 'px';
  canvas.getContext('2d').drawImage(off, 0, 0);
}

let thumbCanvases = [];

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.innerHTML = '';
  thumbCanvases = [];
  deck.slides.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.dataset.i = i;
    if (pdfDoc) {
      const c = document.createElement('canvas');
      d.appendChild(c);
      thumbCanvases[i] = c;
    } else {
      const b = document.createElement('div');
      b.className = 'blank';
      b.textContent = 'Section ' + (i + 1);
      d.appendChild(b);
    }
    d.insertAdjacentHTML(
      'beforeend',
      `<span class="num">${i + 1}</span><span class="cnt" style="display:none"></span>`
    );
    d.onclick = () => peek(i);
    d.ondblclick = () => setLive(i);
    wrap.appendChild(d);
  });
  if (pdfDoc) drawThumbs();
  updateThumbState();
}

async function drawThumbs() {
  const doc = pdfDoc;
  for (let i = 0; i < thumbCanvases.length; i++) {
    if (doc !== pdfDoc) return;
    const c = thumbCanvases[i];
    if (!c) continue;
    const page = await doc.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 210 / vp1.width });
    c.width = vp.width;
    c.height = vp.height;
    try {
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    } catch (e) {}
  }
}

function updateThumbState() {
  document.querySelectorAll('.thumb').forEach((d) => {
    const i = +d.dataset.i,
      s = deck.slides[i];
    d.classList.toggle('live', i === deck.live && (wantRec || runningSince != null));
    d.classList.toggle('view', i === deck.view);
    const n = s ? s.bullets.length : 0;
    const c = d.querySelector('.cnt');
    c.style.display = n ? '' : 'none';
    c.textContent = n;
  });
  const cur = document.querySelector('.thumb.view');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------------------
// Notes panel
// ---------------------------------------------------------------------------

function render() {
  $('#deckName').textContent !== deck.name &&
    document.activeElement !== $('#deckName') &&
    ($('#deckName').textContent = deck.name);
  const total = deck.slides.length,
    kind = pdfDoc ? 'Slide' : 'Section';
  const tag = wantRec ? '<span class="livetag">LIVE</span>' : '';
  $('#slideLabel').innerHTML = `${kind} ${deck.live + 1}${pdfDoc ? ' / ' + total : ''}${tag}`;
  $('#prevBtn').disabled = deck.live === 0;
  $('#nextBtn').disabled = !!pdfDoc && deck.live === total - 1;
  $('#nextBtn').textContent = !pdfDoc && deck.live === total - 1 ? 'New section ▶' : 'Next ▶';
  const peeking = deck.view !== deck.live;
  $('#viewBanner').classList.toggle('show', peeking);
  if (peeking)
    $('#viewBannerText').innerHTML =
      `Peeking at ${kind.toLowerCase()} <b>${deck.view + 1}</b>. Live notes are still going to ${kind.toLowerCase()} <b>${deck.live + 1}</b>.`;
  $('#notesTitle').innerHTML =
    `${kind} ${deck.view + 1} notes${deck.view === deck.live && wantRec ? ' <span class="livetag">LIVE</span>' : ''}`;
  $('#rewriteBtn').style.display = aiOn() ? '' : 'none';
  renderBullets();
  renderLiveBits();
  renderStage();
  updateThumbState();
  updateRecUI();
}

function renderBullets() {
  const s = deck.slides[deck.view];
  const ul = $('#bullets');
  const atBottom = (() => {
    const sc = $('#notesScroll');
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
  })();
  ul.innerHTML = s.bullets
    .map(
      (b, k) => `
    <li class="l${b.level || 0} ${b.src}" data-k="${k}">
      <span class="mark">${b.src === 'manual' ? '★' : b.level ? '◦' : '•'}</span>
      <span class="txt" title="Click to edit">${inlineMd(b.text)}</span>
      <span class="ts" title="Time into the lecture recording">${fmtT(b.t)}</span>
      <span class="acts">
        <button data-a="prev" title="Move to previous slide" ${deck.view === 0 ? 'disabled' : ''}>←</button>
        <button data-a="next" title="Move to next slide" ${deck.view === deck.slides.length - 1 ? 'disabled' : ''}>→</button>
        <button data-a="del" title="Delete">✕</button>
      </span>
    </li>`
    )
    .join('');
  const empty = $('#emptyNotes');
  if (!s.bullets.length && !s.transcript.slice(s.done).length) {
    empty.textContent = wantRec
      ? deck.view === deck.live
        ? 'Listening… notes will appear here as the professor talks.'
        : 'No notes on this slide.'
      : 'No notes yet for this slide.';
  } else empty.textContent = '';
  const tr = s.transcript.map((x) => `[${fmtT(x.t)}] ${x.text}`).join('\n');
  $('#transcriptText').textContent = tr || '(nothing transcribed on this slide)';
  if (atBottom) {
    const sc = $('#notesScroll');
    sc.scrollTop = sc.scrollHeight;
  }
}

function renderLiveBits() {
  const s = deck.slides[deck.view];
  const pend = aiOn()
    ? s.transcript
        .slice(s.done)
        .map((x) => x.text)
        .join(' ')
    : '';
  $('#pending').textContent = pend ? pend + (aiBusy ? '' : '') : '';
  $('#interim').textContent = deck.view === deck.live && wantRec && interim ? interim : '';
  const sc = $('#notesScroll');
  if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120) sc.scrollTop = sc.scrollHeight;
}

$('#bullets').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const k = +li.dataset.k,
    s = deck.slides[deck.view];
  const a = e.target.closest('button') && e.target.closest('button').dataset.a;
  if (a === 'del') {
    s.bullets.splice(k, 1);
    save();
    render();
    return;
  }
  if (a === 'prev' || a === 'next') {
    const to = deck.view + (a === 'prev' ? -1 : 1);
    const [b] = s.bullets.splice(k, 1);
    const dest = deck.slides[to].bullets;
    if (a === 'prev') dest.push(b);
    else dest.unshift(b);
    save();
    render();
    toast('Moved to ' + (pdfDoc ? 'slide ' : 'section ') + (to + 1));
    return;
  }
  const txt = e.target.closest('.txt');
  if (txt && txt.contentEditable !== 'true') {
    txt.contentEditable = 'true';
    txt.textContent = s.bullets[k].text;
    txt.focus();
    const range = document.createRange();
    range.selectNodeContents(txt);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = () => {
      txt.onblur = null;
      const v = txt.textContent.trim();
      if (v) s.bullets[k].text = v;
      else s.bullets.splice(k, 1);
      save();
      render();
    };
    txt.onblur = finish;
    txt.onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        txt.blur();
      }
      if (ev.key === 'Escape') {
        txt.onblur = null;
        render();
      }
    };
  }
});

$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#manualInput').value.trim();
  if (!v) return;
  deck.slides[deck.view].bullets.push({
    id: uid(),
    text: v,
    level: 0,
    t: elapsed(),
    src: 'manual',
  });
  $('#manualInput').value = '';
  save();
  render();
});

$('#rewriteBtn').onclick = () => tidySlide(deck.view);

// ---------------------------------------------------------------------------
// PDF loading
// ---------------------------------------------------------------------------

if (window.pdfjsLib)
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function loadPdf(file) {
  if (!window.pdfjsLib) {
    setStatus('Could not load the PDF viewer (needs internet the first time).', true);
    return;
  }
  setStatus('Loading slides…');
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) {
    setStatus('That file could not be opened as a PDF.', true);
    return;
  }
  const n = doc.numPages;
  const texts = [];
  for (let i = 1; i <= n; i++) {
    try {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      texts.push(
        tc.items
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      );
    } catch (e) {
      texts.push('');
    }
  }
  // Decide what happens to existing notes.
  if (deck.pdfName && deck.pdfName !== file.name && deckHasContent() && !wantRec) {
    // A different lecture: look for an earlier session with this PDF, else start fresh.
    saveNow();
    const idx = LS.get('lnl.index', {});
    const match = Object.entries(idx)
      .filter(([id, v]) => v.pdfName === file.name)
      .sort((a, b) => b[1].t - a[1].t)[0];
    const prev = match && LS.get('lnl.session.' + match[0], null);
    deck = prev || newDeck();
    if (prev) toast('Reopened your earlier notes for ' + file.name);
  } else if (!deck.pdfName && !deckHasContent()) {
    const idx = LS.get('lnl.index', {});
    const match = Object.entries(idx)
      .filter(([id, v]) => v.pdfName === file.name && id !== deck.id)
      .sort((a, b) => b[1].t - a[1].t)[0];
    const prev = match && LS.get('lnl.session.' + match[0], null);
    if (prev && prev.slides.some(slideHasContent)) {
      const ok = await confirmBox(
        'Reopen earlier notes?',
        'You already have notes for ' +
          file.name +
          ' from ' +
          new Date(match[1].t).toLocaleString() +
          '. Reopen them? (Cancel starts a fresh set of notes.)'
      );
      if (ok) deck = prev;
    }
  }
  pdfDoc = doc;
  if (!deck.pdfName || deck.name === 'Untitled lecture')
    deck.name = file.name.replace(/\.pdf$/i, '');
  deck.pdfName = file.name;
  // Map existing slides/sections onto pages by number.
  const slides = [];
  for (let i = 0; i < Math.max(n, deck.slides.length); i++) {
    const s = deck.slides[i] || newSlide();
    if (i < n) s.text = texts[i];
    slides.push(s);
  }
  // Notes beyond the last page get folded into the last page.
  while (slides.length > n) {
    const extra = slides.pop();
    const last = slides[n - 1];
    last.bullets.push(...extra.bullets);
    last.transcript.push(...extra.transcript.slice(extra.done));
    if (extra.done)
      (last.transcript.splice(last.done, 0, ...extra.transcript.slice(0, extra.done)),
        (last.done += extra.done));
  }
  deck.slides = slides;
  deck.live = Math.min(deck.live, n - 1);
  deck.view = Math.min(deck.view, n - 1);
  $('#restoreBanner').classList.remove('show');
  saveNow();
  renderThumbs();
  render();
  setStatus(
    wantRec ? 'Listening' : n + ' slides loaded. Hit Start recording when the lecture begins.'
  );
}

$('#pdfInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadPdf(f);
  e.target.value = '';
});

const stage = $('#stage');

['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    stage.classList.add('drag');
  })
);

['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === document.documentElement) stage.classList.remove('drag');
  })
);

document.addEventListener('drop', (e) => {
  const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].find(
    (f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)
  );
  if (f) loadPdf(f);
  else if (e.dataTransfer && e.dataTransfer.files.length)
    toast('Please drop a PDF. Export PowerPoint/Keynote decks to PDF first.');
});

// ---------------------------------------------------------------------------
// Export and session files
// ---------------------------------------------------------------------------

function bulletsMd(s) {
  return s.bullets
    .map((b) => (b.level ? '  - ' : '- ') + (b.src === 'manual' ? '★ ' : '') + b.text)
    .join('\n');
}

function notesMarkdown(includeTranscript) {
  const kind = pdfDoc || deck.pdfName ? 'Slide' : 'Section';
  let md = `# ${deck.name}\n\n_${new Date(deck.created).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}_\n\n`;
  deck.slides.forEach((s, i) => {
    if (!slideHasContent(s) && !includeTranscript) {
      md += `## ${kind} ${i + 1}\n\n_(no notes)_\n\n`;
      return;
    }
    const when = s.marks.length ? ` · ${s.marks.map(fmtT).join(', ')}` : '';
    md += `## ${kind} ${i + 1}${when}\n\n`;
    if (s.text) md += `> ${s.text.slice(0, 300)}${s.text.length > 300 ? '…' : ''}\n\n`;
    const pend = aiOn()
      ? s.transcript
          .slice(s.done)
          .map((x) => x.text)
          .join(' ')
      : '';
    md += (bulletsMd(s) || '_(no notes)_') + '\n';
    if (pend) md += `- _(not yet summarized)_ ${pend}\n`;
    if (includeTranscript && s.transcript.length)
      md += `\n<details><summary>Transcript</summary>\n\n${s.transcript.map((x) => `[${fmtT(x.t)}] ${x.text}`).join('  \n')}\n\n</details>\n`;
    md += '\n';
  });
  return md;
}

async function exportPrintable() {
  const w = window.open('', '_blank');
  if (!w) {
    toast('Pop-up blocked. Allow pop-ups for this page and try again.');
    return;
  }
  w.document.write('<p style="font:16px system-ui;padding:30px">Preparing printable notes…</p>');
  const kind = pdfDoc ? 'Slide' : 'Section';
  const parts = [];
  for (let i = 0; i < deck.slides.length; i++) {
    const s = deck.slides[i];
    let img = '';
    if (pdfDoc) {
      const page = await pdfDoc.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 1100 / vp1.width });
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      img = `<img src="${c.toDataURL('image/jpeg', 0.82)}">`;
    }
    const pend = aiOn()
      ? s.transcript
          .slice(s.done)
          .map((x) => x.text)
          .join(' ')
      : '';
    const lis =
      s.bullets
        .map(
          (b) =>
            `<li class="${b.level ? 'sub' : ''} ${b.src}">${b.src === 'manual' ? '★ ' : ''}${inlineMd(b.text)}</li>`
        )
        .join('') + (pend ? `<li class="pend">${esc(pend)}</li>` : '');
    parts.push(
      `<section><h2>${kind} ${i + 1}</h2>${img}<ul>${lis || '<li class="none">No notes</li>'}</ul></section>`
    );
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(deck.name)} notes</title><style>
    body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 20px}
    h1{font-size:24px;margin:0 0 4px} .date{color:#666;margin-bottom:20px}
    section{break-inside:avoid-page;page-break-inside:avoid;border-top:1px solid #ddd;padding:14px 0}
    h2{font-size:16px;margin:0 0 8px;color:#2f5bd3} img{width:100%;border:1px solid #ddd;border-radius:6px}
    ul{margin:10px 0 0;padding-left:20px} li.sub{margin-left:22px;list-style:circle} li.manual{color:#2f5bd3} li.none,li.pend{color:#888;font-style:italic}
    code{background:#f1efe9;border-radius:3px;padding:0 3px} .bar{position:sticky;top:0;background:#fff;padding:8px 0;text-align:right}
    @media print{.bar{display:none} body{margin:0 auto}}
    </style></head><body><div class="bar"><button onclick="print()">Print / Save as PDF</button></div>
    <h1>${esc(deck.name)}</h1><div class="date">${new Date(deck.created).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    ${parts.join('')}</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

$('#menuBtn').onclick = (e) => {
  e.stopPropagation();
  $('#menu').classList.toggle('open');
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menuwrap')) $('#menu').classList.remove('open');
});

$('#menu').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#menu').classList.remove('open');
  const act = b.dataset.act;
  if (act === 'md')
    downloadBlob(
      new Blob([notesMarkdown(true)], { type: 'text/markdown' }),
      safeName(deck.name) + '_notes.md'
    );
  if (act === 'print') exportPrintable();
  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(notesMarkdown(false));
      toast('Notes copied');
    } catch (err) {
      toast('Copy was blocked by the browser');
    }
  }
  if (act === 'audio') {
    if (!audioChunks.length) {
      toast(
        settings.audio
          ? 'No audio recorded in this tab yet.'
          : 'Audio recording is off (see Settings).'
      );
      return;
    }
    if (mediaRec && mediaRec.state === 'recording') {
      try {
        mediaRec.requestData();
      } catch (err) {}
      await new Promise((r) => setTimeout(r, 300));
    }
    downloadBlob(
      new Blob(audioChunks, { type: audioChunks[0].type || 'audio/webm' }),
      safeName(deck.name) + '_audio.webm'
    );
  }
  if (act === 'save') {
    downloadBlob(
      new Blob([JSON.stringify(Object.assign({}, deck, { elapsed: elapsed() }), null, 1)], {
        type: 'application/json',
      }),
      safeName(deck.name) + '_session.json'
    );
  }
  if (act === 'new') {
    if (wantRec) {
      toast('Pause recording first.');
      return;
    }
    if (
      deckHasContent() &&
      !(await confirmBox(
        'Start a new lecture?',
        'Your current notes stay saved in this browser and reopen if you upload the same PDF again. Download them first if you want a copy.'
      ))
    )
      return;
    saveNow();
    deck = newDeck();
    pdfDoc = null;
    audioChunks = [];
    mediaRec = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    $('#phTitle').textContent = 'Drop the lecture PDF here';
    $('#phBody').innerHTML =
      'Or use <b>Upload slides</b>. No slides? Just hit <b>Start recording</b>; notes go into numbered sections and <b>Next</b> starts a new one.<br><br>PowerPoint deck? Export it to PDF first.';
    saveNow();
    renderThumbs();
    render();
    setStatus('');
  }
});

$('#sessionInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  $('#menu').classList.remove('open');
  if (!f) return;
  if (wantRec) {
    toast('Pause recording first.');
    return;
  }
  try {
    const d = JSON.parse(await f.text());
    if (!d || !Array.isArray(d.slides)) throw 0;
    saveNow();
    deck = Object.assign(newDeck(), d);
    pdfDoc = null;
    deck.live = 0;
    deck.view = 0;
    deck.slides.forEach((s) => {
      s.marks = s.marks || [];
      s.done = s.done || 0;
      s.bullets = s.bullets || [];
      s.transcript = s.transcript || [];
    });
    saveNow();
    renderThumbs();
    render();
    setStatus(
      deck.pdfName
        ? 'Session opened. Upload ' + deck.pdfName + ' to see the slides.'
        : 'Session opened.'
    );
  } catch (err) {
    toast('That is not a session file from this tool.');
  }
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function openSettings() {
  $('#sProvider').value = settings.provider;
  $('#sGemKey').value = settings.geminiKey;
  $('#sGemModel').value = settings.geminiModel;
  $('#sGroqKey').value = settings.groqKey;
  $('#sGroqModel').value = settings.groqModel;
  $('#testAiOut').textContent = '';
  $('#sKey').value = settings.apiKey;
  $('#sModel').value = settings.model;
  $('#sLive').checked = settings.live;
  $('#sCourse').value = settings.course;
  $('#sChunk').value = settings.chunkWords;
  $('#sLang').value = settings.lang;
  $('#sFlush').checked = settings.flush;
  $('#sAudio').checked = settings.audio;
  $('#settingsModal').classList.add('open');
}

$('#settingsBtn').onclick = openSettings;

function readKeyFields() {
  settings.provider = $('#sProvider').value;
  settings.geminiKey = $('#sGemKey').value.trim();
  settings.geminiModel = $('#sGemModel').value.trim() || DEFAULTS.geminiModel;
  settings.groqKey = $('#sGroqKey').value.trim();
  settings.groqModel = $('#sGroqModel').value.trim() || DEFAULTS.groqModel;
  settings.apiKey = $('#sKey').value.trim();
  settings.model = $('#sModel').value;
}

$('#testAiBtn').onclick = async () => {
  const saved = Object.assign({}, settings);
  readKeyFields();
  const out = $('#testAiOut');
  const res = [];
  for (const p of PROVIDERS) {
    if (!keyOf(p)) continue;
    out.textContent = 'Testing ' + PNAME[p] + '…';
    try {
      await callProvider(p, 'Reply with the single word OK.', 'Say OK.', 50);
      res.push(PNAME[p] + ' ✓');
    } catch (e) {
      res.push(
        PNAME[p] +
          ' ✗ (' +
          (e.status === 401 || e.status === 403 ? 'key rejected' : e.message) +
          ')'
      );
    }
  }
  Object.assign(settings, saved);
  out.textContent = res.length ? res.join('   ') : 'Enter at least one key first.';
};

$('#settingsCancel').onclick = () => $('#settingsModal').classList.remove('open');

$('#settingsSave').onclick = () => {
  const hadAi = aiOn();
  readKeyFields();
  settings.live = $('#sLive').checked;
  settings.course = $('#sCourse').value.trim();
  settings.chunkWords = Math.max(25, Math.min(400, +$('#sChunk').value || 70));
  const langChanged = settings.lang !== $('#sLang').value;
  settings.lang = $('#sLang').value;
  settings.flush = $('#sFlush').checked;
  settings.audio = $('#sAudio').checked;
  LS.set('lnl.settings', settings);
  $('#settingsModal').classList.remove('open');
  if (hadAi && !aiOn()) {
    // AI turned off: turn any unsummarized speech into plain bullets so nothing is hidden.
    deck.slides.forEach((s) => {
      s.transcript
        .slice(s.done)
        .forEach((x) =>
          s.bullets.push({ id: uid(), text: capFirst(x.text), level: 0, t: x.t, src: 'raw' })
        );
      s.done = s.transcript.length;
    });
    save();
  }
  aiPauseUntil = 0;
  if (langChanged && wantRec && rec) {
    try {
      rec.onend = null;
      rec.abort();
    } catch (e) {}
    createRec();
    safeStart();
  }
  render();
  toast('Settings saved');
};

// ---------------------------------------------------------------------------
// Buttons and keyboard shortcuts
// ---------------------------------------------------------------------------

$('#recBtn').onclick = () => (wantRec ? stopRecording() : startRecording());

$('#prevBtn').onclick = () => step(-1);

$('#nextBtn').onclick = () => step(1);

$('#backLiveBtn').onclick = () => {
  deck.view = deck.live;
  render();
};

$('#makeLiveBtn').onclick = () => setLive(deck.view);

$('#deckName').addEventListener('input', () => {
  deck.name = $('#deckName').textContent.trim() || 'Untitled lecture';
  save();
});

$('#deckName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.closest && t.closest('input,textarea,select,[contenteditable=true]')) return;
  if ($('.modal.open')) return;
  if (['ArrowRight', 'PageDown'].includes(e.key)) {
    e.preventDefault();
    step(1);
  }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) {
    e.preventDefault();
    step(-1);
  }
});

let resizeT;

window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(renderStage, 120);
});

window.addEventListener('beforeunload', (e) => {
  saveNow();
  if (wantRec || audioChunks.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(function init() {
  // Every page load starts a clean lecture. The previous one stays saved and can be reopened.
  const lastId = LS.get('lnl.last', null);
  const last = lastId && LS.get('lnl.session.' + lastId, null);
  if (last && Array.isArray(last.slides) && last.slides.some(slideHasContent)) {
    const n = last.slides.reduce((k, x) => k + x.bullets.length, 0);
    const when = new Date((LS.get('lnl.index', {})[lastId] || {}).t || last.created).toLocaleString(
      undefined,
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    );
    $('#restoreText').innerHTML =
      `Previous lecture <b>${esc(last.name)}</b> (${n} note${n === 1 ? '' : 's'}, ${when}) is saved.`;
    $('#restoreBanner').classList.add('show');
    const hide = () => $('#restoreBanner').classList.remove('show');
    $('#restoreDismiss').onclick = hide;
    $('#restoreBtn').onclick = () => {
      if (wantRec || deckHasContent()) {
        toast('Pause and start a new lecture first; this one has notes.');
        return;
      }
      deck = Object.assign(newDeck(), last);
      deck.view = deck.live;
      pdfDoc = null;
      hide();
      renderThumbs();
      render();
      setStatus(
        deck.pdfName
          ? 'Reopened. Upload ' + deck.pdfName + ' to see the slides again.'
          : 'Reopened your previous notes.'
      );
    };
    // Hide the offer once a new lecture actually starts.
    const origStart = startRecording;
    startRecording = async function () {
      hide();
      return origStart.apply(this, arguments);
    };
  }
  if (!SR) setStatus('Speech recognition needs Google Chrome or Microsoft Edge.', true);
  renderThumbs();
  render();
})();
