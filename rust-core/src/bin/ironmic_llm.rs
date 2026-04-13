//! ironmic-llm — Standalone LLM inference binary.
//!
//! Runs as a persistent child process managed by Electron.
//! Reads JSON commands from stdin, streams tokens to stdout.
//! Keeps the model loaded between requests to avoid reload latency.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use serde::Deserialize;

use ironmic_core::llm::chat::{ChatMessage, ChatModel};
use ironmic_core::llm::cleanup::{LlmConfig, LlmEngine};

#[derive(Deserialize)]
struct Request {
    command: String,
    model_path: Option<String>,
    model_type: Option<String>,
    messages: Option<Vec<ChatMessage>>,
    text: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
}

fn main() {
    // Initialize tracing to stderr (stdout is reserved for token output)
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tracing::info!("ironmic-llm subprocess started");

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut engine = LlmEngine::new(LlmConfig::default());
    let mut current_model_path: Option<PathBuf> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("stdin read error: {e}");
                break;
            }
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = writeln!(stdout, "__ERROR__:Invalid JSON: {e}");
                let _ = stdout.flush();
                continue;
            }
        };

        let result = handle_request(&mut engine, &mut current_model_path, &req, &mut stdout);

        if let Err(e) = result {
            let _ = writeln!(stdout, "__ERROR__:{e}");
            let _ = stdout.flush();
        }
    }

    tracing::info!("ironmic-llm subprocess exiting");
}

fn ensure_model_loaded(
    engine: &mut LlmEngine,
    current_path: &mut Option<PathBuf>,
    requested_path: &str,
) -> Result<(), String> {
    let path = PathBuf::from(requested_path);

    if !path.exists() {
        return Err(format!("Model file not found: {}", path.display()));
    }

    let needs_reload = match current_path {
        Some(cur) => cur != &path || !engine.is_loaded(),
        None => true,
    };

    if needs_reload {
        tracing::info!(path = %path.display(), "Loading model");
        engine
            .load_model_from_path(&path)
            .map_err(|e| format!("{e}"))?;
        *current_path = Some(path);
    }

    Ok(())
}

fn handle_request(
    engine: &mut LlmEngine,
    current_path: &mut Option<PathBuf>,
    req: &Request,
    stdout: &mut io::Stdout,
) -> Result<(), String> {
    let model_path = req
        .model_path
        .as_deref()
        .ok_or("Missing model_path")?;

    ensure_model_loaded(engine, current_path, model_path)?;

    match req.command.as_str() {
        "chat" => {
            let messages = req.messages.as_deref().ok_or("Missing messages")?;
            let model_type_str = req.model_type.as_deref().unwrap_or("mistral");
            let model_type =
                ChatModel::parse(model_type_str).ok_or("Unknown model_type")?;
            let max_tokens = req.max_tokens.unwrap_or(2048);
            let temperature = req.temperature.unwrap_or(0.3);

            // Build the prompt using the model's built-in template or manual fallback
            let prompt = engine
                .build_chat_prompt(messages, &model_type)
                .map_err(|e| format!("{e}"))?;

            tracing::info!(
                messages = messages.len(),
                prompt_len = prompt.len(),
                "Starting chat generation"
            );

            // Stream tokens to stdout
            let callback = |text: &str| {
                let _ = write!(io::stdout(), "{text}");
                let _ = io::stdout().flush();
            };

            let result = engine
                .generate(&prompt, max_tokens, temperature, Some(&callback))
                .map_err(|e| format!("{e}"))?;

            // Sentinel on its own line
            let _ = writeln!(stdout);
            let _ = writeln!(stdout, "__DONE__");
            let _ = stdout.flush();

            tracing::info!(output_len = result.len(), "Chat generation complete");
            Ok(())
        }

        "polish" => {
            let text = req.text.as_deref().ok_or("Missing text")?;
            let result = engine
                .polish_text(text)
                .map_err(|e| format!("{e}"))?;

            let _ = write!(stdout, "{result}");
            let _ = writeln!(stdout);
            let _ = writeln!(stdout, "__DONE__");
            let _ = stdout.flush();
            Ok(())
        }

        other => Err(format!("Unknown command: {other}")),
    }
}
