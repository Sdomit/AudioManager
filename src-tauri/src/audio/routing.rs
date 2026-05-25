use serde::{Deserialize, Serialize};

/// A configured audio route: one input device to one output device.
///
/// `enabled` = user's intent (they want audio to flow).
/// `active`  = engine is currently running for this route.
///
/// In Phase 2 these always match (enabled ↔ active), but keeping them
/// distinct lets Phase 3 pre-configure routes without starting them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Route {
    pub input_id: String,
    pub output_id: String,
    pub enabled: bool,
    pub active: bool,
}

impl Route {
    pub fn new(input_id: impl Into<String>, output_id: impl Into<String>) -> Self {
        Self {
            input_id: input_id.into(),
            output_id: output_id.into(),
            enabled: false,
            active: false,
        }
    }

    pub fn matches(&self, input_id: &str, output_id: &str) -> bool {
        self.input_id == input_id && self.output_id == output_id
    }
}
