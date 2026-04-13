use serde::{Deserialize, Serialize};

/// A single message in a chat conversation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Supported chat model types, each with its own instruct template.
#[derive(Clone, Debug, PartialEq)]
pub enum ChatModel {
    Mistral,
    Llama3,
    Phi3,
}

impl ChatModel {
    /// Parse a model type string into a ChatModel variant.
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "mistral" => Some(Self::Mistral),
            "llama3" => Some(Self::Llama3),
            "phi3" => Some(Self::Phi3),
            _ => None,
        }
    }
}

/// Format a conversation into the correct instruct template for the given model.
///
/// Each model family uses different special tokens to delineate roles.
pub fn format_chat_prompt(model: &ChatModel, messages: &[ChatMessage]) -> String {
    match model {
        ChatModel::Mistral => format_mistral(messages),
        ChatModel::Llama3 => format_llama3(messages),
        ChatModel::Phi3 => format_phi3(messages),
    }
}

/// Mistral instruct format:
/// `<s>[INST] {system}\n\n{user} [/INST] {assistant}</s>[INST] {user} [/INST]`
fn format_mistral(messages: &[ChatMessage]) -> String {
    let mut prompt = String::new();
    let mut system_prefix = String::new();

    // Collect system messages to prepend to the first user message
    for msg in messages {
        if msg.role == "system" {
            if !system_prefix.is_empty() {
                system_prefix.push('\n');
            }
            system_prefix.push_str(&msg.content);
        }
    }

    let mut first_user = true;
    let mut i = 0;
    while i < messages.len() {
        let msg = &messages[i];
        match msg.role.as_str() {
            "system" => {
                // Already collected above
                i += 1;
            }
            "user" => {
                if first_user && !system_prefix.is_empty() {
                    prompt.push_str(&format!(
                        "<s>[INST] {}\n\n{} [/INST]",
                        system_prefix, msg.content
                    ));
                    first_user = false;
                } else {
                    if !first_user {
                        prompt.push_str(&format!("[INST] {} [/INST]", msg.content));
                    } else {
                        prompt.push_str(&format!("<s>[INST] {} [/INST]", msg.content));
                        first_user = false;
                    }
                }

                // If next message is assistant, include it
                if i + 1 < messages.len() && messages[i + 1].role == "assistant" {
                    prompt.push_str(&format!(" {}</s>", messages[i + 1].content));
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "assistant" => {
                // Standalone assistant message (shouldn't happen in well-formed input)
                prompt.push_str(&format!(" {}</s>", msg.content));
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    prompt
}

/// Llama 3 instruct format:
/// ```text
/// <|begin_of_text|><|start_header_id|>system<|end_header_id|>
///
/// {system}<|eot_id|><|start_header_id|>user<|end_header_id|>
///
/// {user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>
///
/// ```
fn format_llama3(messages: &[ChatMessage]) -> String {
    let mut prompt = String::from("<|begin_of_text|>");

    for msg in messages {
        prompt.push_str(&format!(
            "<|start_header_id|>{}<|end_header_id|>\n\n{}<|eot_id|>",
            msg.role, msg.content
        ));
    }

    // Add the assistant header to prompt generation
    prompt.push_str("<|start_header_id|>assistant<|end_header_id|>\n\n");
    prompt
}

/// Phi-3 instruct format:
/// ```text
/// <|system|>
/// {system}<|end|>
/// <|user|>
/// {user}<|end|>
/// <|assistant|>
/// ```
fn format_phi3(messages: &[ChatMessage]) -> String {
    let mut prompt = String::new();

    for msg in messages {
        prompt.push_str(&format!(
            "<|{}|>\n{}<|end|>\n",
            msg.role, msg.content
        ));
    }

    // Add the assistant tag to prompt generation
    prompt.push_str("<|assistant|>\n");
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_msg(content: &str) -> ChatMessage {
        ChatMessage {
            role: "system".into(),
            content: content.into(),
        }
    }

    fn user_msg(content: &str) -> ChatMessage {
        ChatMessage {
            role: "user".into(),
            content: content.into(),
        }
    }

    fn assistant_msg(content: &str) -> ChatMessage {
        ChatMessage {
            role: "assistant".into(),
            content: content.into(),
        }
    }

    #[test]
    fn chat_model_from_str() {
        assert_eq!(ChatModel::parse("mistral"), Some(ChatModel::Mistral));
        assert_eq!(ChatModel::parse("Llama3"), Some(ChatModel::Llama3));
        assert_eq!(ChatModel::parse("PHI3"), Some(ChatModel::Phi3));
        assert_eq!(ChatModel::parse("unknown"), None);
    }

    // ── Mistral template tests ──

    #[test]
    fn mistral_single_turn() {
        let messages = vec![
            system_msg("You are helpful."),
            user_msg("Hello"),
        ];
        let prompt = format_chat_prompt(&ChatModel::Mistral, &messages);
        assert!(prompt.contains("<s>[INST] You are helpful.\n\nHello [/INST]"));
    }

    #[test]
    fn mistral_multi_turn() {
        let messages = vec![
            system_msg("You are helpful."),
            user_msg("Hello"),
            assistant_msg("Hi there!"),
            user_msg("How are you?"),
        ];
        let prompt = format_chat_prompt(&ChatModel::Mistral, &messages);
        assert!(prompt.contains("<s>[INST] You are helpful.\n\nHello [/INST]"));
        assert!(prompt.contains("Hi there!</s>"));
        assert!(prompt.contains("[INST] How are you? [/INST]"));
    }

    #[test]
    fn mistral_no_system() {
        let messages = vec![user_msg("Hello")];
        let prompt = format_chat_prompt(&ChatModel::Mistral, &messages);
        assert!(prompt.starts_with("<s>[INST] Hello [/INST]"));
    }

    // ── Llama 3 template tests ──

    #[test]
    fn llama3_single_turn() {
        let messages = vec![
            system_msg("You are helpful."),
            user_msg("Hello"),
        ];
        let prompt = format_chat_prompt(&ChatModel::Llama3, &messages);
        assert!(prompt.starts_with("<|begin_of_text|>"));
        assert!(prompt.contains("<|start_header_id|>system<|end_header_id|>\n\nYou are helpful.<|eot_id|>"));
        assert!(prompt.contains("<|start_header_id|>user<|end_header_id|>\n\nHello<|eot_id|>"));
        assert!(prompt.ends_with("<|start_header_id|>assistant<|end_header_id|>\n\n"));
    }

    // ── Phi-3 template tests ──

    #[test]
    fn phi3_single_turn() {
        let messages = vec![
            system_msg("You are helpful."),
            user_msg("Hello"),
        ];
        let prompt = format_chat_prompt(&ChatModel::Phi3, &messages);
        assert!(prompt.contains("<|system|>\nYou are helpful.<|end|>"));
        assert!(prompt.contains("<|user|>\nHello<|end|>"));
        assert!(prompt.ends_with("<|assistant|>\n"));
    }

    #[test]
    fn phi3_multi_turn() {
        let messages = vec![
            system_msg("Be helpful"),
            user_msg("Hi"),
            assistant_msg("Hello!"),
            user_msg("Bye"),
        ];
        let prompt = format_chat_prompt(&ChatModel::Phi3, &messages);
        assert!(prompt.contains("<|assistant|>\nHello!<|end|>"));
        assert!(prompt.contains("<|user|>\nBye<|end|>"));
        // Should end with assistant prompt
        assert!(prompt.ends_with("<|assistant|>\n"));
    }
}
