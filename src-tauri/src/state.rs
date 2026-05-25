use std::sync::Mutex;

use crate::audio::{passthrough::PassthroughEngine, routing::Route};

/// All mutable engine state under a single lock.
/// Using one Mutex prevents lock-ordering bugs that would arise from
/// separate Mutex<engine> and Mutex<routes> fields.
pub struct AppInner {
    pub engine: Option<PassthroughEngine>,
    pub routes: Vec<Route>,
}

pub struct AppState {
    pub inner: Mutex<AppInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppInner {
                engine: None,
                routes: Vec::new(),
            }),
        }
    }
}
