# Security Policy

## Supported versions

Only the versions below receive security fixes. Older releases are provided "as-is" —
upgrade to a supported line before reporting.

| Version | Supported | Notes |
| --- | --- | --- |
| `main` (latest commit) | :white_check_mark: | Active development |
| Latest tagged release | :white_check_mark: | Fixes are backported when practical |
| Older tagged releases | :x: | Upgrade to the latest release |
| Forks and modified copies | :x: | Report to the maintainer of that fork |

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security problem.**
A public report exposes every user before a fix exists.

Report privately through one of these channels:

1. **GitHub Security Advisories (preferred)** — open
   `https://github.com/icrefin/dsh-remote-control/security/advisories/new`
   (repository → *Security* → *Advisories* → *Report a vulnerability*). This keeps the
   report private and gives us a private fork in which to prepare the fix.
2. **Email** — `icrefinai@gmail.com`. Never send exploit code to a public list.

Include in your report:

- Affected version or commit, plus the dsh build you ran it against.
- A minimal reproduction (proof of concept, request, or test case).
- Impact assessment: what an attacker gains, and under which preconditions.
- Any fix or mitigation you already know of.
- Whether you intend to publish, and the name you want used for credit.

## Our commitments

| Stage | Target |
| --- | --- |
| Acknowledge receipt | 3 business days |
| Initial assessment and severity triage | 10 business days |
| Fix or documented mitigation | 30 days for high/critical, best effort otherwise |
| Public disclosure | Coordinated with you, after a fix is available |

We credit you in the advisory unless you ask us not to. We will not pursue legal action
against researchers who act in good faith, avoid privacy violations, avoid service
disruption, and give us reasonable time to fix the issue before disclosure.

## Scope

In scope:

- The code in this repository (`icrefin/dsh-remote-control`), including published packages and CI workflows.
- The plugin's HTTP routes and its browser half, including any loopback-only fence,
  method and body-size limits, and the way a tab authenticates to those routes.
- Anything that makes the plugin write, read, or transmit data the user did not intend.

Out of scope:

- Vulnerabilities in DeepSeek Harness itself, in `@deepseek-ai/*` packages, or in
  third-party dependencies — report those upstream.
- Denial of service through extreme resource consumption on a machine the attacker
  already controls.
- Social engineering of the maintainer or users.

## Safe harbor

We consider security research conducted under this policy authorized. We will not
pursue or support legal action against researchers who stay in scope, avoid privacy
violations and service disruption, and give us reasonable time to fix the issue before
disclosure.
