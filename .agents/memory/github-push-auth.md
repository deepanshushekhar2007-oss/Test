---
name: GitHub push authentication
description: Non-obvious GitHub push behavior in this environment
---

The GitHub push helper can report missing credentials even when a `GITHUB_TOKEN` secret is present and valid for the repository. Direct Git transport succeeds with an `Authorization: Basic` header built from `x-access-token:<token>`.

**Why:** The repository account and token can have valid API access and push permission while Replit's connected source-control credential store is not configured.

**How to apply:** Never print or persist the token. Use the secret only for the push command, verify the remote branch SHA, and avoid putting credentials in the remote URL or Git config.