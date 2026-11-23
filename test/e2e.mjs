// End-to-end check of both communication modes (typed + voice) against a running server.
// Voice mode uses Chromium's fake microphone and a stand-in for the browser speech service
// (headless Chromium has no speech backend), so everything downstream of recognition is real.
import { chromium } from "playwright";
const URL = process.env.URL || "http://localhost:4747";
const shot = (page, name) => page.screenshot({ path: `test/shots/${name}.png` });
const log = (...a) => console.log("  ", ...a);
const mediatorLines = (page) => page.locator(".line.mediator .text").allTextContents();

async function converse(page, speak, tag) {
  // Answer whatever the mediator asks until it explains.
  const answers = { Alex: ["I meant today, before the end of the day, because the client meeting is tomorrow at nine.", "Yes, exactly."], Sam: ["I thought soon meant sometime this week.", "Yes, that's right."] };
  const used = { Alex: 0, Sam: 0 };
  for (let turn = 0; turn < 8; turn++) {
    await page.waitForFunction(() => /Listening for/.test(document.querySelector("#panelHint").textContent) || document.querySelector(".resolved"), null, { timeout: 90000 });
    if (await page.locator(".resolved").count()) break;
    const label = await page.locator("#panelLabel").textContent(), who = /Sam/.test(label) ? "Sam" : "Alex";
    log(`[${tag}] mediator → ${label}: ${await page.locator("#panelSay").textContent()}`);
    if (turn === 0) await shot(page, `${tag}-asking`);
    const a = answers[who][Math.min(used[who]++, 1)];
    await speak(who, /Checking/.test(label) ? "Yes, that's right." : a);
    await page.waitForFunction(() => !/Listening for/.test(document.querySelector("#panelHint").textContent), null, { timeout: 15000 });
  }
  await page.waitForSelector(".resolved", { timeout: 90000 });
  log(`[${tag}] resolved: ${await page.locator(".resolved .meaning").first().textContent()}`);
  log(`[${tag}] explained: ${(await mediatorLines(page)).at(-1)}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let failed = false;
const check = (ok, what) => { console.log(ok ? "✓" : "✗", what); if (!ok) failed = true; };

/* ---------- 1. typed mode ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("PAGE ERROR", e.message); failed = true; });
  await page.goto(URL);
  await shot(page, "welcome");
  await page.fill("#nameA", "Alex"); await page.fill("#nameB", "Sam");
  await page.click("#textOnlyBtn");
  await page.click("#voiceBtn"); // voice off for speed
  const type = async (who, text) => { await page.click(`#speakerSeg button:has-text("${who}")`); await page.fill("#composerInput", text); await page.press("#composerInput", "Enter"); };
  await shot(page, "idle");
  await type("Alex", "Can you send me the report soon?");
  await type("Sam", "Sure, I'll get it to you soon.");
  await type("Alex", "It's five o'clock, where is the report?");
  check((await page.locator("body").getAttribute("data-mode")) === "idle", "typed: stays quiet without a cue");
  await type("Sam", "What? I don't understand, I said soon.");
  check((await page.locator("body").getAttribute("data-mode")) === "mediating", "typed: wake phrase starts mediation");
  check((await page.locator("body").getAttribute("data-stage")) === "tangled", "typed: tangled animation is showing");
  // second and third cue before resolution
  await page.waitForFunction(() => /Listening for/.test(document.querySelector("#panelHint").textContent), null, { timeout: 60000 });
  await type("Alex", "And I don't understand why this is so hard.");
  check(await page.locator("#queueChip").isVisible(), "typed: second cue is queued");
  await type("Sam", "Well I don't understand you either!");
  check(/One knot at a time/.test(await page.locator("#toasts").textContent()), "typed: third cue plays chimes instead of piling on");
  await page.waitForTimeout(1800); await shot(page, "typed-tangled");
  await converse(page, type, "typed");
  check(true, "typed: first misunderstanding resolved and explained");
  await shot(page, "typed-resolved");
  // queued one runs next
  await page.waitForFunction(() => document.body.dataset.mode === "mediating" && /Asking|Checking/.test(document.querySelector("#panelLabel").textContent), null, { timeout: 60000 });
  check(true, "typed: queued misunderstanding starts after the first");
  await page.click("#stepBackBtn");
  await page.waitForFunction(() => document.body.dataset.mode === "idle", null, { timeout: 20000 });
  check(true, "typed: step back returns to listening");
  // feedback + persistence
  await page.click('.resolved .fb button:has-text("Yes")');
  await page.click("#cuesBtn"); await page.waitForTimeout(400); await shot(page, "drawer");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("untangle.v1")));
  const wake = stored.cues.find((c) => c.source === "wake");
  check(wake.hits >= 3 && wake.helpful === 1 && stored.resolved === 1, `typed: cue stats persisted (hits ${wake.hits}, helpful ${wake.helpful})`);
  log("learned cues:", stored.cues.filter((c) => c.source === "learned").map((c) => c.phrase).join(" | ") || "(none this run)");
  await page.reload();
  check(/Welcome back/.test(await page.locator("#welcomeTitle").textContent()), "typed: remembered between sessions");
  await page.setViewportSize({ width: 390, height: 844 }); await page.click("#textOnlyBtn"); await shot(page, "mobile");
  await ctx.close();
}

