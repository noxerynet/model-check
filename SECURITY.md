# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Update before reporting.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: repository Security tab → "Report a vulnerability".

Include the affected endpoint or file, steps to reproduce, and impact. Do not open a public issue for unpatched vulnerabilities.

## Scope notes

Model Check forwards your API key to the provider you configure. Keys are kept in request memory only and never stored or logged. Review your provider's own security posture before entering production keys.
