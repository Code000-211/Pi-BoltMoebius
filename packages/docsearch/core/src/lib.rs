//! Fast document search for an agent: Markdown and text files split into sections, ranked by
//! BM25 and a section–entity graph. Everything is in memory; nothing calls a model.

pub mod chunk;
pub mod engine;
pub mod index;
pub mod lexicon;
pub mod store;
pub mod text;

pub use engine::{Engine, View};
pub use index::{Config, Hit, Index, Overlay, Results, SearchOpts};
