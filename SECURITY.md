# Security Policy

## Supported versions

LaunchScope is in early development. Security fixes are made on the latest release and `main`.

| Version        | Supported |
| -------------- | --------- |
| latest `0.x`   | Yes       |
| older versions | No        |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub:
[Report a vulnerability](https://github.com/himan-patel/launchscope/security/advisories/new).

Include what you can of:

- The LaunchScope version and Node.js version
- The command and options used (remove real hostnames, tokens, and cookies)
- What happened, what you expected, and the potential impact
- Steps or a minimal example to reproduce

We aim to acknowledge reports within a few business days and will keep you updated until the
issue is resolved. Please give us a reasonable chance to release a fix before disclosing publicly.

## Scope

In scope:

- Leaking credentials, cookies, tokens, or response bodies into reports, logs, or terminal output
- Bypassing the safeguards that limit stress testing to targets the user controls
- Code execution or file writes outside the configured report directory
- Vulnerabilities in LaunchScope's own dependencies that affect its users

Out of scope:

- Findings LaunchScope reports about a site you scanned (that is the tool working as intended)
- Load you generate against systems after explicitly opting in to remote stress testing
