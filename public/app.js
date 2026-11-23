// Untangle — browser app. Listens, spots cues, runs the mediation, remembers what it learns.
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ store */
const STORE_KEY = "untangle.v1";
const DEFAULT_WAKE = "I don't understand";
const BUILTIN = ["what do you mean", "that's not what I said", "that's not what I meant", "you're not listening", "you lost me", "I'm confused", "that makes no sense", "you're missing the point"];
const TONE_ID = "tone";

const mkCue = (phrase, source) => ({ phrase, source, enabled: true, hits: 0, helpful: 0, falseAlarms: 0 });
function defaults() {
  return {
    names: ["", ""], pitches: [null, null], onboarded: false, voice: true, mic: true, resolved: 0,
    cues: [mkCue(DEFAULT_WAKE, "wake"), ...BUILTIN.map((p) => mkCue(p, "builtin")), { ...mkCue("Raised voice", TONE_ID) }],
  };
}
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.cues) && saved.cues.some((c) => c.source === "wake")) return { ...defaults(), ...saved };
  } catch { /* corrupted storage — start fresh */ }
  return defaults();
}
let S = load();
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* storage full or blocked */ } };
const wakeCue = () => S.cues.find((c) => c.source === "wake");

/* --------------------------------------------------------------- matching */
const norm = (t) => " " + t.toLowerCase().replace(/[’'`]/g, "")
  .replace(/\bdo not\b/g, "dont").replace(/\bi am\b/g, "im").replace(/\byou are\b/g, "youre").replace(/\bthat is\b/g, "thats").replace(/\bcannot\b/g, "cant")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
function detectCue(text, wakeOnly) {
  const t = norm(text);
  const pool = S.cues.filter((c) => c.source !== TONE_ID && c.enabled && (!wakeOnly || c.source === "wake"));
  pool.sort((a, b) => (b.source === "wake") - (a.source === "wake") || b.phrase.length - a.phrase.length);
  return pool.find((c) => norm(c.phrase).trim() && t.includes(norm(c.phrase))) || null;
}
const confidence = (c) => (c.helpful + 1) / (c.helpful + c.falseAlarms + 2);

/* ------------------------------------------------------------------ sound */
const Sound = {
  ctx: null,
  ensure() {
    if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); }
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  note(freq, at, dur, gain = 0.12, type = "sine") {
    const c = this.ensure(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  },
  signal() { this.note(659.3, 0, 0.35, 0.13, "triangle"); this.note(880, 0.14, 0.5, 0.11, "triangle"); },
  resolved() { [523.3, 659.3, 784, 1046.5].forEach((f, i) => this.note(f, i * 0.11, 0.6, 0.09, "triangle")); },
  // Soft wind chimes: a pentatonic scatter of long, glassy tones.
  chimes() {
    const scale = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3];
    let t = 0;
    for (let i = 0; i < 9; i++) {
      const f = scale[Math.floor(Math.random() * scale.length)];
      this.note(f, t, 2.4, 0.055); this.note(f * 2.76, t, 0.9, 0.012);
      t += 0.12 + Math.random() * 0.3;
    }
  },
};

/* ------------------------------------------------------------------ stage */
const Stage = (() => {
  const paths = { clean: $("#pathClean"), knot: $("#pathKnot") };
  const token = $("#token"), helper = $("#helper"), sparkles = $("#sparkles");
  const buddies = [$("#buddy0"), $("#buddy1")], bubbles = [$("#bubble0"), $("#bubble1")];
  let st = { mode: "idle", from: 0, meant: "🍎", heard: "🍊" }, t0 = performance.now(), arrived = false, idleTimer;

  function bubble(i, emoji, mark) {
    const b = bubbles[i];
    if (!emoji) return b.classList.remove("show");
    $(".bubble-emoji", b).textContent = emoji; $(".bubble-mark", b).textContent = mark || "";
    if (!b.classList.contains("show")) { b.classList.remove("pop"); void b.getBoundingClientRect(); b.classList.add("show", "pop"); }
  }
  function set(next) {
    st = { ...st, ...next }; t0 = performance.now(); arrived = false; clearTimeout(idleTimer);
    document.body.dataset.stage = st.mode;
    const to = 1 - st.from;
    buddies.forEach((b, i) => {
      b.classList.toggle("confused", st.mode === "tangled" && i === to);
      b.classList.toggle("happy", st.mode === "resolved");
      b.classList.toggle("addressed", st.mode === "tangled" && i === st.from);
    });
    bubble(to, null);
    bubble(st.from, st.mode === "idle" ? null : st.meant, "");
    token.classList.toggle("show", st.mode !== "idle");
    if (st.mode === "resolved") { burst(); idleTimer = setTimeout(() => set({ mode: "idle" }), 9000); }
  }
  function burst() {
    sparkles.replaceChildren();
    ["✨", "🎉", "✨", "💡", "✨"].forEach((s, i) => {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.textContent = s; t.setAttribute("x", 200 + i * 60); t.setAttribute("y", 150 + (i % 2) * 26); t.style.animationDelay = `${i * 0.12}s`;
      sparkles.append(t);
    });
  }
  function frame(now) {
    requestAnimationFrame(frame);
    if (st.mode === "idle") return;
    const tangled = st.mode === "tangled";
    const travel = tangled ? 3600 : 2000, hold = 1300;
    const elapsed = (now - t0) % (travel + hold);
    const p = Math.min(1, elapsed / travel);
    if (elapsed < 40 && arrived) { arrived = false; if (tangled) bubble(1 - st.from, null); }
    const path = tangled ? paths.knot : paths.clean, len = path.getTotalLength();
    const pt = path.getPointAtLength((st.from === 0 ? p : 1 - p) * len);
    const scrambled = tangled && p > 0.5;
    token.textContent = scrambled ? st.heard : st.meant;
    const spin = tangled && p > 0.2 && p < 0.8 ? (p - 0.2) * 1200 : 0;
    token.setAttribute("transform", `translate(${pt.x} ${pt.y - 4}) rotate(${spin})`);
    token.style.opacity = p >= 1 ? 0 : "";
    if (p >= 1 && !arrived) { arrived = true; bubble(1 - st.from, tangled ? st.heard : st.meant, tangled ? "?" : "!"); }
    if (tangled) helper.setAttribute("transform", `translate(${320 + 62 * Math.sin(now / 900)} ${104 + 9 * Math.sin(now / 260)})`);
  }
  requestAnimationFrame(frame);
  return {
    set,
    get mode() { return st.mode; },
    breathe() { const s = $("#stage"); s.classList.remove("breathe"); void s.getBoundingClientRect(); s.classList.add("breathe"); },
  };
})();

/* --------------------------------------------------------------------- ui */
const toast = (msg, ms = 3800) => { const t = el("div", "toast", msg); $("#toasts").append(t); setTimeout(() => t.remove(), ms); };
const firstEmoji = (s, fallback) => {
  const g = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment((s || "").trim())][0]?.segment;
  return g && /\p{Extended_Pictographic}/u.test(g) ? g : fallback;
};
const idxOf = (name) => S.names.findIndex((n) => n && name && n.toLowerCase() === String(name).toLowerCase());
function whoChip(name) { const i = idxOf(name); return Object.assign(el("span", `who who-${i < 0 ? "x" : i}`, name || "everyone")); }

