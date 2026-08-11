//! LRS ballot verification — the Rust half of the cross-language contract specified in
//! `web/src/crypto/lrs/WIRE_FORMAT.md`.
//!
//! Complete and proven against the committed test vectors, but not yet wired into the node: the
//! `POST /ballot` endpoint that calls it is the next step. Hence the allow below — these items
//! have tests but no production caller yet, and silencing the warning here is preferable to
//! leaving the module half-written until its consumer exists.
#![allow(dead_code)]

pub mod hash;
pub mod serialize;
pub mod verify;
