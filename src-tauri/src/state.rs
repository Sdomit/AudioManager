use std::sync::Mutex;

use crate::audio::{graph::AudioGraph, mixer::MixerEngine};

/// All mutable engine state under a single lock.
/// One Mutex prevents lock-ordering bugs that would arise from separate
/// Mutex<engine> and Mutex<graph> fields.
pub struct AppInner {
    pub engine: Option<MixerEngine>,
    pub graph: AudioGraph,
}

pub struct AppState {
    pub inner: Mutex<AppInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppInner { engine: None, graph: AudioGraph::new() }),
        }
    }
}
