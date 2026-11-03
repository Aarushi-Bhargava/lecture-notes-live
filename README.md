# Live Lecture Notes

A browser tool that listens to a lecture, transcribes it live, and turns it into bullet-point notes organized **slide by slide**.

I built this for a course where the professor speaks quickly and the slides cover only a fraction of what's said in class. Upload the lecture PDF, start recording, and press → whenever the professor changes slides. Everything said from then on is filed under that slide, so the notes and the deck line up without any work after the lecture.

**Live app:** https://YOUR-USERNAME.github.io/lecture-notes-live/

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
