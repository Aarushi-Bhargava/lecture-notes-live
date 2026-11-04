# Live Lecture Notes

A browser tool that listens to a lecture, transcribes it live, and turns it into bullet-point notes organized **slide by slide**.

I built this for a course where the professor speaks quickly and the slides cover only a fraction of what's said in class. Upload the lecture PDF, start recording, and press → whenever the professor changes slides. Everything said from then on is filed under that slide, so the notes and the deck line up without any work after the lecture.

**Live app:** https://aarushi-bhargava.github.io/lecture-notes-live/

<!-- Add a demo GIF here once you have one: ![Demo](demo.gif) -->

## Features

- **Live transcription** in the browser using the Web Speech API (Chrome / Edge)
- **Slide-synced notes**: upload a PDF deck, advance with arrow keys or a clicker, and notes attach to the current slide
- **AI-condensed bullets (optional)**: speech is summarized into concise notes every ~30 seconds, using the slide's own text to correct misheard technical terms and skip content already on the slide
- **Free AI providers with automatic failover**: Google Gemini and Groq free tiers (Anthropic Claude optional). If one provider errors or hits a rate limit, the next takes over; untranscribed speech is queued, never dropped
- **Exam and admin flags**: points the professor marks as important get ⚠, deadlines and logistics get 📌
- **Peek mode**: look back at earlier slides during recording without misfiling new notes
- **Edit as you go**: add your own notes, edit or delete bullets, move a bullet to the previous/next slide
- **Audio backup** with timestamps on every bullet, so any note can be checked against the recording
- **Autosave** to the browser, plus session files you can download and reopen
- **Export** to Markdown, or a printable page with each slide image above its notes (save as PDF)

## How it works

| Piece | Implementation |
|---|---|
| Speech-to-text | `webkitSpeechRecognition` in continuous mode, auto-restarted when Chrome ends a session |
| Slides | [PDF.js](https://mozilla.github.io/pdf.js/) renders pages and extracts each slide's text |
| Summarization | Batches ~70 words of new speech per slide and sends it with the slide text and existing bullets to an LLM; a prompt asks for only new, non-duplicate points |
| Failover | Providers are tried in order; failures put a provider on a cooldown (longer for auth errors, shorter for rate limits) |
| Storage | `localStorage` for sessions and settings; `MediaRecorder` for the audio backup |

Everything is a single static `index.html` with no build step and no backend. API keys are entered in the app, stored only in your own browser, and sent only to the provider they belong to.

## Usage

1. Open the live app in **Chrome or Edge** (Firefox doesn't support live speech recognition).
2. *(Optional)* Open **Settings** and paste a free [Gemini key](https://aistudio.google.com) and/or [Groq key](https://console.groq.com), then click **Test my keys**.
3. Upload the lecture PDF (export PowerPoint decks to PDF first).
4. Click **Start recording** and allow the microphone.
5. Press **→** / **PgDn** when the professor changes slides.
6. Afterwards: **Export & files → Download notes** or **Printable notes with slides**.

To run it locally instead, serve the folder over `localhost` (microphone access needs a secure context):

```bash
python3 -m http.server 8000
# then open http://localhost:8000

```

## Getting free API keys (optional)

The app works without any keys: every sentence the professor says becomes its own bullet. Add a free key to get condensed AI notes instead. Adding both is recommended, so if one provider is busy, the other takes over automatically.

Keys are stored only in your own browser and are never part of this repo. Don't share your keys; free limits are per account.

### Google Gemini
1. Go to [aistudio.google.com](https://aistudio.google.com) and sign in with a **personal** Google account (school accounts sometimes have AI Studio disabled).
2. Click **Get API key → Create API key**. If asked for a project, use the default or create one.
3. Copy the key (starts with `AIza`). No billing or credit card needed.

### Groq
1. Go to [console.groq.com](https://console.groq.com) and sign up with Google or GitHub.
2. Open **API Keys → Create API Key**, give it any name.
3. Copy the key right away (starts with `gsk_`); Groq only shows it once.

### Add them to the app
1. Open the app and click **Settings**.
2. Paste each key into its field and click **Test my keys**. You should see ✓ for each.
3. Click **Save**.

**Troubleshooting**
- *"Key rejected"*: the key was copied incorrectly; create a new one.
- *"High demand" / model busy (Gemini)*: Google's servers are overloaded, not your key. Change the Gemini **Model** box to `gemini-flash-lite-latest` (or `gemini-2.5-flash`), or set **Try this provider first** to Groq.
- *Model not found*: free model names change over time; check the provider's model list and update the **Model** box.
- Keys are saved per browser and per site, so you'll need to enter them again on a different computer or browser.

## Limitations

- Transcription quality depends on Chrome's speech service, the microphone, and room noise; it needs an internet connection.
- Free AI tiers have rate limits that providers change over time. Setting more words per AI update reduces requests.
- Check your course's policy on recording lectures before using the audio backup.

## Roadmap

- [ ] Whisper-based transcription for better accuracy on technical vocabulary
- [ ] Automatic slide-change detection from what the professor says
- [ ] Math rendering (KaTeX) in notes
- [ ] Search across all saved lectures

## License

MIT
