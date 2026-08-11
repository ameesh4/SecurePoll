//! Cross-origin support for the ballot endpoint.
//!
//! # Why this exists
//!
//! A ballot is submitted by the voter's *browser*, directly to a node. It carries
//! `Content-Type: application/json`, which makes it a non-simple cross-origin request, so the
//! browser sends an `OPTIONS` preflight first and refuses to send the ballot at all unless that
//! preflight is answered. Rocket does not answer preflights on its own: a fairing alone is not
//! enough, because there is no route to dispatch `OPTIONS` to, so the catch-all route below is
//! as necessary as the headers.
//!
//! The ballot must go browser → node directly. Routing it through the verification server would
//! be far easier and is forbidden: that server must never see a ballot
//! (SECUREPOLL_CONTEXT.md §4 invariant 4). So the node has to accept cross-origin requests.
//!
//! # Why `*` is not a hole
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
//! Locking the origin down would not add a single guarantee, and would break the voter's browser
//! for no gain.
//!
//! Note also that `Allow-Credentials` is deliberately absent. With it set, `*` would be rejected
//! by browsers anyway — and we have no credentials to send.

use rocket::fairing::{Fairing, Info, Kind};
use rocket::http::Header;
use rocket::{Request, Response};

pub struct Cors;

#[rocket::async_trait]
impl Fairing for Cors {
    fn info(&self) -> Info {
        Info {
            name: "CORS headers for browser-submitted ballots",
            kind: Kind::Response,
        }
    }

    async fn on_response<'r>(&self, _request: &'r Request<'_>, response: &mut Response<'r>) {
        response.set_header(Header::new("Access-Control-Allow-Origin", "*"));
        response.set_header(Header::new(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS",
        ));
        response.set_header(Header::new("Access-Control-Allow-Headers", "Content-Type"));
        // Lets a browser skip the preflight for 24h of repeat submissions.
        response.set_header(Header::new("Access-Control-Max-Age", "86400"));
    }
}

/// Answers every preflight.
///
/// A catch-all rather than one `OPTIONS` route per endpoint: the fairing supplies the headers, so
/// all this needs to do is exist and return success. Without it Rocket replies 404 to the
/// preflight and the browser drops the ballot before it is sent.
#[rocket::options("/<_path..>")]
pub fn preflight(_path: std::path::PathBuf) -> rocket::http::Status {
    rocket::http::Status::NoContent
}
