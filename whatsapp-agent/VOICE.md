# 🔊 VOICE.md — JARVIS ki awaaz (bolna + sunna), 100% free

3.0 me voice **poora naya** hai. Purani problem: default female robot awaaz
(espeak `en+f3`), niche dabaa hua Piper, aur WhatsApp pe voice sirf
`/voicereply` pe. Ab: ek **neural British butler voice**, ek hi voice-brain
teeno jagah — **asli WhatsApp call (WHATSAPP-CALL.md)**, **WhatsApp voice
notes**, aur **phone-app 📞 Call tab**.

---

## Sach pehle: "exact JARVIS voice"?

Film wala JARVIS = **Paul Bettany** ki asli awaaz. Uski exact copy/clone
free me legally ship **nahi** ho sakti — koi bhi tool ye dawa kare to jhooth
hai. Is project ne sabse **close free approximation** lagayi hai:

| Layer | Kya hai | Kyun JARVIS lagta hai |
|---|---|---|
| 🗣️ Voice | **Piper `en_GB-alan-medium`** (neural, offline) → backup `en_GB-ryan-high` → Edge-TTS `en-GB-RyanNeural` | shaant British male, measured pace |
| 🎚️ FX | ffmpeg warmth + presence + halki digital sheen (`TTS_FX=jarvis`) | film wali "system" feel |
| 🎩 Persona | "Very well, Sir." / "Shall I proceed, Sir?" wali butler bhasha har jawab me (`src/jarvis.js`) | awaaz se zyada *andaz* JARVIS banata hai |
| 🧬 Clone (optional) | apna Coqui **XTTS** server + apni reference clip (`XTTS_URL`) | agar tum khud clone banana chahte ho — advanced, apni zimmedari |

## Ek-command setup (PC pe, ek baar)

```bash
bash scripts/observer.sh voice setup     # Piper + en_GB voices (~90 MB), offline ready
bash scripts/observer.sh voice whisper   # local Whisper sunne ke liye (~150 MB)
bash scripts/observer.sh voice status    # kya-kya ready hai / kya baaki hai
bash scripts/observer.sh voice test      # test voice note WhatsApp pe
```

- `voice setup` Piper binary + `en_GB-alan-medium` + `en_GB-ryan-high` ko
  `~/.local/share/observer-voice/` me rakhta hai — agent khud dhoondh leta
  hai, `.env` chhedne ki zaroorat nahi.
- `voice whisper` whisper.cpp build karke `ggml-base` model rakhta hai —
  voice notes + live calls **bina internet** transcribe hote hain.
  Alternative: `GROQ_API_KEY` (free tier) — local na mile to wahi fallback.
- `ffmpeg` bhi chahiye (FX + Opus voice notes): `sudo dnf install ffmpeg`.
  Na ho to voice notes WAV me jayegi, rukega kuch nahi.

Status kabhi bhi: WhatsApp pe **`/voice`**, ya **`/doctor`** (voice wali
3 lines exact fix ke saath).

## TTS engine order (auto)

`XTTS clone → Piper en_GB → Edge-TTS en-GB-Ryan → espeak-ng → pico2wave →
flite → festival`

- Jo pehla mile wahi bolta hai. Hindi text English-only Piper ko nahi jati
  (Edge/espeak Hindi voice pe route hoti hai).
- Common jumle ("Good evening, Sir…") **cache** hote hain — greeting
  instant. Lambe jawab sentence-by-sentence bante hain (call me der kam).
- Preset: `TTS_VOICE=jarvis` (default) · `jarvis-deep` · purane `female` /
  `hindi` / `slow` / `fast` / `special` bhi chalenge.
- Awaaz gehri karni hai? `.env` me `JARVIS_PITCH=0.94`.

## Sunna (STT)

Voice note / call audio pehle **16 kHz mono WAV** banta hai (yahi purani
galti fix hui — pehle raw OGG whisper.cpp ko khilaya jata tha), phir:
**local whisper.cpp/Python whisper → Groq free tier**.

Sunne ke baad text JARVIS-normalize hota hai (`src/jarvis.js`):

- Devanagari → runnable Hinglish: `क्रोम खोलो` → `chrome kholo`
- Number words sirf unit ke paas digit bante hain: "do minute" → `2 minute`,
  par "bata do" ka `do` (give) bigadta nahi
- Wake-word saaf: "Jarvis, screenshot bhejo" → `screenshot bhejo`

## Teen chehre, ek dimag (`src/voicecall.js`)

| Surface | Kaise | Setup |
|---|---|---|
| 📞 Phone-app **Call tab** | browser mic → command → JARVIS bolke jawab; beech me bolo to ruk jata hai (barge-in) | **koi nahi** |
| 🎙️ WhatsApp **voice note** | note bhejo → transcribe → wahi command chalta hai | Whisper ya Groq key |
| ☎️ Asli **WhatsApp call** | seedha call karo, JARVIS uthata hai | `WHATSAPP-CALL.md` wala experimental engine |

Call-control sab jagah ek jaise: **"ruko/stop"** (bolna band + kaam rok),
**"dobara bolo"** (repeat), **"goodbye jarvis / chal bye"** (hangup),
**"haan/nahi"** — destructive kaam (app band, delete, power) pehle rukta
hai: *"Shall I proceed, Sir?"* — bina boli hui **haan** ke kuch nahi hota,
aur koi nayi baat haan nahi gin jati.

Ek saans me kai kaam bhi chalte hain: *"chrome kholo aur screenshot bhej
do"* → dono, order me. (Chain max 4; koi step confirm pe ruke to chain
wahi rukti hai.)

## Commands

| Command | Kaam |
|---|---|
| `/voice` | voice status (engines, call readiness) |
| `/call on` / `/call off` | WhatsApp Voice Mode — har jawab + JARVIS voice note |
| `/call` | call-centre status |
| `/callme [message]` | JARVIS tumhe WhatsApp call kare (VoIP engine chahiye) |
| `/callat at 18:30 /brief` | set time pe JARVIS khud call karke update de (engine na ho to voice note) |
| `/voicereply <text>` | ek voice note JARVIS ki awaaz me |

> 🇬🇧 **JARVIS sirf English bolta hai** (default, `JARVIS_ENGLISH_ONLY=true`):
> tum Hindi/Hinglish bolo — woh samajh lega, par British awaaz Hindi script
> kabhi nahi padhegi (wahi kharab pronunciation wala masla tha). Casual baat
> ("hello", "kaise ho", "thank you") ke jawab bhi call me instant English
> me milte hain; sawal AI short spoken sentences me deta hai.

## Advanced: true voice clone (XTTS)

```bash
# alag se Coqui XTTS API server chalao (daswer123/xtts-api-server), phir .env:
XTTS_URL=http://127.0.0.1:8020
XTTS_SPEAKER=jarvis.wav   # tumhari apni reference clip
```

Clone keval un awaazon ka banao jinpe tumhara haq ho. Server mile to voh
engine-order me sabse upar aa jata hai; na mile to Piper sambhal leta hai.
