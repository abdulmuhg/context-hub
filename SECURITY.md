# Security policy

context-hub stores people's AI-assistant history, so security reports are
taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:
the repository's **Security** tab > **Report a vulnerability**
(https://github.com/abdulmuhg/context-hub/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do
with it. You should hear back within a week. Once a fix is released, you will
be credited in the advisory unless you prefer not to be.

## Scope

In scope: the hub server (`apps/server`), the `hub` command
(`apps/collector`), the shared code (`packages/core`), the install script the
hub serves, and the Docker image built from this repository. Examples:

- reading or changing a hub's data without a valid token, code or sign-in;
- bypassing secret stripping or the personal-data filter;
- uploading a project that was not tracked;
- cross-site attacks on the dashboard or the sign-in pages.

Out of scope: problems in someone's own server, proxy or hosting setup, and
denial of service by sheer request volume.

## Supported versions

Only the latest `main` is supported. Hubs should be kept up to date with it.
