# 🔑 Free API keys — Groq + OpenRouter (+ Gemini)

Agent **bina kisi key ke bhi chalta hai** (local GGUF, Ollama, ya sirf built-in
commands). Ye guide un keys ke liye hai jo **free tier** pe milti hain aur do
cheezein add karti hain:

1. **Fast cloud brain** — jab PC pe model na ho, ya phone se turant jawab chahiye.
2. **Free voice notes + photos** — Groq ki key se voice transcription free hai,
   aur Groq/OpenRouter dono ke paas free vision models hain.

> Har key **optional** hai. Ek bhi na lo to kuch nahi tootta.

---

## 0. Ek command me (sabse aasan)

```bash
cd ~/observer-agent

./scripts/observer.sh keys                          # kya set hai (masked)
./scripts/observer.sh keys groq gsk_xxxxxxxxxxxx    # Groq key add/replace
./scripts/observer.sh keys openrouter sk-or-v1-xxx  # OpenRouter key
./scripts/observer.sh keys gemini AIza...           # Gemini key
./scripts/observer.sh keys --test                   # saved keys test karo
./scripts/observer.sh keys --remove groq            # key hatao
```

Script `.env` me likhta hai, key ko provider ke saath verify karta hai (401 aaye
to bata deta hai), aur service restart kar deta hai. Phir WhatsApp pe **`/model`**
bhejo — key dikh jayegi.

Manually karna ho:

```bash
cd ~/observer-agent
nano .env
# ye lines bhar do:
# GROQ_API_KEY=gsk_...
# OPENROUTER_API_KEY=sk-or-v1-...
```

---

## 1. Groq — sabse fast free brain

**Key lo:** <https://console.groq.com/keys> → *Create API Key* (Google/GitHub se
login, card nahi chahiye).

### Free tier limits (Oct 2026)

| Model | RPM | Requests/day | Tokens/min | Tokens/day |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1,000 | 8,000 | 200,000 |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8,000 | 200,000 |
| `qwen/qwen3.8-27b` (vision) | 30 | 1,000 | 8,000 | 200,000 |
| `whisper-large-v3-turbo` (voice) | 20 | 2,000 audio req | — | — |

> ⚠️ **Llama 3.1 8B aur 3.3 70B 16 Aug 2026 se free tier pe nahi hain**
> (enterprise-only). Isliye is agent ka default ab `gpt-oss` hai — purane
> `GROQ_MODEL=llama-3.3-70b-versatile` se 404 aayega.
> `observer.sh update` aur `observer.sh keys` purane Llama IDs ko khud
> `gpt-oss` pe badal dete hain (warning ke saath), to key daalte hi kaam karega.

### Kaun sa model kya karta hai

| Kaam | Model | Kyun |
|---|---|---|
| Chhote kaam, "hi", "chrome kholo" | `openai/gpt-oss-20b` | sabse fast/cheap |
| Tool calling, multi-step, coding | `openai/gpt-oss-120b` | strongest free Groq model |
| Photos / screenshots padhna | `qwen/qwen3.8-27b` | Groq ka **only** free vision model (max 3 images, 20 MB) |
| Voice note → text | `whisper-large-v3-turbo` | free, 2,000 audio requests/day |

### `.env` me

```ini
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=openai/gpt-oss-120b
GROQ_MODEL_SMALL=openai/gpt-oss-20b
GROQ_VISION_MODEL=qwen/qwen3.8-27b
```

`GROQ_VISION_MODEL=` (khali) kar dene se Groq vision band ho jayega — photos
phir local ya Gemini se jayengi.

