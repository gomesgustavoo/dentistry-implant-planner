# Security

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's
[private vulnerability reporting](https://github.com/gomesgustavoo/dentistry-implant-planner/security/advisories/new),
and not in a public issue. Include what you found, how to reproduce it, and what it
exposes. You will get an answer, and a fix or a stated decision, before anything is made
public.

## Scope and what to expect

- This is research software and **not a medical device**. Do not use it for diagnosis or
  treatment.
- A self-hosted deployment **without accounts** (the `compose.yaml` default) has no
  authentication by design: anyone who can reach it sees every case. It binds to
  `127.0.0.1` for that reason. Expose it only behind your own VPN or an authenticating
  proxy, or configure an OpenID Connect provider (`DENT_REQUIRE_AUTH=true`).
- Patient data: uploads are deleted when a job finishes and results expire after
  `DENT_RESULT_TTL_HOURS`. You are responsible for the data protection rules that apply to
  scans you upload to a server you run.
- No secret belongs in this repository. Credentials are read from the environment
  (`.env`, a Kubernetes Secret); a secret scan runs on every push.
