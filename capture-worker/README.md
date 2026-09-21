# snapshot-capture (Cloudflare Worker)

Receives the AI Assessment Snapshot lead forms from groovelogicgroup.com, stores
each lead in KV, optionally emails a notification (Resend), and exposes a small
authenticated queue that GRIPP OS pulls into its Funnel.

## Deploy (once, from this folder, in Terminal)

    cd ~/groovelogicgroup-com/capture-worker
    npx wrangler login                                  # opens the browser once
    npx wrangler kv namespace create LEADS              # prints an id → paste into wrangler.toml
    npx wrangler secret put PULL_TOKEN                  # paste a long random string; GRIPP OS gets the same one
    npx wrangler secret put RESEND_API_KEY              # optional — skip to store leads without email
    npx wrangler deploy                                 # prints the workers.dev URL

Then confirm:

    curl https://snapshot-capture.<your-subdomain>.workers.dev/health

If the printed URL's subdomain differs from `snapshot-capture.gensession21.workers.dev`,
update `CAPTURE_URL` in `assessment/index.html` and `find-the-leak/index.html`.

## Endpoints
- `POST /submit` — site forms (JSON: name, email, company, workflow, website[honeypot], source, page, utm)
- `GET /leads` — pending leads, `Authorization: Bearer <PULL_TOKEN>`
- `POST /ack` — `{ "ids": [...] }` marks leads imported
- `GET /health`

Leads are never deleted from KV; `ack` only removes them from the pending list.
