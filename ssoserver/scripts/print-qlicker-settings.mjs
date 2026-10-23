#!/usr/bin/env node
import { buildQlickerSsoSettingsPayload, getSsoConfig } from './lib/qlicker-sso-settings.mjs';

const config = getSsoConfig();
const payload = buildQlickerSsoSettingsPayload(config);
console.log(`${JSON.stringify(payload, null, 2)}\n`);
