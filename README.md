# Untangle

A live AI mediator for conversations. Untangle listens while two people talk. When it hears a
misunderstanding cue ("I don't understand", "that's not what I meant", a raised voice…), it steps in,
asks the misunderstood person a few pointed questions, confirms what they meant, and explains it to
the other person in terms they will get.

## Run it

```bash
npm install
cp .env.example .env      # then put your ANTHROPIC_API_KEY in .env (or export it in your shell)
npm start                 # → http://localhost:4747
```

Open the page in **Chrome or Edge** (they provide the built-in speech recognition), enter two names,
and click **Allow microphone & start listening**. Without an API key the app still runs, using a
simple scripted mediator.

## Using it

- **Voice:** just talk. Say the wake phrase — "I don't understand" by default — and Untangle chimes,
  speaks, and listens for the answers. It only listens while the tab is open and in front.
- **Typing:** no mic, or a noisy room? Pick who is speaking and type the lines in the box under the
  transcript. Everything else works the same. (Tab in the empty box switches speaker.)
- **A second cue** during a mediation is queued and handled next. **A third** gets soft wind chimes
  instead of more questions.
- **Cues & settings** (top right): change the wake phrase, add or switch off cues, and optionally
  teach Untangle each voice so it can label who is speaking.

## How it learns

Cues live in the browser's `localStorage` and persist between sessions:

- After each resolved misunderstanding the mediator may suggest new cue phrases it heard; they are
  added as *learned* cues.
- Each resolution asks "Was that a real misunderstanding?". "Yes" raises the cue's confidence;
  repeated "False alarm" answers retire the cue (the wake phrase can never be retired).

## How it's built

- `server.js` — zero-framework Node server: serves `public/` and proxies one mediator turn per
  request to Claude (`claude-opus-5-5` by default, override with `UNTANGLE_MODEL`).
- `public/app.js` — Web Speech API for recognition and the mediator's voice, Web Audio for the level
  meter, raised-voice detection, voice tagging and all sounds; plain DOM + SVG for the UI.
- `npm test` — end-to-end browser check of typed and voice modes (needs the server running and
  `npm i -D playwright && npx playwright install chromium`).
