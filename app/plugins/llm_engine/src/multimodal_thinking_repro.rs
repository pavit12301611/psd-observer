/// Reproduction tests for the Gemma 4 multimodal + thinking token flood bug.
///
/// All scenarios share ONE engine instance to avoid BackendAlreadyInitialized
/// (LlamaBackend::init() is a process-wide singleton in llama.cpp).
///
/// Required env vars (all tests skip if absent):
///   REPRO_MODEL_PATH   — path to a Gemma 4 GGUF model file
///   REPRO_MMPROJ_PATH  — path to the matching mmproj GGUF file
///
/// Optional env vars:
///   REPRO_IMAGE_PATH   — PNG/JPEG to use; falls back to a 1×1 PNG
///   REPRO_N_BATCH      — n_batch and n_ubatch (default: 512)
///   REPRO_IMAGE_TOKENS — image_min_tokens and image_max_tokens (default: 70)
///
/// Run:
///   REPRO_MODEL_PATH=... REPRO_MMPROJ_PATH=... REPRO_IMAGE_PATH=... \
///     cargo test multimodal_thinking -- --nocapture
///
/// What to watch for:
///   <unused49> / <unused*> / <unk> in token output  → attention mask bug confirmed
///   Assertion "non-causal attention requires n_ubatch >= n_tokens" → ubatch too small
///   Both baselines pass, repro_combined fails → cleanly isolates the bug

#[cfg(test)]
mod multimodal_thinking_repro {
    use std::path::PathBuf;
    use crate::{
        ChatContent, ChatContentPart, ChatMessage, ContextParams, LlmEngine, SamplerParams,
    };
    use base64::Engine as _;

    // ── Env helpers ──────────────────────────────────────────────────────────

    fn env_path(key: &str) -> Option<PathBuf> {
        std::env::var(key).ok().map(PathBuf::from)
    }
    fn env_u32(key: &str, default: u32) -> u32 {
        std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    }
    fn env_i32(key: &str, default: i32) -> i32 {
        std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    // ── Message builders ─────────────────────────────────────────────────────

    fn text_msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage { role: role.to_string(), content: ChatContent::Text(text.to_string()) }
    }

