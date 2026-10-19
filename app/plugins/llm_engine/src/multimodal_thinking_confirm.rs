/// Confirmation test: multimodal + thinking works when n_ubatch >= image_max_tokens.
///
/// Prints thinking tokens and response tokens separately so you can verify
/// the model is genuinely reasoning about the image, not hallucinating.
///
/// Required env vars:
///   CONFIRM_MODEL_PATH  — path to Gemma 4 GGUF
///   CONFIRM_MMPROJ_PATH — path to mmproj GGUF
///   CONFIRM_IMAGE_PATH  — image to describe (PNG or JPEG)
///
/// Run:
///   CONFIRM_MODEL_PATH=src/gemma-4-E2B-it-UD-Q4_K_XL.gguf \
///   CONFIRM_MMPROJ_PATH=src/mmproj-F16.gguf \
///   CONFIRM_IMAGE_PATH=OfficialLogo.png \
///   cargo test confirm_multimodal_thinking -- --nocapture

#[cfg(test)]
mod multimodal_thinking_confirm {
    use std::path::PathBuf;
    use crate::{ChatContent, ChatContentPart, ChatMessage, ContextParams, LlmEngine, SamplerParams};
    use base64::Engine as _;

    fn env_path(key: &str) -> Option<PathBuf> {
        std::env::var(key).ok().map(PathBuf::from)
    }

    fn load_image(path: PathBuf) -> String {
        let bytes = std::fs::read(&path).expect("image unreadable");
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
        let mime = if ext == "jpg" || ext == "jpeg" { "image/jpeg" } else { "image/png" };
        format!("data:{};base64,{}", mime, base64::prelude::BASE64_STANDARD.encode(&bytes))
    }

    #[test]
    fn confirm_multimodal_thinking() {
        let (Some(model), Some(mmproj), Some(image)) = (
            env_path("CONFIRM_MODEL_PATH"),
            env_path("CONFIRM_MMPROJ_PATH"),
            env_path("CONFIRM_IMAGE_PATH"),
        ) else {
            println!("SKIP: set CONFIRM_MODEL_PATH, CONFIRM_MMPROJ_PATH, CONFIRM_IMAGE_PATH");
            return;
        };

        let img = load_image(image);

        let mut engine = LlmEngine::new().expect("backend init failed");
        engine.set_use_gpu(false);
        engine.set_context_params(ContextParams {
            n_ctx: 1024,
            n_ctx_multimodal: 1024,
            n_batch: 512,
            n_batch_multimodal: 512,
            n_ubatch: 0, // 0 = match n_batch (512 >= 70 image tokens → safe)
            n_threads: 0,
            n_gpu_layers: -1,
            image_min_tokens: 70,
            image_max_tokens: 70,
        });
        engine.set_sampler_params(SamplerParams {
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            seed: 42,
            repeat_penalty: 1.0,
        });
        engine.load_model(model, "confirm-model".to_string(), Some(mmproj))
            .expect("model load failed");

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: ChatContent::Text(
                    "You are a careful visual assistant. Think step by step about what you see before answering.".to_string(),
                ),
            },
            ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Parts(vec![
                    ChatContentPart::Image { image: img },
                    ChatContentPart::Text {
                        text: "What is in this image? Describe any text, colors, and layout you can see".to_string(),
                    },
                ]),
            },
        ];

        // Gemma 4 thinking delimiters:
        //   Variant A (explicit):  <|channel>thought ... <channel|> response
        //   Variant B (quantized): [thinking prose]  ... <channel|> response
        //
        // Strategy: assume we start in thinking mode. Discard the open marker if
        // it appears, split on the close marker into thinking vs response.
        let think_open  = "<|channel>thought";
        let think_close = "<channel|>";

        let mut thinking_buf     = String::new();
        let mut response_buf     = String::new();
        let mut in_thinking      = true;
        let mut seen_think_close = false;
        let mut lookahead        = String::new();

        println!("\n{}", "=".repeat(60));
        print!("[THINKING START]\n");

        let result = engine.generate(messages, true, |tok| {
            lookahead.push_str(tok);

            loop {
                if !seen_think_close {
                    // Discard explicit open marker if present (variant A)
                    if lookahead.starts_with(think_open) {
                        lookahead.drain(..think_open.len());
                        continue;
                    }
                    // Split on close marker
                    if lookahead.starts_with(think_close) {
                        in_thinking = false;
                        seen_think_close = true;
                        lookahead.drain(..think_close.len());
                        print!("\n[THINKING END]\n\n[RESPONSE START]\n");
                        continue;
                    }
                    // Lookahead might still be a partial delimiter — wait for more tokens
                    if think_open.starts_with(lookahead.as_str())
                        || think_close.starts_with(lookahead.as_str())
                    {
                        break;
                    }
                }

                if lookahead.is_empty() { break; }
                let ch = lookahead.remove(0).to_string();
                if in_thinking {
                    thinking_buf.push_str(&ch);
                } else {
                    response_buf.push_str(&ch);
                }
                print!("{}", ch);
            }

            true
        });

        // Flush any partial lookahead left after generation ends
        if !lookahead.is_empty() {
            if in_thinking { thinking_buf.push_str(&lookahead); } else { response_buf.push_str(&lookahead); }
            print!("{}", lookahead);
        }

        if !seen_think_close {
            // No <channel|> was ever emitted — model answered directly without a thinking block.
            // Reclassify: everything captured in thinking_buf is actually the response.
            print!("\n[NOTE: no thinking block — model answered directly]\n");
            response_buf = std::mem::take(&mut thinking_buf);
        }

        println!("\n{}", "=".repeat(60));

        match result {
            Ok(_) => {
                println!("\n--- THINKING ({} chars) ---", thinking_buf.len());
                if thinking_buf.is_empty() {
                    println!("(none)");
                } else {
                    println!("{}", thinking_buf);
                }

                println!("\n--- RESPONSE ({} chars) ---", response_buf.len());
                if response_buf.trim().is_empty() {
                    println!("(none — model may have ended inside thinking block)");
                } else {
                    println!("{}", response_buf);
                }

                println!("\n--- VERDICT ---");
                println!("  thinking block present : {}", !thinking_buf.is_empty());
                println!("  response non-empty     : {}", !response_buf.trim().is_empty());
                if let Some(m) = engine.get_last_metrics() {
                    println!("  tokens/sec             : {:.1}", m.tokens_per_second);
                    println!("  total tokens           : {}", m.tokens_generated);
                }

                assert!(!response_buf.trim().is_empty(), "Response should be non-empty");
            }
            Err(e) => panic!("Generation failed: {}", e),
        }
    }
}