const transcript = []; // { speaker, text, mediator?, cue? }
let typedSpeaker = 0;

function addLine(line) {
  transcript.push(line);
  $("#emptyState")?.remove();
  const box = $("#transcript"), row = el("div", "line" + (line.mediator ? " mediator" : "") + (line.cue ? " is-cue" : ""));
  let chip;
  if (line.mediator) chip = el("span", "chip med", "Untangle");
  else {
    chip = el("button", "chip");
    chip.type = "button";
    const paint = () => { const i = idxOf(line.speaker); chip.className = `chip s${i < 0 ? "x" : i}`; chip.textContent = line.speaker || "?"; chip.setAttribute("aria-label", `Speaker: ${line.speaker || "unknown"}. Activate to change.`); };
    chip.title = "Wrong person? Click to change";
    chip.onclick = () => { const i = idxOf(line.speaker); line.speaker = i === 0 ? S.names[1] : i === 1 ? null : S.names[0]; paint(); };
    paint();
  }
  const text = el("div", "text", line.text);
  if (line.cue) text.append(el("span", "cue-tag", "cue"));
  row.append(chip, text); box.append(row);
  box.scrollTop = box.scrollHeight;
}

function setPanel({ label, who, say = "", hint = "", idle = false, thinking = false }) {
  const l = $("#panelLabel"); l.textContent = label; if (who !== undefined) l.append(whoChip(who));
  const s = $("#panelSay"); s.textContent = say; s.classList.toggle("idle", idle); s.classList.toggle("long", say.length > 150);
  const h = $("#panelHint"); h.textContent = hint; h.classList.toggle("dots", thinking);
}
function setSteps(step) {
  const order = ["spot", "ask", "confirm", "explain"], at = order.indexOf(step);
  document.querySelectorAll("#steps li").forEach((li, i) => { li.className = i < at ? "done" : i === at ? "now" : ""; if (i === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current"); });
}
function idlePanel() {
  const w = wakeCue().phrase;
  setPanel({ label: "Listening for crossed wires", say: `Say “${w}” whenever you're lost — or just keep talking. I'll step in when I hear a cue.`, idle: true });
  $("#stageEyebrow").textContent = "All clear"; $("#gapLine").textContent = "";
  $("#stepBackBtn").hidden = true;
}
function renderNames() {
  $("#name0").textContent = S.names[0]; $("#name1").textContent = S.names[1];
  const seg = $("#speakerSeg"); seg.replaceChildren();
  S.names.forEach((n, i) => {
    const b = el("button", "", n); b.type = "button"; b.dataset.i = i; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(i === typedSpeaker));
    b.onclick = () => { typedSpeaker = i; renderNames(); $("#composerInput").focus(); };
    seg.append(b);
  });
  const wq = $("#wakeQuote"); if (wq) wq.textContent = `“${wakeCue().phrase}”`;
}
function renderCount() { $("#resolvedCount").textContent = S.resolved ? `${S.resolved} untangled so far` : ""; }
function renderStatus() {
  const b = document.body, listening = Mic.listening;
  b.dataset.listening = String(listening);
  $("#statusText").textContent = b.dataset.mode === "mediating" ? "Untangling" : listening ? "Listening" : Mic.blocked ? "Microphone blocked" : "Mic off · typing only";
  $("#micBtn").setAttribute("aria-pressed", String(Mic.wanted && !Mic.blocked)); $("#micLabel").textContent = Mic.wanted && !Mic.blocked ? "Mic on" : "Mic off";
  $("#voiceBtn").setAttribute("aria-pressed", String(S.voice)); $("#voiceLabel").textContent = S.voice ? "Voice on" : "Voice off";
}
function banner(html, actionLabel, action) {
  const b = $("#banner");
  if (!html) { b.hidden = true; return; }
  b.replaceChildren(el("span", "", html));
  if (actionLabel) { const btn = el("button", "", actionLabel); btn.onclick = action; b.append(btn); }
  b.hidden = false;
}

/* -------------------------------------------------------------- mediator voice */
let speaking = false, quietUntil = 0;
function pickVoice() {
  const vs = speechSynthesis.getVoices(), lang = (navigator.language || "en").slice(0, 2);
  const mine = vs.filter((v) => v.lang.startsWith(lang));
  return mine.find((v) => /Samantha|Google UK English Female|Microsoft (Aria|Jenny|Sonia)|Natural/i.test(v.name)) || mine.find((v) => v.default) || mine[0] || null;
}
function say(text) {
  return new Promise((resolve) => {
    if (!S.voice || !("speechSynthesis" in window)) return setTimeout(resolve, 350);
    speaking = true; Mic.pause();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = 1.03; u.pitch = 1.05;
    let done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(guard);
      quietUntil = performance.now() + 700;
      setTimeout(() => { speaking = false; Mic.resume(); resolve(); }, 250);
    };
    u.onend = finish; u.onerror = finish;
    const guard = setTimeout(finish, 2500 + text.length * 95); // some browsers never fire onend
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  });
}

/* -------------------------------------------------------------------- mic */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const Mic = {
  wanted: false, blocked: false, running: false, paused: false, rec: null, stream: null, analyser: null, buf: null,
  uttStart: 0, pitchLog: [], speechAvg: 0, voiced: 0, loud: 0, lastTone: 0, enroll: null, netErrors: 0,
  get listening() { return this.wanted && !this.blocked && this.running && !this.paused; },

  // Ask for (or re-check) microphone permission. Returns true when we may listen.
  async ensurePermission() {
    if (!navigator.mediaDevices?.getUserMedia) { this.blocked = true; banner("This browser can't access a microphone here. You can still type the conversation."); return false; }
    if (this.stream?.active) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      this.blocked = true;
      const denied = err.name === "NotAllowedError" || err.name === "SecurityError";
      banner(denied ? "Microphone access is blocked. Click the 🔒 / mic icon in the address bar, allow the microphone, then try again." : "No microphone was found. Plug one in, or type the conversation instead.", "Try again", () => Mic.start());
      return false;
    }
    this.blocked = false; banner(null);
    this.stream.getAudioTracks()[0].addEventListener("ended", () => { this.stream = null; if (this.wanted) this.start(); });
    const ctx = Sound.ensure();
    if (ctx) { this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048; ctx.createMediaStreamSource(this.stream).connect(this.analyser); this.buf = new Float32Array(2048); }
    return true;
  },
  async start() {
    this.wanted = true; S.mic = true; save();
    if (!(await this.ensurePermission())) { renderStatus(); return false; }
    if (!SR) banner("Your browser has no built-in speech recognition (Chrome, Edge or Safari do). The microphone is on for tone only — type the conversation below.");
    else this.spin();
    renderStatus(); return true;
  },
  stop() { this.wanted = false; S.mic = false; save(); this.halt(); this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; $("#interim").textContent = ""; renderStatus(); },
  pause() { this.paused = true; this.halt(); renderStatus(); },
  resume() { this.paused = false; if (this.wanted && !this.blocked && !document.hidden) this.spin(); renderStatus(); },
  halt() { try { this.rec?.abort(); } catch { /* not running */ } },
  spin() {
    if (!SR || this.running || this.paused || !this.wanted || this.blocked) return;
    const rec = (this.rec = new SR());
    rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || "en-US";
    rec.onstart = () => { this.running = true; this.netErrors = 0; renderStatus(); };
    rec.onresult = (e) => {
      if (speaking) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], text = r[0].transcript.trim();
        if (!this.uttStart) this.uttStart = performance.now();
        if (r.isFinal) { if (text) onHeard(text, this.speakerFor(this.uttStart, performance.now())); this.uttStart = 0; }
        else interim += text + " ";
      }
      $("#interim").textContent = interim; if (interim) onInterim();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { this.blocked = true; banner("Speech recognition was blocked. Allow the microphone for this site, then try again.", "Try again", () => { this.blocked = false; this.start(); }); }
      else if (e.error === "network" && ++this.netErrors === 3) toast("Can't reach the speech service — check your connection. You can type meanwhile.");
    };
    rec.onend = () => { this.running = false; renderStatus(); setTimeout(() => this.spin(), this.netErrors ? 1500 : 250); };
    try { rec.start(); } catch { /* already starting */ }
  },

  // 20×/s: level meter, raised-voice cue, and pitch samples for speaker tagging.
  tick() {
    if (!this.analyser || !this.stream?.active) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let e = 0; for (let i = 0; i < this.buf.length; i++) e += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(e / this.buf.length), now = performance.now();
    $("#status").style.setProperty("--level", Math.min(1, rms * 9).toFixed(2));
    if (speaking || now < quietUntil || rms < 0.012) { this.loud = Math.max(0, this.loud - 1); return; }
    this.voiced++; this.speechAvg += (rms - this.speechAvg) * (this.voiced < 40 ? 0.1 : 0.012);
    const f0 = pitchOf(this.buf, Sound.ctx.sampleRate);
    if (f0) { this.pitchLog.push({ t: now, f0 }); if (this.pitchLog.length > 600) this.pitchLog.shift(); this.enroll?.samples.push(f0); }
    const tone = S.cues.find((c) => c.source === TONE_ID);
    if (this.voiced > 120 && rms > Math.max(0.1, this.speechAvg * 2.4)) this.loud += 1; else this.loud = Math.max(0, this.loud - 0.5);
    if (tone?.enabled && this.loud >= 10 && now - this.lastTone > 25000) { this.lastTone = now; this.loud = 0; onCue(tone, { speaker: this.speakerFor(now - 1500, now), text: "(raised voice)" }); }
  },
  speakerFor(t0, t1) {
    const [a, b] = S.pitches;
    if (!a || !b || Math.abs(Math.log(a / b)) < 0.14) return null; // voices too similar (or not taught) to tell apart
    const f = median(this.pitchLog.filter((p) => p.t >= t0 - 300 && p.t <= t1).map((p) => p.f0));
    if (!f) return null;
    const da = Math.abs(Math.log(f / a)), db = Math.abs(Math.log(f / b));
    return Math.abs(da - db) < 0.05 ? null : S.names[da < db ? 0 : 1];
  },
};
setInterval(() => Mic.tick(), 50);
const median = (xs) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0);
function pitchOf(buf, sr) { // plain autocorrelation, 75–400 Hz
  const n = buf.length, lo = Math.floor(sr / 400), hi = Math.min(n - 1, Math.floor(sr / 75));
  let e = 0; for (let i = 0; i < n; i++) e += buf[i] * buf[i];
  let best = 0, lag = 0;
  for (let l = lo; l <= hi; l += 1) { let c = 0; for (let i = 0; i < n - l; i += 2) c += buf[i] * buf[i + l]; c = (c * 2 * n) / (e * (n - l)); if (c > best) { best = c; lag = l; } }
  return best > 0.6 ? sr / lag : 0;
}
// Only listen while the app is open and in front.
document.addEventListener("visibilitychange", () => { if (document.hidden) Mic.halt(); else if (Mic.wanted) Mic.spin(); });
navigator.permissions?.query({ name: "microphone" }).then((p) => { p.onchange = () => { if (p.state === "denied") { Mic.blocked = true; Mic.halt(); banner("Microphone access was turned off. Re-allow it in the address bar to keep listening.", "Try again", () => Mic.start()); renderStatus(); } else if (p.state === "granted" && Mic.wanted && Mic.blocked) Mic.start(); }; }).catch(() => {});

