use std::fmt;

/// Errors that can occur during payment link operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentLinkError {
    /// The provided `base_url` failed validation (scheme, length, or format).
    InvalidBaseUrl,
    /// The payment link could not be found.
    NotFound,
    /// The payment link has expired.
    Expired,
    /// A generic storage or persistence failure.
    StorageError(String),
}

impl fmt::Display for PaymentLinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PaymentLinkError::InvalidBaseUrl => {
                write!(f, "invalid base_url: must be a valid https:// URL of at most 256 characters")
            }
            PaymentLinkError::NotFound => write!(f, "payment link not found"),
            PaymentLinkError::Expired => write!(f, "payment link has expired"),
            PaymentLinkError::StorageError(msg) => write!(f, "storage error: {msg}"),
        }
    }
}

impl std::error::Error for PaymentLinkError {}
