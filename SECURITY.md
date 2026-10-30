# Security policy

## Reporting a vulnerability

Email **hugo2001xk@gmail.com** with:

- a description and impact;
- a minimal reproduction (request, payload, steps);
- the affected version/commit;
- whether the issue is already public.

Please do not open a public issue for a vulnerability. A first response is
expected within 72 hours. If the issue is confirmed, a fix and a coordinated
disclosure date will be agreed with you.

## Scope

In scope: authentication, sessions, CSRF, approval links, token encryption, the
model gateway and quota, the job credential/callback endpoints, the FlyBot
bridge contract, SSRF in user model URLs, and secret handling in logs.

Out of scope: vulnerabilities in GitHub, the upstream model provider, FlyBot
itself, or the SMTP provider; denial of service from a compromised host account;
social engineering.

## Safe harbour

Good-faith research that avoids privacy violations, data destruction and service
disruption is welcome. Do not access other users' data or run jobs against
repositories you do not own.