/* -------------------------------------------------------------- mediation */
let active = null, pending = null, lastMeaning = "";
const queue = [];

function onInterim() { if (pending) clearTimeout(pending.timer); }

// Every utterance — spoken or typed — lands here.
function onHeard(text, speaker, typed = false) {
  const awaiting = Boolean(pending);
  const cue = detectCue(text, Boolean(active)); // mid-mediation only the wake phrase opens a new thread
  const line = { speaker: speaker || (awaiting && !cue ? pending.address : null), text, cue: Boolean(cue) };
  addLine(line);
  if (cue) return onCue(cue, line);
  if (awaiting) {
    pending.parts.push(text); pending.speaker = line.speaker; clearTimeout(pending.timer);
    pending.timer = setTimeout(() => pending?.done(), typed ? 0 : 1500); // wait for a natural pause
  }
}

function onCue(cue, line) {
  cue.hits++; save();
  const open = (active ? 1 : 0) + queue.length;
  if (open >= 2) { // third cue before things are resolved: no pile-on, just a breath
    Sound.chimes(); Stage.breathe(); toast("🎐  One knot at a time — deep breath.");
    return;
  }
  const m = { cue, cueInfo: { phrase: cue.phrase, kind: cue.source === TONE_ID ? "tone" : "phrase", speaker: line.speaker }, context: transcript.filter((l) => !l.mediator).slice(-14).map((l) => ({ speaker: l.speaker, text: l.text })), dialog: [], learned: [] };
  if (active) { queue.push(m); Sound.signal(); toast("Noted — I'll untangle that one next."); renderQueue(); }
  else runMediation(m);
}
function renderQueue() { const q = $("#queueChip"); q.hidden = !queue.length; q.textContent = `${queue.length} more waiting`; }