### Seedha test (curl)

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-oss-120b","messages":[{"role":"user","content":"hi"}]}'
```

---

## 2. OpenRouter — sabse zyada free models, ek key

**Key lo:** <https://openrouter.ai/keys> → *Create Key* (card nahi chahiye).

### Free tier limits (Oct 2026)

| Cheez | Limit |
|---|---|
| Requests/minute | **20** (har free model) |
| Requests/day | **50** (naya account) |
| Requests/day after **$10 lifetime top-up** | **1,000** (permanent) |
| Cost | $0 per token on `:free` models |

`$10` ek baar khareedne se daily limit 50 → 1,000 ho jati hai (balance khatam
hone ke baad bhi). Card nahi dena chahte to 50/day se shuru karo — chat ke liye
kaafi hai, daily agent ke liye kam.

### Free models jo is agent ke liye theek hain

| Model ID | Context | Vision | Tools | Note |
|---|---|---|---|---|
| `google/gemma-4-31b-it:free` | 262K | ✅ | ✅ | **default** — image + tool calling |
| `google/gemma-4-26b-a4b-it:free` | 262K | ✅ | ✅ | MoE, faster, almost same quality |
| `openai/gpt-oss-120b:free` | 131K | ❌ | ✅ | tool-calling ke liye solid |
| `qwen/qwen3-235b-a22b:free` | 262K | ❌ | ✅ | bada model, kabhi busy |
| `openrouter/free` | varies | ✅ | ✅ | **auto-router** — jo free model available ho, wahi chun leta hai |

**Rule:** free model ka ID `:free` pe khatam hona chahiye. Baaki sab paid hai.

```ini
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx
OPENROUTER_MODEL=google/gemma-4-31b-it:free
# optional: alag vision model (khali = main model hi photos dekhega)
OPENROUTER_VISION_MODEL=
```

### Sach jo pata hona chahiye

- Free endpoints **upstream provider** se serve hote hain. `429` ka matlab
  aksar "tumhara quota nahi, provider full hai" — agent us brain ko cooldown
  pe daal ke agle pe chala jata hai, isliye WhatsApp atakta nahi.
- Free models **kabhi bhi** delist ho sakte hain. `openrouter/free` isliye
  handy hai — model rotate ho jaye to bhi kaam chalta rahega.
- Free hosts **training ke liye data use kar sakte hain** (setting se off kar
  sakte ho). Personal screenshots bhejne hain to local vision better hai.

---

## 3. Dono laga do — router kya karega

`AI_PROVIDER=auto` (default) me router har message ka size dekhta hai:

| Message type | Pehle kya | Cloud key hone pe |
|---|---|---|
| "hi", "chrome kholo" | local small / Ollama | **Groq gpt-oss-20b** (fast) |
| Normal chat / sawaal | local / Ollama | Groq gpt-oss-120b, phir OpenRouter |
| Bada task (code, report) | best local | **Groq 120b** → OpenRouter → local |
| Photo / screenshot | local vision | local → Gemini → **Groq qwen3.8** → OpenRouter |
| Voice note | local whisper | **Groq whisper** (free) |

- `ROUTER_PREFER=local` (default) — local pehle, cloud backup.
- `ROUTER_PREFER=cloud` — cloud pehle (PC slow ho to).
- `AI_PROVIDER=local` — **sirf local**, cloud kabhi nahi (keys hone pe bhi).
- `AI_PROVIDER=groq` — sirf Groq.

Fail hone pe brain `MODEL_COOLDOWN_MS` (default 2 min, double hota hai) ke liye
skip hota hai, aur heavy calls ka hourly budget hai (`MAX_HEAVY_PER_HOUR=12`).

---

## 4. Kaunsa lena chahiye? (seedha jawab)

| | Groq | OpenRouter |
|---|---|---|
| Speed | ⚡⚡⚡ (LPU, sabse fast) | ⚡ (provider pe depend) |
| Free daily quota | **1,000/model** | **50** (1,000 after $10) |
| Models | 2 text + 1 vision + whisper | 20+ free, har flavour |
| Tool calling | ✅ gpt-oss | ✅ (model ke hisaab se) |
| Vision | ✅ qwen3.8-27b | ✅ Gemma 4 31B |
| Voice notes | ✅ free whisper | ❌ |
| 429 risk | kam | zyada (upstream busy) |
| Best for | **primary free brain** | **backup + model menu** |

**Verdict:** Groq lo pehle — 1,000 requests/day, super fast, tool calling, vision
aur free voice notes, sab ek key me. OpenRouter ko **dusre brain** ki tarah laga
lo (Groq down/busy ho to kaam chalta rahega), ya jab koi specific free model
chahiye. Dono free hain, dono optional hain — aur local phir bhi sabse private
aur unlimited hai.

---

## 5. Check karna ki chal raha hai

```bash
# key saved + verified?
./scripts/observer.sh keys
./scripts/observer.sh keys --test

# agent kya use kar raha hai?
# WhatsApp pe:
/model      # provider + models + kaunsi key set hai
/brains     # live routing, health, cooldowns, budget
/doctor     # poora check + exact fix
```

Agar `/model` me key dikh rahi hai par jawab nahi aa raha:

```bash
journalctl --user -u observer-whatsapp-agent -n 50 --no-pager
# "401" → key galat; "429" → free quota/upstream busy (cooldown khud lag jata hai)
# "404 model_not_found" → GROQ_MODEL purana hai, gpt-oss use karo
```

---

## 6. Safety

- Keys **sirf** `.env` me (git me nahi jata, update me safe rehta hai).
- WhatsApp pe kabhi key mat bhejo — agent ko zaroorat nahi hai.
- Key leak ho jaye to console se **revoke** karo aur nayi daal do.
- `AI_PROVIDER=local` se cloud **poori tarah** band — keys hone ke bawajood.
