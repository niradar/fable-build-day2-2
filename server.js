// Untangle — tiny server: serves the web app and proxies mediator turns to Claude.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

try { process.loadEnvFile(); } catch { /* no .env file — fine */ }

const PORT = Number(process.env.PORT) || 4747;
const MODEL = process.env.UNTANGLE_MODEL || "claude-opus-5-5";
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const HAS_AI = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = HAS_AI ? new Anthropic() : null;

const MAX_QUESTIONS = 3;

const SYSTEM = `You are Untangle, a warm, quick-witted mediator that sits in on a live spoken conversation between people. A cue (a phrase or a raised voice) has just signalled a misunderstanding. Your job is to clear it up fast.

How you work:
1. Decide who was misunderstood. Usually that is the person whose words were NOT understood — not the person who said the cue. Address that person by name.
2. Ask them the single question most likely to reveal what they actually meant. One question at a time, at most ${MAX_QUESTIONS} questions in total. Prefer concrete questions ("Do you mean X or Y?", "What would that look like on Monday?") over open ones. Skip questions whose answer is already clear from the conversation.
3. When you believe you understand, use action "confirm": paraphrase their meaning back to them in one sentence and ask if you got it right.
4. If they agree, use action "explain": address the OTHER participant(s) by name and translate the meaning into terms they will understand — use their own vocabulary, their frame of reference, and what they seemed to assume instead. If they disagree with your paraphrase, ask again or re-confirm with a corrected paraphrase.

Rules:
- Everything in "say" is read aloud by a speech synthesizer: plain spoken language, no markdown, no lists, no emoji, at most two short sentences (three for "explain"). Start with the name of the person you address.
- Be neutral and kind. Nobody is at fault; it is just a crossed wire. A light touch of humour is welcome, never sarcasm.
- Speaker labels come from imperfect voice tagging. "?" means unknown — infer who said what from context, and trust the content over the labels.
- Answers during the mediation come from live speech recognition and may contain small transcription errors; read them charitably.
- "gap": one short line (max 14 words) naming the crossed wire as you currently see it, e.g. "'Soon' means today to Sam, next week to Alex".
- "meant_emoji" / "heard_emoji": exactly one emoji each, picturing what was meant versus what was (mis)heard — related to the topic, and amusingly different from each other (e.g. 🐎 vs 🦓).
- "meaning": for "explain", the agreed meaning in one plain sentence; otherwise an empty string.
- "suggested_cues": only for "explain". Up to 2 short phrases (2–6 words) that a participant literally said in this conversation to express confusion, disbelief or feeling misheard (e.g. "wait, which one", "that's not the point", "hang on, what"). They are saved as future activation cues, so each must work in any conversation on any topic: no topic words, and no ordinary questions or statements that people also say when nothing is wrong. Never repeat a known cue. If nothing qualifies — which is common — return an empty array. Otherwise an empty array.`;

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["ask", "confirm", "explain"] },
    address: { type: "string", description: "Name of the participant being addressed" },
    say: { type: "string" },
    gap: { type: "string" },
    meant_emoji: { type: "string" },
    heard_emoji: { type: "string" },
    meaning: { type: "string" },
    suggested_cues: { type: "array", items: { type: "string" } },
  },
  required: ["action", "address", "say", "gap", "meant_emoji", "heard_emoji", "meaning", "suggested_cues"],
  additionalProperties: false,
};

function buildPrompt(b) {
  const lines = (b.transcript || []).map((l) => `${l.speaker || "?"}: ${l.text}`).join("\n");
  const dialog = (b.dialog || [])
    .map((d) => (d.role === "mediator" ? `Untangle → ${d.address} (${d.action}): ${d.text}` : `${d.speaker || "?"}: ${d.text}`))
    .join("\n");
  const turns = (b.dialog || []).filter((d) => d.role === "mediator");
  const asks = turns.filter((d) => d.action === "ask").length;
  let budget = `Clarifying questions asked so far: ${asks} of ${MAX_QUESTIONS}.`;
  if (asks >= MAX_QUESTIONS) budget += ' You may not use "ask" again — confirm or explain.';
  if (turns.length >= 7) budget += ' This has gone on long enough: you MUST use "explain" now with your best understanding.';
  return [
    `Participants: ${b.participants.join(", ")}`,
    `Conversation just before the cue (oldest first):\n${lines || "(nothing captured)"}`,
    `Cue that triggered you: ${b.cue.kind === "tone" ? "a raised voice" : `"${b.cue.phrase}"`}${b.cue.speaker ? ` — from ${b.cue.speaker}` : ""}`,
    b.previously ? `Already resolved a moment ago (do not redo): ${b.previously}` : "",
    `Known cue phrases: ${(b.knownCues || []).join("; ")}`,
    `Mediation so far:\n${dialog || "(you have not spoken yet)"}`,
    budget,
    "Decide your next move.",
  ].filter(Boolean).join("\n\n");
}