/* ---------- 2. voice mode ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("PAGE ERROR", e.message); failed = true; });
  await page.addInitScript(() => {
    let live = null;
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() { live = this; setTimeout(() => this.onstart?.(), 30); }
      abort() { if (live === this) live = null; setTimeout(() => this.onend?.(), 10); }
      stop() { this.abort(); }
    };
    const emit = (text, isFinal) => live?.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
    window.__heard = async (text) => { if (!live) return false; emit(text.slice(0, Math.ceil(text.length / 2)), false); await new Promise((r) => setTimeout(r, 200)); emit(text, true); return true; };
    localStorage.setItem("untangle.test", "1");
  });
  await page.goto(URL);
  await page.fill("#nameA", "Alex"); await page.fill("#nameB", "Sam");
  await page.click("#startBtn");
  await page.waitForFunction(() => document.body.dataset.listening === "true", null, { timeout: 10000 });
  check(true, "voice: microphone permission granted and listening");
  const level = await page.evaluate(() => new Promise((r) => { let max = 0; const t = setInterval(() => { max = Math.max(max, +getComputedStyle(document.querySelector("#status")).getPropertyValue("--level")); }, 50); setTimeout(() => { clearInterval(t); r(max); }, 1500); }));
  check(level > 0, `voice: live audio level from the microphone (${level})`);
  const speak = async (_who, text) => { for (let i = 0; i < 100; i++) { if (await page.evaluate((t) => window.__heard(t), text)) return; await page.waitForTimeout(200); } throw new Error("recognizer never resumed"); };
  await speak("Alex", "Can you send me the report soon?");
  await speak("Sam", "Sure, I'll get it to you soon.");
  await speak("Alex", "It's five o'clock, where is the report?");
  await speak("Sam", "What? I don’t understand, I said soon.");
  check((await page.locator("body").getAttribute("data-mode")) === "mediating", "voice: spoken wake phrase starts mediation");
  await converse(page, speak, "voice");
  check(true, "voice: misunderstanding resolved and explained by spoken answers");
  await shot(page, "voice-resolved");
  await ctx.close();
}

/* ---------- 3. microphone denied ---------- */
{
  const b2 = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--deny-permission-prompts"] });
  const page = await (await b2.newContext()).newPage();
  await page.goto(URL); await page.click("#startBtn");
  await page.waitForFunction(() => /blocked/.test(document.querySelector("#welcomeNote").textContent), null, { timeout: 10000 }).then(() => check(true, "denied: clear guidance when the microphone is blocked"), () => check(false, "denied: clear guidance when the microphone is blocked"));
  await shot(page, "denied");
  await b2.close();
}
await browser.close();
console.log(failed ? "\nFAILED" : "\nAll checks passed");
process.exit(failed ? 1 : 0);
