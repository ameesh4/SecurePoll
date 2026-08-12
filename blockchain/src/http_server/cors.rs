//! Cross-origin support for the ballot endpoint, via the `rocket_cors` crate.
//!
//! # Why this exists
//!
//! A ballot is submitted by the voter's *browser*, directly to a node. It carries
//! `Content-Type: application/json`, which makes it a non-simple cross-origin request, so the
//! browser sends an `OPTIONS` preflight first and refuses to send the ballot at all unless that
//! preflight is answered. `rocket_cors`'s fairing mode answers every preflight itself — no route
//! or catch-all has to be defined for it.
//!
//! The ballot must go browser → node directly. Routing it through the verification server would
//! be far easier and is forbidden: that server must never see a ballot
//! (SECUREPOLL_CONTEXT.md §4 invariant 4). So the node has to accept cross-origin requests.
//!
//! # Why allowing every origin and method is not a hole
//!
//! `Access-Control-Allow-Origin: *` looks alarming here and is not. **CORS is a browser
//! mechanic, not this endpoint's security boundary.** The ballot endpoint accepts no cookies, no
//! `Authorization` header and no credentials of any kind, so it cannot be tricked into acting
//! with someone else's authority — the classic CSRF shape that same-origin policy exists to
//! prevent. A malicious page that POSTs here achieves exactly what `curl` already could: it
//! submits bytes that either carry a valid ring signature or are rejected.
//!
//! Authorization is the ring signature. Anyone can *offer* a ballot; only a holder of a private
//! key in a published anonymity group can offer one that verifies, and only once per election.
//! Locking the origin or method down would not add a single guarantee, and would break the
//! voter's browser for no gain.
//!
//! Note also that `allow_credentials` is deliberately left `false`. With it `true`, a wildcard
//! origin would be rejected by browsers anyway — and we have no credentials to send.

use rocket::http::Method;
use rocket_cors::{AllowedHeaders, AllowedMethods, AllowedOrigins, Cors};

/// Every origin, every method, any header — see the module docs for why that is safe here.
pub fn cors_fairing() -> Cors {
    let allowed_methods: AllowedMethods = [
        Method::Get,
        Method::Post,
        Method::Put,
        Method::Delete,
        Method::Patch,
        Method::Head,
        Method::Options,
    ]
    .into_iter()
    .map(From::from)
    .collect();

    rocket_cors::CorsOptions {
        allowed_origins: AllowedOrigins::all(),
        allowed_methods,
        allowed_headers: AllowedHeaders::all(),
        allow_credentials: false,
        ..Default::default()
    }
    .to_cors()
    .expect("CORS configuration is invalid")
}