    fn image_msg(role: &str, text: &str, image: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: ChatContent::Parts(vec![
                ChatContentPart::Image { image: image.to_string() },
                ChatContentPart::Text { text: text.to_string() },
            ]),
        }
    }

    fn n_image_msg(role: &str, text: &str, image: &str, n: usize) -> ChatMessage {
        let mut parts: Vec<ChatContentPart> = (0..n)
            .map(|_| ChatContentPart::Image { image: image.to_string() })
            .collect();
        parts.push(ChatContentPart::Text { text: text.to_string() });
        ChatMessage { role: role.to_string(), content: ChatContent::Parts(parts) }
    }

    // ── Image loading ────────────────────────────────────────────────────────

    fn image_data_url() -> String {
        match env_path("REPRO_IMAGE_PATH") {
            Some(p) => {
                let bytes = std::fs::read(&p).expect("REPRO_IMAGE_PATH unreadable");
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png");
                let mime = if ext == "jpg" || ext == "jpeg" { "image/jpeg" } else { "image/png" };
                format!("data:{};base64,{}", mime, base64::prelude::BASE64_STANDARD.encode(&bytes))
            }
            None => {
                // Minimal 1×1 PNG fallback
                let png = base64::prelude::BASE64_STANDARD
                    .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==")
                    .unwrap();
                format!("data:image/png;base64,{}", base64::prelude::BASE64_STANDARD.encode(&png))
            }
        }
    }

    // ── Engine setup ─────────────────────────────────────────────────────────

    fn build_engine(model: PathBuf, mmproj: PathBuf, n_batch: u32, image_tokens: i32, n_ubatch: u32) -> LlmEngine {
        let mut engine = LlmEngine::new().expect("backend init failed");
        engine.set_use_gpu(false);
        engine.set_context_params(ContextParams {
            n_ctx: 512,
            n_ctx_multimodal: 512,
            n_batch,
            n_batch_multimodal: n_batch,
            n_ubatch,
            n_threads: 0,
            n_gpu_layers: -1,
            image_min_tokens: image_tokens,
            image_max_tokens: image_tokens,
        });
        engine.set_sampler_params(SamplerParams {
            temperature: 0.0, // greedy — deterministic for clean before/after comparison
            top_p: 1.0,
            top_k: 1,
            seed: 42,
            repeat_penalty: 1.0,
        });
        engine.load_model(model, "repro-model".to_string(), Some(mmproj))
            .expect("model load failed");
        engine
    }

    // ── Token collection + analysis ──────────────────────────────────────────

    fn run(engine: &mut LlmEngine, messages: Vec<ChatMessage>, thinking: bool) -> (String, Vec<String>) {
        let mut token_log: Vec<String> = Vec::new();
        let result = engine.generate(messages, thinking, |tok| {
            token_log.push(tok.to_string());
            token_log.len() < 200 // cap — enough to see flood pattern
        });
        let output = result.unwrap_or_else(|e| format!("[ERROR: {}]", e));
        (output, token_log)
    }

    fn unusual_count(tokens: &[String]) -> usize {
        tokens.iter().filter(|t| t.contains("unused") || t.contains("<unk>")).count()
    }

    fn print_summary(label: &str, output: &str, tokens: &[String]) {
        let unusual = unusual_count(tokens);
        println!("\n=== {} ===", label);
        println!("  tokens generated : {}", tokens.len());
        println!("  unusual (<unused*> / <unk>) : {}", unusual);
        println!("  first 20 : {:?}", &tokens[..tokens.len().min(20)]);
        if unusual > 0 {
            let samples: Vec<_> = tokens.iter().filter(|t| t.contains("unused")).take(5).collect();
            println!("  sample unusual : {:?}", samples);
        }
        println!("  output tail (200) : {:?}", &output[..output.len().min(200)]);
    }

    // ── Single test entry point — all scenarios share one engine ─────────────
    //
    // Rust runs #[test]s in parallel threads by default. Since LlamaBackend::init()
    // is a process-wide C singleton, multiple LlmEngine::new() calls in the same
    // process will fail. All scenarios live here so the backend is only init'd once.

    #[test]
    fn multimodal_thinking_scenarios() {
        let (Some(model), Some(mmproj)) = (env_path("REPRO_MODEL_PATH"), env_path("REPRO_MMPROJ_PATH")) else {
            println!("SKIP: set REPRO_MODEL_PATH and REPRO_MMPROJ_PATH to run");
            return;
        };

        let n_batch      = env_u32("REPRO_N_BATCH", 512);
        let image_tokens = env_i32("REPRO_IMAGE_TOKENS", 70);
        let img          = image_data_url();

        println!("\n[config] n_batch={} image_tokens={} model={:?}", n_batch, image_tokens, model);

        let mut engine = build_engine(model.clone(), mmproj.clone(), n_batch, image_tokens, 0);

        // ── Scenario 1: text-only + thinking ─────────────────────────────────
        // Expected: zero unusual tokens. Confirms thinking works on its own.
        {
            let msgs = vec![
                text_msg("system", "You are a concise assistant."),
                text_msg("user", "What is 2 + 2? Answer in one sentence."),
            ];
            let (out, toks) = run(&mut engine, msgs, true);
            print_summary("BASELINE text-only + thinking=true", &out, &toks);
            assert_eq!(unusual_count(&toks), 0, "text+thinking should produce zero unusual tokens");
        }

        // ── Scenario 2: multimodal + thinking=false ───────────────────────────
        // Expected: zero unusual tokens. Confirms multimodal works on its own.
        {
            let msgs = vec![
                text_msg("system", "You are a concise assistant."),
                image_msg("user", "Describe this image in one sentence.", &img),
            ];
            let (out, toks) = run(&mut engine, msgs, false);
            print_summary("BASELINE multimodal + thinking=false", &out, &toks);
            assert_eq!(unusual_count(&toks), 0, "multimodal+no-thinking should produce zero unusual tokens");
        }

        // ── Scenario 3: multimodal + thinking=true (THE BUG) ─────────────────
        // Expected: <unused49> floods or a crash. No assert — we want symptoms visible.
        {
            let msgs = vec![
                text_msg("system", "You are a concise assistant."),
                image_msg("user", "Describe this image in one sentence.", &img),
            ];
            let (out, toks) = run(&mut engine, msgs, true);
            print_summary("BUG REPRO multimodal + thinking=true", &out, &toks);
            println!("  >> unusual count: {} (>0 confirms the bug)", unusual_count(&toks));
        }

        // ── Scenario 4: small ubatch to deliberately trigger the bug ─────────
        // Sets n_ubatch=32, well below the image token count (70).
        // This should hit the non-causal assertion or produce floods.
        // If scenario 3 passed but this fails: ubatch size is confirmed as the cause.
        // If both pass: our version of llama.cpp may already handle this gracefully.
        {
            engine.unload();
            engine.set_context_params(ContextParams {
                n_ctx: 512,
                n_ctx_multimodal: 512,
                n_batch,
                n_batch_multimodal: n_batch,
                n_ubatch: 32, // deliberately smaller than image_tokens (70) to force the bug
                n_threads: 0,
                n_gpu_layers: -1,
                image_min_tokens: image_tokens,
                image_max_tokens: image_tokens,
            });
            engine.load_model(model.clone(), "repro-model".to_string(), Some(mmproj.clone()))
                .expect("model reload failed");
            let msgs = vec![
                text_msg("system", "You are a concise assistant."),
                image_msg("user", "Describe this image in one sentence.", &img),
            ];
            let (out, toks) = run(&mut engine, msgs, true);
            print_summary("EXPERIMENT ubatch=32 (force ubatch < image_tokens)", &out, &toks);
            let unusual = unusual_count(&toks);
            println!("  >> unusual: {}", unusual);
            println!("  >> crash/assertion = ubatch is the cause");
            println!("  >> 0 unusual = llama.cpp handles it or mtmd bypasses ubatch splitting");
        }

        // ── Scenario 5: 4× images, ubatch boundary stress ────────────────────
        // 4 × image_tokens must stay under n_batch or non-causal assertion fires.
        // Set REPRO_IMAGE_TOKENS=140 to intentionally overflow a 512 ubatch (560 tokens).
        {
            let msgs = vec![
                text_msg("system", "You are a concise assistant."),
                n_image_msg("user", "Describe each image briefly.", &img, 4),
            ];
            println!("\n  [stress] 4 images × {} tokens = {} vs n_batch={}",
                image_tokens, image_tokens * 4, n_batch);
            let (out, toks) = run(&mut engine, msgs, true);
            print_summary("STRESS 4 images + thinking=true", &out, &toks);
        }
    }
}