function waitForAnswer(address) {
  return new Promise((resolve) => {
    const p = (pending = { address, parts: [], speaker: null, timer: null, done: null });
    const idle = setTimeout(() => finish(null), 90000);
    function finish(v) { clearTimeout(idle); clearTimeout(p.timer); if (pending === p) pending = null; resolve(v); }
    p.done = () => finish({ text: p.parts.join(" "), speaker: p.speaker || address });
    p.cancel = () => finish(null);
  });
}

async function callMediator(m) {
  const res = await fetch("/api/mediate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ participants: S.names, transcript: m.context, cue: m.cueInfo, dialog: m.dialog, previously: m.previously, knownCues: S.cues.filter((c) => c.source !== TONE_ID).map((c) => c.phrase) }),
  });
  if (!res.ok) throw new Error(`Mediator returned ${res.status}`);
  return res.json();
}

async function runMediation(m) {
  active = m; document.body.dataset.mode = "mediating"; renderStatus(); renderQueue();
  m.previously = lastMeaning;
  Sound.signal();
  Stage.set({ mode: "tangled", from: Math.max(0, idxOf(m.cueInfo.speaker) === 0 ? 1 : 0), meant: "🍎", heard: "🍊" });
  $("#stageEyebrow").textContent = "Crossed wires spotted"; $("#gapLine").textContent = "";
  $("#stepBackBtn").hidden = false; setSteps("spot");
  const intro = m.cueInfo.kind === "tone" ? "Hold on — voices are rising. I think there's a crossed wire here." : "Hold on — I think there's a small misunderstanding here. Let me help.";
  setPanel({ label: "Untangle", say: intro, hint: "Working out who to ask", thinking: true });
  addLine({ mediator: true, text: intro });
  let introSaid = say(intro);

  try {
    while (!m.cancelled) {
      const [r] = await Promise.all([callMediator(m), introSaid]); introSaid = null;
      if (m.cancelled) break;
      const address = S.names[idxOf(r.address)] || r.address;
      m.dialog.push({ role: "mediator", action: r.action, address, text: r.say });
      const ai = idxOf(address), explain = r.action === "explain";
      // The token travels from the misunderstood person to the listener.
      if (!explain && ai >= 0) m.from = ai;
      Stage.set({ mode: "tangled", from: m.from ?? 0, meant: firstEmoji(r.meant_emoji, "🍎"), heard: firstEmoji(r.heard_emoji, "🍊") });
      $("#gapLine").textContent = r.gap || ""; setSteps(r.action);
      setPanel({ label: { ask: "Asking", confirm: "Checking with", explain: "Explaining to" }[r.action], who: address, say: r.say });
      addLine({ mediator: true, text: r.say });
      await say(r.say);
      if (m.cancelled) break;
      if (explain) { m.resolved = true; m.meaning = r.meaning || r.say; m.suggested = r.suggested_cues || []; m.speaker = S.names[m.from ?? 0]; break; }
      setPanel({ label: { ask: "Asking", confirm: "Checking with" }[r.action], who: address, say: r.say, hint: `Listening for ${address}'s answer — speak or type`, thinking: true });
      const a = await waitForAnswer(address);
      if (!a) {
        if (!m.cancelled) { const bye = `I'll step back for now. Say “${wakeCue().phrase}” if you need me.`; addLine({ mediator: true, text: bye }); await say(bye); }
        break;
      }
      m.dialog.push({ role: "participant", speaker: a.speaker, text: a.text });
      setPanel({ label: "Untangle", say: r.say, hint: "Thinking", thinking: true });
    }
  } catch (err) {
    console.error(err);
    toast("I lost my connection to the mediator. Try again in a moment.");
  }
  finishMediation(m);
}

