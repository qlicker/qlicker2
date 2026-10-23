# Local SimpleSAMLphp SSO Test Server

This directory contains an isolated SimpleSAMLphp IdP used to verify Qlicker SAML login and logout flows without changing the repository root Docker setup.

## What It Provides

- A Dockerized local IdP running on its own port
- Seeded `exampleauth:UserPass` SSO users for professor and student flows
- Signed and encrypted assertions
- SAML single logout wired to Qlicker
- Helper scripts to generate certs, render config, print the required Qlicker settings payload, apply those settings, and run the Playwright smoke test

## Files And Directories

- `docker-compose.yml`: isolated IdP container
- `Dockerfile`: SimpleSAMLphp image build
- `.env.example`: local defaults for the IdP and the Qlicker app under test
- `templates/`: repo-owned SimpleSAMLphp config templates
- `scripts/generate-certs.sh`: generates the local IdP and Qlicker SP cert/key pairs
- `scripts/render-config.mjs`: renders SimpleSAMLphp config and metadata from `.env`
- `scripts/print-qlicker-settings.mjs`: prints the exact SSO settings payload Qlicker expects
- `scripts/apply-qlicker-settings.mjs`: logs into Qlicker as an admin and PATCHes the SSO settings
- `scripts/run-smoke.sh`: starts the IdP and runs the Playwright SSO smoke test
- `certs/`: generated local-only certificates and private keys
- `generated/`: rendered SimpleSAMLphp config and metadata files

## Default URLs

- IdP base URL: `http://127.0.0.1:4100`
- IdP metadata: `http://127.0.0.1:4100/simplesaml/saml2/idp/metadata.php`
- Qlicker app URL under smoke tests: `http://127.0.0.1:3300`
- Qlicker API URL under smoke tests: `http://127.0.0.1:3301/api/v1`

For manual setup, the helper scripts use the repository root `.env` app/API URLs automatically unless `ssoserver/.env` overrides `QCLICKER_APP_URL`, `QCLICKER_API_URL`, or `QCLICKER_SP_ENTITY_ID` with non-default values.

## Seeded Users

Defaults come from `.env` / `.env.example`.

- Professor: `sso-professor` / `Password123!`
- Student: `sso-student` / `Password123!`

Each user releases these attributes to Qlicker:

- `mail`
- `givenName`
- `sn`
- `role`
- `studentNumber`

## Manual Setup

```bash
cd ssoserver
cp .env.example .env
./scripts/generate-certs.sh
node ./scripts/render-config.mjs
docker compose up -d --build
```

If your main Qlicker app is already running on non-default ports, you do not need to edit `ssoserver/.env` just to match those ports as long as the repository root `.env` is correct. Re-run `node ./scripts/render-config.mjs` after changing the main app ports so the generated SAML metadata follows the updated callback URLs.

Check the IdP:

```bash
curl -fsS http://127.0.0.1:4100/simplesaml/
```

Stop it with:

```bash
docker compose down
```

## Qlicker Settings Payload

Print the payload that Qlicker expects:

```bash
cd ssoserver
node ./scripts/print-qlicker-settings.mjs
```

Apply it directly to a running Qlicker instance:

```bash
cd ssoserver
node ./scripts/apply-qlicker-settings.mjs \
  --admin-email admin@qlicker.com \
  --admin-password admin123
```

The payload sets these fields:

- `SSO_enabled=true`
- `SSO_entrypoint`
- `SSO_logoutUrl`
- `SSO_EntityId`
- `SSO_identifierFormat=urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`
- `SSO_institutionName=Local SimpleSAMLphp`
- `SSO_emailIdentifier=mail`
- `SSO_firstNameIdentifier=givenName`
- `SSO_lastNameIdentifier=sn`
- `SSO_roleIdentifier=role`
- `SSO_roleProfName=professor`
- `SSO_studentNumberIdentifier=studentNumber`
- `SSO_cert` from `certs/idp.crt`
- `SSO_privCert` and `SSO_privKey` from the generated Qlicker SP keypair

## Run The SSO Smoke Test

```bash
./ssoserver/scripts/run-smoke.sh
```

This smoke run is intentionally separate from the default `cd client && npm run test:e2e` suite. It uses `client/playwright.sso.config.js` so the normal baseline Playwright flows remain usable without starting the local IdP.

Unlike the manual helper scripts, `run-smoke.sh` intentionally uses the `QCLICKER_*` values from `ssoserver/.env` for its temporary Qlicker stack so it can run in parallel with a normal local app using the repo root `.env` ports.

The smoke wrapper:

1. creates `ssoserver/.env` from `.env.example` if missing
2. generates certs if needed
3. renders the SimpleSAMLphp config
4. starts the isolated IdP container
5. ensures Playwright Chromium is installed if needed
6. runs `client/e2e-sso/sso.spec.js` via `client/playwright.sso.config.js` against a dedicated Qlicker E2E stack
7. stops the IdP container on exit

## Troubleshooting

- If the IdP fails to start, re-run `node ./scripts/render-config.mjs` and confirm `generated/config/` and `generated/metadata/` contain rendered PHP files.
- If Qlicker rejects assertion decryption, regenerate certs with `./scripts/generate-certs.sh --force`, re-apply the printed payload, and restart the smoke test.
- If login redirects fail, compare the IdP metadata URL with Qlicker’s `/SSO/SAML2/metadata` output to confirm the entity ID, ACS URL, and SLO URL still match. The newer `/api/v1/auth/sso/metadata` alias should return the same legacy ACS/SLO endpoints.
- If you need new test users, update `.env`, re-run `node ./scripts/render-config.mjs`, and restart the IdP container.
