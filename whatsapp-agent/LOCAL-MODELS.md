# 🏠 Sab kuch local — Hugging Face models, zero cloud

Ye guide tumhare liye hai: **koi API key nahi, koi cloud nahi, koi quota nahi.**
Model Hugging Face se download hota hai (ek hi baar), uske baad internet band
bhi kar do to agent chalta rahega.

Agent kisi bhi **OpenAI-compatible** local server se baat kar sakta hai —
`llama.cpp` ka `llama-server`, LM Studio, vLLM, koboldcpp. Neeche sab
llama.cpp se hai kyunki wo sabse halka aur Fedora pe sabse aasan hai.

---

## 0. Ek command me (recommended)

```bash
cd ~/observer-agent          # jahan package.json hai
./scripts/observer.sh models recommend     # dekho tumhare PC pe kya chalega
./scripts/observer.sh models setup best    # download + serve + agent wire (all-in-one)
```

Script file nahi hai? Ek hi file me sab kuch hai — pehle ise le lo:

```bash
curl -fL -o /tmp/observer.sh \
  "https://raw.githubusercontent.com/pavit12301611/psd-observer/arena/1cff19d3-psd-observer/whatsapp-agent/scripts/observer.sh"
bash /tmp/observer.sh models recommend
```

Installed folder ke andar hai to `./scripts/observer.sh` bhi wahi command hai.

`setup` ye 4 kaam karta hai:

1. `huggingface_hub` + `llama.cpp` install (agar nahi hain)
2. GGUF download → `~/models/<model>/`
3. `llama-server` chalu (systemd user service, reboot ke baad bhi chalta rahe)
4. `.env` me `AI_PROVIDER=local` + `LOCAL_API_URL` + `LOCAL_MODEL` likh deta hai

Phir WhatsApp pe **`/brains`** bhejo — local model live dikhega.

Chhota model chahiye:

```bash
./scripts/observer.sh models setup balanced --small tiny --vision balanced
```

- `--small` = chhote kaam ("chrome kholo", "hi") isi pe jayenge → fast + light
- `--vision` = photos/screenshots samajhne ke liye
- har model apne port pe chalta hai (8080 main, 8081 small, 8082 heavy, 8083 vision)

---

## 1. Kaunsa model? (Oct 2026 ke best local models)

Pehle apna budget dekho:

```bash
./scripts/observer.sh models detect
```

