"""AI Words — render an ODT file to HTML for an AI agent to read and edit."""

__version__ = "0.1.0"

# Trust the operating system's certificate store (Windows/macOS/Linux) on top of
# certifi, so HTTPS to model providers works behind corporate proxies that inject
# a private root CA — the usual cause of "CERTIFICATE_VERIFY_FAILED: unable to
# get local issuer certificate". Applies to both the httpx (OpenAI-compatible)
# and Anthropic paths. No-op if truststore isn't installed.
try:
    import truststore

    truststore.inject_into_ssl()
except Exception:  # pragma: no cover - best-effort; fall back to certifi
    pass
