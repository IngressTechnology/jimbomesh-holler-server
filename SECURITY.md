# Security Policy 🔒

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in JimboMesh Holler Server, please report it responsibly:

📧 **Email:** [security@ingresstechnology.com](mailto:security@ingresstechnology.com)

### What to include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### What to expect:

- **Acknowledgment** within 48 hours
- **Status update** within 7 days
- **Fix timeline** communicated once we assess severity
- **Credit** in the release notes (unless you prefer anonymity)

## Supported Versions

| Version | Supported |
|---------|-----------|
| v0.2.x  | ✅ Current |
| < v0.2  | ❌ No longer supported |

## Security Best Practices for Holler Users

- **Never expose your Holler directly to the internet** without authentication enabled
- **Use Tiered Auth** (API Key or Full Auth) in any non-local deployment
- **Rotate API keys** regularly — generate new ones from the Admin UI
- **Keep Docker and Ollama updated** to get the latest security patches
- **Don't commit `.env` files** — they contain your secrets
- **Use HTTPS** if exposing the API outside your local network

## Scope

This security policy covers:

- JimboMesh Holler Server (this repository)
- The Admin UI
- The REST API
- Setup scripts (`setup.sh`, `setup.ps1`)
- Docker configuration

Out of scope:

- Ollama itself (report to [Ollama's security policy](https://github.com/ollama/ollama/security))
- Qdrant (report to [Qdrant's security policy](https://github.com/qdrant/qdrant/security))
- Third-party models downloaded through the Marketplace

---

*Maintained by [Ingress Technology](https://ingresstechnology.ai)*
