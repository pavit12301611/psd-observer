# ☎️ WHATSAPP-CALL.md — seedha WhatsApp call karo, JARVIS uthayega

**Tum:** agent number pe WhatsApp **voice call** karte ho.
**JARVIS:** call utha kar bolta hai — *"Good evening, Sir. How may I
assist you?"* Tum bolke instruction dete ho ("chrome kholo aur screenshot
bhej do"), configured AI models use command me badal ke PC pe execute
karte hain, aur result **usi call me bol ke** milta hai. "Goodbye,
JARVIS" bolte hi hangup + chat me chhota summary.

---

## Pehle poora sach (3 baatein)

1. **Official Baileys call utha hi nahi sakta.** Sirf call *dekh* sakta
   hai aur `rejectCall` kar sakta hai — media/audio usme hai hi nahi.
   Isliye asli pickup ke liye ek **experimental VoIP engine**
   ([`baileys-caller`](https://github.com/Akane7101/baileys-caller) —
   WhatsApp Web ka VoIP WASM) lagaya gaya hai. Yeh default **OFF** hai;
   ON karna tumhara faisala hai.
2. **Yeh unofficial/ToS-grey hai** — bilkul Baileys ki tarah. Risk agent
   number (doosra SIM) pe rakho, main number kabhi mat lagao. WhatsApp
   protocol badle to engine toot sakta hai — isliye neeche wala fallback
   hamesha zinda rehta hai.
3. **Engine OFF/fail ho to call zaya nahi jati:** owner ki call detect
   hote hi call kaat ke **turant JARVIS voice-note session** chalu ho
   jata hai (voice mode ON + greeting voice note) — tum voice note bhej
   ke waise hi baat kar sakte ho. Phone-app ka **📞 Call tab** to bina
   kisi setup ke hamesha hai hi.

## Setup (ek baar, ~5 minute)

```bash
bash scripts/observer.sh voice setup        # JARVIS ki awaaz (Piper en_GB)
bash scripts/observer.sh voice whisper      # sunna, offline (ya GROQ_API_KEY)
bash scripts/observer.sh voice call-engine  # baileys-caller install
bash scripts/observer.sh voice link-voip    # QR scan — 2nd linked device
bash scripts/observer.sh voice answer on    # WA_CALL_ANSWER=true + restart
```

Phir apne phone se agent number pe **seedha WhatsApp voice call** karo.

> 📱 `link-voip` pe QR **agent number wale phone** se scan karna hai
> (WhatsApp → Linked devices). Yeh ek **alag** linked device hai
> (`auth_info_voip/`) — messaging wala login alag rehta hai, dono ladte
> nahi. Agent phone ko **silent/DND** pe rakho, warna VoIP device ke
> uthane se pehle woh bajega.

Kya-kya ready hai: `observer.sh voice status`, WhatsApp pe `/call`, ya
`/doctor` (voice section exact fix deta hai).

## Call me kya-kya chalega

- 🎙️ **Natural baat:** tum Hindi/Hinglish/English bolo — JARVIS samjhega
  aur **sirf English me jawab dega** (British awaaz, saaf pronunciation;
  `JARVIS_ENGLISH_ONLY=false` se band kar sakte ho). "jarvis, thesis wali
  PDF dhundo aur bhej do" — Devanagari transcription bhi command ban jati hai.
- 💬 **Casual baat + sawal:** "hello", "kaise ho", "thank you" pe instant
  butler jawab (bina internet/brain ke bhi), aur asli sawalo ("what is the
  capital of France?") ke jawab AI chhote spoken English sentences me
  dega; lamba detail chat me text ban ke aayega. Call khatm hone pe chat
  me chhota **transcript** bhi milta hai.
- 🔗 **Ek saath kai kaam:** "chrome kholo **aur** screenshot bhej do".
- 🔒 **Safety gate waise ka waisa:** app band/delete/power jaise kaam
  pehle rukenge — *"Shall I proceed, Sir?"* — tumhari boli hui **"haan"**
  ke bina kuch nahi hoga. Galti se kuch aur bol diya to woh haan **nahi**
  gina jata.
- 🗣️ **Barge-in:** JARVIS bol raha ho aur tum beech me bolo — woh ruk ke
  sunta hai. **"Ruko"** = bolna + chal raha kaam dono band.
- 🔁 **"Dobara bolo"** repeat · **"Goodbye JARVIS / chal bye"** hangup.
- ⏱️ Max call length default 15 min (`WA_CALL_MAX_MINUTES`), uske baad
  khud shukriya bol ke kaat deta hai. Call ke baad chat me short summary.

## Kaun si call uthegi? (security)

| Caller | Hoga kya |
|---|---|
| ✅ Tum (owner number / tumhara known LID / `callerPn` match) | JARVIS uthayega |
| ❓ Unknown number ya unknown `@lid` | **Kabhi nahi uthegi** — default ignore (chaho to `WA_CALL_UNKNOWN=reject`) |
| 👥 Group / video call | Reject (sirf 1-to-1 voice) |
| 📵 Dusri call jab ek chal rahi ho | Busy/reject |

PC control sirf owner-verified caller ko hi milta hai — naam sun ke ya
awaaz sun ke kabhi nahi, sirf number/LID match pe.

## Fallback ladder (engine na ho tab)

`WA_CALL_FALLBACK` (.env):

| Value | Owner call aane par |
|---|---|
| `voice-session` *(default)* | call cut → voice mode ON → JARVIS greeting **voice note** + honest text. Tum voice note bhejo, baat chalegi. |
| `reject` | call cut + sirf text sandesh |
| `ignore` | kuch mat karo, agent phone bajta rahe |

Engine ON ho par kisi wajah se call answer na kare (~12s), to bhi yahi
fallback sambhal leta hai — tum latke nahi rehoge.

## /callme — JARVIS khud call kare

Engine ready ho to WhatsApp pe **`/callme`** bhejo: JARVIS tumhe call
karke greeting bolega, phir normal call jaise instructions lo.
`/callme <message>` se greeting ke baad wahi line bolke sunna shuru karega.

## ⏰ /callat — set time pe JARVIS ki update-call

```
/callat at 18:30 /brief        (6:30 baje call aayegi, taaza brief bolega)
/callat in 30m Dinner ready hai, khana kha lena
/callat tomorrow 9am /weather delhi
```

Waqt pe JARVIS **khud call karega**, update bolega, aur line khuli
rakhega — tum wahin se aage instructions de sakte ho. Message `/` se
shuru ho to woh command **usi waqt** chalti hai (taaza output). Engine
us pal ready na ho to update **voice note + text** me aa jayega — miss
nahi hoga. List/cancel: `/callat`, `/callat del <#>`. Live call me bhi
bol sakte ho: *"Jarvis, call me at 6 and give me the brief."*

## Troubleshooting

| Symptom | Fix |
|---|---|
| Call cut hote hi voice note aa gaya | Fallback chala — **usi message me exact wajah + fix likha hota hai** (engine install nahi / device link nahi / connect fail / ready par answer nahi). Wahi ek command chalao. Sabse common: purane installer pe peer-deps fail — `bash scripts/observer.sh voice call-engine` dobara |
| Call bajti rehti hai, JARVIS nahi uthata | **`bash scripts/observer.sh voice doctor`** — ek hi dump me stage + engine ki live diary + journal ki call-lines. Diary dekhte hi samajh aa jayega chain kahan tooti: `connect:ok` hi nahi → engine/connect; `connect:ok` hai par `incoming` nahi → offer engine tak nahi pahuncha (agent number ki privacy setting? journal me `[voip-wasm]` reason); `answering` ke baad `call-ended` → journal me uska reason. Note: engine ko accept me kabhi-kabhi ~20s lagte hain — 5–6 ring tak ruko. owner call `@lid` me aaye to bhi cross-check se uth jati hai |
| Diary me `call-ended — accept_timeout · 20s` | WASM ne offer buffer me park karke kabhi active banaya hi nahi. Wajah (3.1.3 me fix): engine `checkOngoingCalls()` kabhi bulata hi nahi tha, jo WASM ko jaga kar `<lobby>`→`<preaccept>` ki chain shuru karta hai. Doctor me **`engine patch`** stage dekho — MISSING ho to `bash scripts/observer.sh voice call-engine` chalao (patch + restart khud ho jayega). Phir bhi aaye to `.env` me `WA_VOIP_LOG_LEVEL=2` laga ke ek test call + doctor output bhejo |
| QR scan ke baad bhi "not linked" | `voice link-voip` dobara; agent phone pe Linked devices me naya device dikhna chahiye; phir `voice answer on` (restart) |
| JARVIS sunta hai par jawab robotic hai | `voice setup` (Piper) nahi chala — espeak pe gir gaya hai. `/voice` dekho |
| Awaaz samajh nahi aati / galat transcript | `voice whisper` se local base model; ya `GROQ_API_KEY`; shor kam rakho, waqfa deke bolo |
| Call judti hai, kuch sunai nahi deta | `ffmpeg` install karo (`sudo dnf install ffmpeg`) + `/doctor` |
| Engine baar-baar fail | `voice answer off` karke fallback pe raho; engine experimental hai, WhatsApp ke protocol change pe toot sakta hai |

## Files

`src/wavoip.js` (engine adapter — answer, VAD, PCM playback, barge-in) ·
`src/voicecall.js` (shared dimag) · `src/jarvis.js` (bhasha) ·
`src/whatsapp.js` (`call` events + fallback coordination) ·
`scripts/link-voip.mjs` (QR linking) · `observer.sh voice …` (setup)

Awaaz/sunne ki poori guide: **[`VOICE.md`](VOICE.md)**.