async function aiTurn(body) {
  const res = await client.beta.messages.create(
    {
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a safety classifier declines, the API retries on a fallback model
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(body) }],
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    },
    { timeout: 40_000, maxRetries: 1 },
  );
  if (res.stop_reason === "refusal") throw new Error("The model declined this request");
  const text = res.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`No text in response (stop_reason: ${res.stop_reason})`);
  return JSON.parse(text);
}

// Fallback mediator used when no API key is configured or the AI call fails.
function scriptedTurn(b) {
  const names = b.participants;
  const dialog = b.dialog || [];
  const turns = dialog.filter((d) => d.role === "mediator");
  const answers = dialog.filter((d) => d.role === "participant").map((d) => d.text.trim().replace(/[.?!]+$/, ""));
  const lastOther = [...(b.transcript || [])].reverse().find((l) => l.speaker && l.speaker !== b.cue.speaker && names.includes(l.speaker));
  const target = turns[0]?.address || lastOther?.speaker || names.find((n) => n !== b.cue.speaker) || names[0];
  const others = names.filter((n) => n !== target).join(" and ") || "everyone";
  const last = turns[turns.length - 1];
  const out = (action, address, say, meaning = "") => ({
    action, address, say, meaning,
    gap: "Same words, two different pictures", meant_emoji: "🍎", heard_emoji: "🍊", suggested_cues: [],
  });
  const negative = /^(no|nope|not really|not quite|not exactly|wrong)\b/i.test(answers[answers.length - 1] || "");
  if (!last) return out("ask", target, `${target}, in one short sentence — what is the main thing you want ${others} to take away?`);
  if (last.action === "ask" && turns.length < 2) return out("ask", target, `Thanks, ${target}. Can you give one concrete example of what that looks like?`);
  if (last.action === "confirm" && negative) return out("ask", target, `Okay, ${target} — how would you put it in your own words?`);
  const core = answers.filter((a) => !/^(yes|yeah|yep|right|exactly|correct)\b/i.test(a)).slice(-2);
  const meaning = core.length > 1 ? `${core[0]} — for example, ${core[1]}` : core[0] || "what was just said";
  if (last.action === "ask") return out("confirm", target, `${target}, let me check I have it. You mean: ${meaning}. Is that right?`);
  return out("explain", others, `${others}, here is what ${target} means: ${meaning}.`, meaning);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("Body too large");
  }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") return sendJson(res, 200, { ai: HAS_AI, model: HAS_AI ? MODEL : null });

    if (url.pathname === "/api/mediate" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.participants) || body.participants.length < 2 || !body.cue) return sendJson(res, 400, { error: "participants and cue are required" });
      if (HAS_AI && !body.forceScripted) {
        try {
          return sendJson(res, 200, { ...(await aiTurn(body)), engine: "ai" });
        } catch (err) {
          console.error("[mediate] AI call failed, using scripted mediator:", err.status || "", err.message);
          return sendJson(res, 200, { ...scriptedTurn(body), engine: "scripted", note: "AI unavailable" });
        }
      }
      return sendJson(res, 200, { ...scriptedTurn(body), engine: "scripted" });
    }

    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") return sendJson(res, 404, { error: "Not found" });
    console.error(err);
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Untangle is running →  http://localhost:${PORT}`);
  console.log(HAS_AI ? `  Mediator: ${MODEL}\n` : "  Mediator: scripted demo (set ANTHROPIC_API_KEY in .env for the AI mediator)\n");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`\n  Port ${PORT} is busy. Start on another one:  PORT=4848 npm start\n`);
  else console.error(err);
  process.exit(1);
});
