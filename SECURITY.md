# Security

Poké Jam is a static website: HTML, JavaScript, CSS, fonts and images, all served from its own host. There is
no server code, no database, no accounts, no payments and no third-party requests. Saves live only in the
player's browser (`localStorage`, keys starting `pokejam.`).

## Reporting a problem

Open a private security advisory on this repository (Security tab → Report a vulnerability), or contact the
maintainer listed in `public/privacy.html`. Please don't open a public issue for security problems.

## What the site does

- **Content Security Policy.** Every built page carries a CSP (see `vite.config.ts` and `public/privacy.html`):
  scripts, styles, images and fonts load only from the site itself, nothing can be framed or posted anywhere,
  and plugins and `<base>` tricks are blocked. GitHub Pages can't send response headers, so the policy ships as
  a `<meta>` tag; `frame-ancestors` and the headers below need a proxy (see DDoS and headers).
- **No referrer.** `<meta name="referrer" content="no-referrer">`: links out don't reveal the page.
- **Output escaping.** Every name that reaches the page (your team name, saved data) goes through `esc()` or
  `textContent`; nothing is built with `eval` or `new Function`.
- **Untrusted saves.** Saves come back from browser storage, where they can be edited by hand, so they are
  checked on load: team names are trimmed plain text, abbreviations alphanumeric, colors must be hex colors,
  settings are read key by key with type checks, and anything malformed is ignored.
- **Supply chain.** Two dev-only dependencies (TypeScript, Vite), pinned in `package-lock.json`. CI installs
  with `npm ci --ignore-scripts` (no dependency install scripts run) and fails the deploy on any high-severity
  `npm audit` finding. Dependabot opens weekly update PRs for npm packages and GitHub Actions.
- **Deploy pipeline.** The Pages workflow has least-privilege permissions (read contents, write Pages only),
  doesn't keep the checkout's credentials, and has job timeouts.

## DDoS and headers

There is no origin server to overload: GitHub Pages serves the files from Fastly's global CDN, which absorbs
volumetric attacks, and GitHub runs its own DDoS mitigation. The realistic limit is GitHub Pages' soft
bandwidth limit (100 GB a month).

The site is live at **pokejam.xyz**: Porkbun DNS, apex A records to GitHub Pages (185.199.108-111.153),
`www` as a CNAME to `kungfudoom.github.io`, HTTPS enforced (http and www redirect to https://pokejam.xyz).

For the strongest setup, put **Cloudflare (free plan)** in front of the domain:

1. Add `pokejam.xyz` to Cloudflare; it imports the DNS records. At Porkbun, switch the nameservers to the two
   Cloudflare gives you.
2. Keep the same records (apex A records to GitHub Pages, `www` CNAME to `kungfudoom.github.io`), now proxied
   (orange cloud). The custom domain stays set in the repo's Pages settings, with Enforce HTTPS on.
3. SSL/TLS → Full (strict); Edge certificates → Always Use HTTPS, HSTS (6 months, include subdomains), minimum
   TLS 1.2.
4. Security → Bot Fight Mode on; DDoS protection is automatic. Add a rate-limiting rule (free plan allows one),
   e.g. more than 1,500 requests in 10 seconds from one IP → block for 10 seconds (one player opening the
   draft loads ~300 sprites at once, so keep the limit well above that).
5. Rules → Transform Rules → modify response headers, add:

   ```
   Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests
   X-Content-Type-Options: nosniff
   X-Frame-Options: DENY
   Referrer-Policy: no-referrer
   Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Resource-Policy: same-origin
   ```

Moving the hosting to Cloudflare Pages instead also works (unlimited bandwidth, same DDoS protection); the same
headers then go in a `_headers` file in `public/`.

## Repository settings worth turning on

Settings → Code security: Dependabot alerts and security updates, secret scanning and push protection.
Settings → Branches: protect the deploy branch (require pull requests, block force pushes). And keep two-factor
authentication on for the GitHub account that owns the repo.
