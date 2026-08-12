//! Signature and message encoding — the wire side of the cross-language contract.
//!
//! Layouts are specified in `web/src/crypto/lrs/WIRE_FORMAT.md` and implemented on the other
//! side in `web/src/crypto/lrs/serialize.ts`. Every rejection rule below exists because the
//! TypeScript deserializer has the same one; a byte string one side refuses and the other
//! accepts is a consensus split waiting to happen.

use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;

use super::hash::u32le;

pub const SIGNATURE_VERSION: u8 = 1;
const HEADER_BYTES: usize = 69; // 1 version + 4 count + 32 c0 + 32 keyImage
const SCALAR_BYTES: usize = 32;
const POINT_BYTES: usize = 32;

/// The canonical signed message: what a ballot's signature actually commits to.
///
/// `"SECUREPOLL/v1/vote" ‖ lp(electionId) ‖ lp(ringId) ‖ lp(candidateId)`
///
/// A node MUST rebuild this from the submitted fields and never accept a caller-supplied
/// message. Otherwise an attacker keeps a valid signature while the block records a different
/// candidate. Binding electionId and ringId is also what stops a signature being replayed into
/// another election or group.
pub fn encode_message(election_id: &str, ring_id: &str, candidate_id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"SECUREPOLL/v1/vote");
    for field in [election_id, ring_id, candidate_id] {
        out.extend_from_slice(&u32le(field.len()));
        out.extend_from_slice(field.as_bytes());
    }
    out
}

/// A parsed ring signature: `(c_0, s[], I)`. Public keys are NOT part of a signature — the ring
/// is a separate verifier input, resolved from the node's election manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RingSignature {
    pub c0: Scalar,
    pub s: Vec<Scalar>,
    pub key_image: RistrettoPoint,
    /// The key image exactly as it arrived. Kept so linkability comparisons and the seen-set
    /// use canonical bytes rather than re-compressing a decoded point.
    pub key_image_bytes: [u8; POINT_BYTES],
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    Version(u8),
    Length { expected: usize, actual: usize },
    RingSize(usize),
    NonCanonicalScalar(usize),
    NonCanonicalPoint,
    IdentityKeyImage,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Version(v) => write!(f, "unsupported signature version {}", v),
            Self::Length { expected, actual } => {
                write!(f, "signature must be {} bytes, got {}", expected, actual)
            }
            Self::RingSize(n) => write!(f, "signature declares an unusable ring size {}", n),
            Self::NonCanonicalScalar(i) => {
                write!(f, "response scalar {} is not canonical (>= q)", i)
            }
            Self::NonCanonicalPoint => write!(f, "key image is not a canonical ristretto255 point"),
            Self::IdentityKeyImage => write!(f, "key image is the identity element"),
        }
    }
}

/// Parses a signature, rejecting anything malformed.
///
/// The non-canonical scalar check is what kills malleability: scalar multiplication reduces mod
/// q, so without it `s_i` and `s_i + q` would both verify and one ballot would have unboundedly
/// many valid encodings. Rejecting the identity key image kills the classic degenerate forgery.
pub fn deserialize_signature(bytes: &[u8]) -> Result<RingSignature, DecodeError> {
    if bytes.len() < HEADER_BYTES {
        return Err(DecodeError::Length {
            expected: HEADER_BYTES,
            actual: bytes.len(),
        });
    }
    if bytes[0] != SIGNATURE_VERSION {
        return Err(DecodeError::Version(bytes[0]));
    }

    let n = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
    // A ring of one is a signature with the voter's name on it, so it is not a shape this
    // verifier will parse at all.
    if n < 2 || n > 4096 {
        return Err(DecodeError::RingSize(n));
    }

    let expected = HEADER_BYTES + SCALAR_BYTES * n;
    if bytes.len() != expected {
        return Err(DecodeError::Length {
            expected,
            actual: bytes.len(),
        });
    }

    let c0 = scalar_from(&bytes[5..37]).ok_or(DecodeError::NonCanonicalScalar(usize::MAX))?;

    let mut key_image_bytes = [0u8; POINT_BYTES];
    key_image_bytes.copy_from_slice(&bytes[37..69]);
    let key_image = CompressedRistretto(key_image_bytes)
        .decompress()
        .ok_or(DecodeError::NonCanonicalPoint)?;
    if key_image == RistrettoPoint::identity() {
        return Err(DecodeError::IdentityKeyImage);
    }

    let mut s = Vec::with_capacity(n);
    for i in 0..n {
        let start = HEADER_BYTES + i * SCALAR_BYTES;
        let value = scalar_from(&bytes[start..start + SCALAR_BYTES])
            .ok_or(DecodeError::NonCanonicalScalar(i))?;
        s.push(value);
    }

    Ok(RingSignature {
        c0,
        s,
        key_image,
        key_image_bytes,
    })
}

/// Canonical decode only: `from_canonical_bytes` rejects any value >= q.
fn scalar_from(bytes: &[u8]) -> Option<Scalar> {
    let mut buf = [0u8; SCALAR_BYTES];
    buf.copy_from_slice(bytes);
    Scalar::from_canonical_bytes(buf).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_encoding_is_unambiguous() {
        // Field boundaries must be fixed by their length prefixes, so moving a character across
        // a boundary produces a different message rather than the same bytes.
        assert_ne!(
            encode_message("ab", "c", "d"),
            encode_message("a", "bc", "d")
        );
        assert_eq!(encode_message("e", "r", "c"), encode_message("e", "r", "c"));
    }

    #[test]
    fn rejects_a_short_buffer() {
        assert!(matches!(
            deserialize_signature(&[1u8; 10]),
            Err(DecodeError::Length { .. })
        ));
    }

    #[test]
    fn rejects_an_unsupported_version() {
        let mut bytes = vec![0u8; HEADER_BYTES + 64];
        bytes[0] = 2;
        bytes[1] = 2;
        assert_eq!(deserialize_signature(&bytes), Err(DecodeError::Version(2)));
    }

    #[test]
    fn rejects_a_ring_of_one() {
        let mut bytes = vec![0u8; HEADER_BYTES + 32];
        bytes[0] = SIGNATURE_VERSION;
        bytes[1] = 1;
        assert_eq!(deserialize_signature(&bytes), Err(DecodeError::RingSize(1)));
    }

    #[test]
    fn rejects_an_identity_key_image() {
        let mut bytes = vec![0u8; HEADER_BYTES + 64];
        bytes[0] = SIGNATURE_VERSION;
        bytes[1] = 2;
        // All-zero is the canonical encoding of the ristretto identity.
        assert_eq!(
            deserialize_signature(&bytes),
            Err(DecodeError::IdentityKeyImage)
        );
    }
}
