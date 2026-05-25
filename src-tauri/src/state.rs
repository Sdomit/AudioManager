use std::sync::Mutex;

use crate::audio::passthrough::PassthroughEngine;

pub struct AppState {
    pub engine: Mutex<Option<PassthroughEngine>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            engine: Mutex::new(None),
        }
    }
}