function finishMediation(m) {
  active = null; pending?.cancel?.();
  if (m.resolved) {
    S.resolved++; lastMeaning = m.meaning;
    Sound.resolved(); Stage.set({ mode: "resolved", from: m.from ?? 0 });
    $("#stageEyebrow").textContent = "Untangled";
    learnCues(m); save(); renderCount(); addResolvedCard(m);
  } else Stage.set({ mode: "idle" });
  if (queue.length) { const next = queue.shift(); active = next; renderQueue(); setTimeout(() => runMediation(next), m.resolved ? 2600 : 600); return; }
  document.body.dataset.mode = "idle"; renderStatus();
  idlePanel();
  if (m.resolved) $("#stageEyebrow").textContent = "Untangled";
}

// Refinement, part 1: pick up new cue phrases the mediator noticed in a real misunderstanding.
function learnCues(m) {
  for (const raw of m.suggested.slice(0, 2)) {
    const phrase = String(raw).trim().replace(/[.?!"“”]+$/g, "").toLowerCase(), n = norm(phrase).trim(), words = n.split(" ").length;
    if (words < 2 || words > 6 || n.length < 7) continue;
    if (S.cues.some((c) => norm(c.phrase).trim() === n) || S.cues.filter((c) => c.source === "learned").length >= 30) continue;
    const c = mkCue(phrase, "learned"); S.cues.push(c); m.learned.push(c);
    toast(`Learned a new cue: “${phrase}”`, 5000);
  }
}
// Refinement, part 2: feedback strengthens cues or retires the ones that cry wolf.
function feedback(m, helpful) {
  const c = m.cue;
  if (helpful) c.helpful++;
  else {
    c.falseAlarms++;
    S.cues = S.cues.filter((x) => !m.learned.includes(x)); // don't keep cues learned from a false alarm
    if (c.source !== "wake" && c.enabled && c.falseAlarms >= 2 && c.falseAlarms > c.helpful) { c.enabled = false; c.retired = true; toast(`I'll stop reacting to “${c.phrase}” — too many false alarms.`, 5000); }
  }
  save(); renderDrawer();
}
function addResolvedCard(m) {
  const card = el("div", "resolved");
  card.append(el("div", "tag", "Untangled"), el("p", "meaning", m.meaning), el("p", "via", `${m.speaker ? `What ${m.speaker} meant · ` : ""}woke on “${m.cue.phrase.toLowerCase()}”`));
  const fb = el("div", "fb"); fb.append(el("span", "", "Was that a real misunderstanding?"));
  const yes = el("button", "", "Yes, that helped"), no = el("button", "", "False alarm");
  yes.onclick = () => { feedback(m, true); fb.replaceChildren(el("span", "", "Thanks — I'll keep listening for that.")); };
  no.onclick = () => { feedback(m, false); fb.replaceChildren(el("span", "", "Got it — I'll be more careful with that cue.")); };
  fb.append(yes, no); card.append(fb);
  $("#resolvedFeed").prepend(card);
  while ($("#resolvedFeed").children.length > 4) $("#resolvedFeed").lastChild.remove();
}

$("#stepBackBtn").onclick = () => { if (!active) return; active.cancelled = true; speechSynthesis?.cancel(); pending?.cancel?.(); toast("Stepping back. I'm still listening."); };

/* ----------------------------------------------------------------- drawer */
function renderDrawer() {
  $("#wakeInput").value = wakeCue().phrase;
  const list = $("#cueList"); list.replaceChildren();
  for (const c of S.cues) {
    const li = el("li", "cue" + (c.enabled ? "" : " off")), main = el("div"), meta = el("div", "meta");
    main.append(el("div", "phrase", c.source === TONE_ID ? "Raised voice (tone)" : `“${c.phrase}”`));
    const kind = c.retired && !c.enabled ? "retired" : c.source === "wake" ? "wake" : c.source === "learned" ? "learned" : "";
    if (kind) meta.append(el("span", `badge ${kind}`, kind));
    meta.append(el("span", "", c.hits ? `heard ${c.hits}×` : "not heard yet"));
    if (c.helpful + c.falseAlarms) { const bar = el("span", "conf"); bar.title = `Confidence ${Math.round(confidence(c) * 100)}%`; const fill = el("i"); fill.style.width = `${confidence(c) * 100}%`; bar.append(fill); meta.append(bar); }
    main.append(meta);
    const sw = el("input", "switch"); sw.type = "checkbox"; sw.checked = c.enabled; sw.disabled = c.source === "wake"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-label", `Listen for ${c.phrase}`);
    sw.onchange = () => { c.enabled = sw.checked; if (c.enabled) c.retired = false; save(); renderDrawer(); };
    li.append(main, sw);
    if (c.source === "learned" || c.source === "custom") { const x = el("button", "x-btn", "×"); x.setAttribute("aria-label", `Remove ${c.phrase}`); x.onclick = () => { S.cues = S.cues.filter((k) => k !== c); save(); renderDrawer(); }; li.append(x); } else li.append(el("span"));
    list.append(li);
  }
  const people = $("#people"); people.replaceChildren();
  S.names.forEach((n, i) => {
    const row = el("div", "person"), name = el("span", "pname"); name.append(el("span", `dot dot-${i}`), el("span", "", n), el("span", "hz", S.pitches[i] ? `voice learned · ${Math.round(S.pitches[i])} Hz` : "voice not taught"));
    const btn = el("button", "small-btn alt", S.pitches[i] ? "Re-teach" : "Teach voice"); btn.onclick = () => enroll(i, btn);
    row.append(name, btn); people.append(row);
  });
}
async function enroll(i, btn) {
  if (!(await Mic.start()) || !Mic.analyser) return toast("I need the microphone for that.");
  btn.disabled = true; btn.textContent = `Talk now, ${S.names[i]}…`;
  Mic.enroll = { samples: [] }; await sleep(3500);
  const samples = Mic.enroll.samples; Mic.enroll = null;
  if (samples.length < 8) toast("I couldn't hear enough — try again a little closer to the mic.");
  else {
    S.pitches[i] = median(samples); save();
    const [a, b] = S.pitches;
    toast(a && b && Math.abs(Math.log(a / b)) < 0.14 ? "Your voices sound alike — I'll tag speakers when I can; tap a name in the transcript to fix it." : `Got it — I'll recognise ${S.names[i]}.`, 5000);
  }
  renderDrawer();
}
function openDrawer(open) { $("#drawer").hidden = $("#scrim").hidden = !open; if (open) { renderDrawer(); $("#drawerClose").focus(); } else $("#cuesBtn").focus(); }
$("#cuesBtn").onclick = () => openDrawer(true);
$("#drawerClose").onclick = $("#scrim").onclick = () => openDrawer(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) openDrawer(false); });
$("#wakeForm").onsubmit = (e) => { e.preventDefault(); const v = $("#wakeInput").value.trim(); if (norm(v).trim().length < 3) return toast("Pick a wake phrase with at least one real word."); wakeCue().phrase = v; save(); renderNames(); if (!active) idlePanel(); toast(`Wake phrase set to “${v}”`); };
$("#addCueForm").onsubmit = (e) => {
  e.preventDefault(); const v = $("#addCueInput").value.trim(), n = norm(v).trim();
  if (n.length < 3) return;
  if (S.cues.some((c) => norm(c.phrase).trim() === n)) return toast("I'm already listening for that.");
  S.cues.push(mkCue(v, "custom")); save(); $("#addCueInput").value = ""; renderDrawer();
};
$("#resetBtn").onclick = () => { if (!confirm("Forget learned cues, feedback and voices? Names are kept.")) return; const keep = { names: S.names, onboarded: true, voice: S.voice, mic: S.mic }; S = { ...defaults(), ...keep }; save(); renderDrawer(); renderNames(); renderCount(); if (!active) idlePanel(); toast("Fresh start."); };