| Tumhare paas | Model | Hugging Face | ~Size | Kyun |
|---|---|---|---|---|
| **24 GB+ VRAM / 32 GB RAM** | **Qwen3.8-27B** | [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) | 17.9 GB | 2026 ka #1 local model — vision + agentic tool use, 256K context |
| 16–24 GB RAM, **CPU-only laptop** | **Gemma 4 26B-A4B** | [`ggml-org/gemma-4-26B-A4B-it-GGUF`](https://huggingface.co/ggml-org/gemma-4-26B-A4B-it-GGUF) | ~16 GB | MoE — sirf 4B active per token, isliye CPU pe bhi tez |
| 20–24 GB | **gpt-oss-20b** | [`unsloth/gpt-oss-20b-GGUF`](https://huggingface.co/unsloth/gpt-oss-20b-GGUF) | 15.8 GB | strong reasoning + tool calls, MoE |
| 12–16 GB | **Gemma 4 12B** | [`ggml-org/gemma-4-12B-it-GGUF`](https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF) | 7.4 GB | 256K ctx, screenshots padh leta hai, best all-rounder |
| 16 GB | **Qwen3-14B** | [`unsloth/Qwen3-14B-GGUF`](https://huggingface.co/unsloth/Qwen3-14B-GGUF) | ~9 GB | reliable tool calling (plain text) |
| 6–8 GB | **Qwen3.5-4B** | [`unsloth/Qwen3.5-4B-GGUF`](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) | ~2.6 GB | everyday laptop, vision-capable |
| 2–4 GB / sirf CPU | **Qwen3.5-0.8B** | [`unsloth/Qwen3.5-0.8B-GGUF`](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF) | ~0.6 GB | "kholo/band karo" jaise kaam, instant |

Short keys jo script me use hote hain:
`best` · `efficient` · `reason` · `balanced` · `classic` · `light` · `tiny`

> **Note:** `Qwen3.8-27B` ka best quant `UD-Q4_K_XL` hai (unsloth ka Dynamic
> V3.0). 24 GB card pe wahi lo — Q4 me quality ~lossless hai aur context ke liye
> room bachta hai. 16 GB pe `UD-Q3_K_XL` (~13 GB) bhi chalta hai.

---

## 2. Hugging Face download commands (copy-paste)

Ye wahi commands hain jo script chalata hai. Manually karna ho to:

### 2a. Tooling (ek hi baar)

```bash
# downloader
python3 -m pip install --user --upgrade "huggingface_hub[cli]" hf_transfer

# llama.cpp (llama-server + llama-cli) — official installer
curl -LsSf https://llama.app/install.sh | sh

# check
hf --help | head -3
llama-server --version
```

Fedora package bhi hai: `sudo dnf install llama-cpp` (agar available ho).
GPU ke liye CUDA build chahiye to: <https://github.com/ggml-org/llama.cpp/releases>

### 2b. Qwen3.8-27B — best overall (vision + agentic)

```bash
hf download unsloth/Qwen3.8-27B-GGUF \
  --include "*UD-Q4_K_XL*" \
  --local-dir ~/models/Qwen3.8-27B
```

File: `Qwen3.8-27B-UD-Q4_K_XL.gguf` (~17.9 GB)

> 16 GB machine: `--include "*UD-Q3_K_XL*"` (~13 GB) lo.

### 2c. Gemma 4 26B-A4B — CPU laptops ka best (MoE)

```bash
hf download ggml-org/gemma-4-26B-A4B-it-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/gemma-4-26b-a4b
```

### 2d. gpt-oss-20b — reasoning + tools

```bash
hf download unsloth/gpt-oss-20b-GGUF \
  --include "*UD-Q4_K_XL*" \
  --local-dir ~/models/gpt-oss-20b
```

### 2e. Gemma 4 12B — vision + 256K context, 12 GB machines

```bash
hf download ggml-org/gemma-4-12B-it-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/gemma-4-12b
```

### 2f. Chhote models (router ke "tiny" slot ke liye)

```bash
hf download unsloth/Qwen3.5-0.8B-GGUF --include "*Q4_K_M*" --local-dir ~/models/qwen3.5-0.8b
hf download unsloth/Qwen3.5-4B-GGUF   --include "*Q4_K_M*" --local-dir ~/models/qwen3.5-4b
```

### 2g. Koi bhi aur repo (script se)

```bash
./scripts/observer.sh models download Qwen/Qwen3.5-9B-GGUF --quant Q4_K_M
./scripts/observer.sh models commands Qwen/Qwen3.5-9B-GGUF --quant Q4_K_M   # sirf commands print
```

### 2h. Ollama pasand hai? (same GGUF, Ollama manage karega)

```bash
ollama pull hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL
# ya
./scripts/observer.sh models ollama best
```

---

## 3. Model chalao (serve)

### Sabse aasan

```bash
./scripts/observer.sh models serve best
```

### Manually (llama.cpp direct, HF se auto-download)

```bash
llama-server -hf unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL \
  --host 127.0.0.1 --port 8080 \
  --jinja -c 8192 -ngl 99
```

- `-ngl 99` = poora model GPU pe. GPU nahi hai to `-ngl 0` aur `-c 4096`.
- `--jinja` **zaroori** hai tool-calling ke liye (agent ko tools chahiye).
- `-c 8192` = context. 27B pe 16K+ chahiye to RAM/VRAM badhao.
- Server: <http://127.0.0.1:8080> (OpenAI-compatible `/v1` + web UI)

### Downloaded file se (offline)

```bash
llama-server -m ~/models/Qwen3.8-27B/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --host 127.0.0.1 --port 8080 --jinja -c 8192 -ngl 99
```

### Test karo

```bash
curl -s http://127.0.0.1:8080/v1/models

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"Namaste, tum kaun ho?"}]}'
```

---

## 4. Agent ko wire karo

Script se (recommended):

```bash
./scripts/observer.sh models wire best --small tiny --vision balanced
systemctl --user restart observer-whatsapp-agent
```

Ya `.env` me haath se:

```env
AI_PROVIDER=local
LOCAL_API_URL=http://127.0.0.1:8080/v1
LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL

# optional (router ke liye)
LOCAL_API_URL_SMALL=http://127.0.0.1:8081/v1
LOCAL_MODEL_SMALL=unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M
LOCAL_API_URL_VISION=http://127.0.0.1:8080/v1
LOCAL_MODEL_VISION=ggml-org/gemma-4-12B-it-GGUF:Q4_K_M
ROUTER_PREFER=local
```

`AI_PROVIDER=local` ka matlab: **sirf is PC ka model** — cloud fallback nahi,
kabhi nahi. (`auto` likha to local pehle try hota hai, phir cloud keys agar
set hain.)

---

## 5. Multimodal, sab local

Photos / screenshots **PC se bahar nahi jaate**:

- `LOCAL_MODEL_VISION` (ya `OLLAMA_VISION_MODEL`) set hai → photo/OCR usi local
  model se samjha jaata hai.
- Screenshot OCR pehle se local `tesseract` se hota hai.
- Voice notes: local `whisper.cpp` (ya Groq key ho to wo, optional).
- TTS: local `piper`.

`/brains` me vision model pe `vision` tag dikhega.

---

## 6. Kya kya commands hain

| Command | Kaam |
|---|---|
| `./scripts/observer.sh models list` | models + RAM requirement |
| `./scripts/observer.sh models detect` | tumhare PC ka RAM/GPU |
| `./scripts/observer.sh models recommend` | is machine ke liye best combo |
| `./scripts/observer.sh models commands <model>` | Hugging Face download + run commands print |
| `./scripts/observer.sh models download <model>` | GGUF download (`hf`, fallback curl) |
| `./scripts/observer.sh models serve <model>` | llama-server chalao |
| `./scripts/observer.sh models wire <model>` | `.env` likho |
| `./scripts/observer.sh models setup <model>` | download + serve + wire (all-in-one) |
| `./scripts/observer.sh models ollama <model>` | wahi GGUF Ollama se |
| `./scripts/observer.sh models status` | kya install/chalu hai |

WhatsApp pe: `/brains`, `/brains why <task>`, `/model`, `/doctor`.

---

## 7. Sach (limits batao, chhupao mat)

- **27B CPU pe slow hai** (2–6 tokens/sec) — chat theek, multi-step `+` slow.
  Isliye `--small` chhota model lagao: "chrome kholo" 0.8B pe instant hoga.
- **Model loading me 10–60s** lag sakta hai (pehli request). Server chalta rehne
  do — systemd service isi liye hai.
- **Quant chhota = quality kam.** Q4 se neeche tabhi jao jab RAM majboori ho.
- **Vision** tabhi kaam karega jab model me vision ho (Qwen3.8-27B, Gemma 4,
  Qwen3.5-4B) aur `LOCAL_MODEL_VISION` set ho.
- Bade model ke liye `-ngl 99` ke saath bhi VRAM kam pade to llama.cpp layers
  CPU pe daal deta hai — kaam karega, dheema.

---

## 8. Reset / band karna

```bash
systemctl --user stop observer-model            # main
systemctl --user stop observer-model-small      # small
systemctl --user disable observer-model-small
# models delete:
rm -rf ~/models/best
# wapas cloud/auto pe:
# .env me AI_PROVIDER=auto kar do
```