/* ----------------------------------------------------------------- wiring */
$("#composer").onsubmit = (e) => { e.preventDefault(); const input = $("#composerInput"), v = input.value.trim(); if (!v) return; Sound.ensure(); input.value = ""; onHeard(v, S.names[typedSpeaker], true); };
$("#composerInput").addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.shiftKey && !e.target.value) { e.preventDefault(); typedSpeaker = 1 - typedSpeaker; renderNames(); } });
$("#micBtn").onclick = () => { Sound.ensure(); if (Mic.wanted && !Mic.blocked) Mic.stop(); else Mic.start(); };
$("#voiceBtn").onclick = () => { S.voice = !S.voice; if (!S.voice) speechSynthesis?.cancel(); save(); renderStatus(); };

function enter(withMic) {
  $("#welcome").hidden = true; S.onboarded = true; save();
  renderNames(); renderCount(); idlePanel(); renderStatus();
  if (withMic) Mic.start(); else $("#composerInput").focus();
}
function readNames() {
  const a = $("#nameA").value.trim() || "Alex"; let b = $("#nameB").value.trim() || "Sam";
  if (a.toLowerCase() === b.toLowerCase()) b += " 2";
  if (a !== S.names[0] || b !== S.names[1]) S.pitches = [null, null];
  S.names = [a, b];
}
$("#welcomeForm").onsubmit = async (e) => {
  e.preventDefault(); readNames(); Sound.ensure();
  const btn = $("#startBtn"); btn.disabled = true; btn.textContent = "Waiting for microphone permission…";
  Mic.wanted = true;
  const ok = await Mic.ensurePermission();
  btn.disabled = false; btn.textContent = "Allow microphone & start listening";
  if (!ok) { const n = $("#welcomeNote"); n.classList.add("warn"); n.textContent = "The microphone is blocked. Allow it from the address bar and press the button again — or continue by typing."; return; }
  enter(true);
};
$("#textOnlyBtn").onclick = () => { readNames(); Sound.ensure(); S.mic = false; enter(false); };

// Boot. A returning visitor still gets the welcome card: browsers need a click before audio can start.
$("#nameA").value = S.names[0]; $("#nameB").value = S.names[1];
if (S.onboarded) { $("#welcomeTitle").textContent = "Welcome back."; $(".lede").textContent = `I remember ${S.cues.filter((c) => c.enabled).length} cues from last time${S.resolved ? ` and ${S.resolved} untangled moment${S.resolved > 1 ? "s" : ""}` : ""}. Ready when you are.`; }
$("#welcome").hidden = false; $("#nameA").focus();
renderNames(); renderCount(); idlePanel(); renderStatus();
fetch("/api/health").then((r) => r.json()).then((h) => { if (!h.ai) banner("Demo mode: no AI key is configured, so a simple scripted mediator is standing in. Add ANTHROPIC_API_KEY to .env and restart for the real one."); }).catch(() => {});
