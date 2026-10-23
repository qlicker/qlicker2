#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {
  buildTemplateContext,
  getSsoConfig,
} from './lib/qlicker-sso-settings.mjs';

const config = getSsoConfig();
const context = buildTemplateContext(config);

fs.mkdirSync(config.generatedConfigDir, { recursive: true });
fs.mkdirSync(config.generatedMetadataDir, { recursive: true });

const files = [
  {
    source: path.join(config.templatesDir, 'config.php.template'),
    target: path.join(config.generatedConfigDir, 'config.php'),
  },
  {
    source: path.join(config.templatesDir, 'authsources.php.template'),
    target: path.join(config.generatedConfigDir, 'authsources.php'),
  },
  {
    source: path.join(config.templatesDir, 'saml20-idp-hosted.php.template'),
    target: path.join(config.generatedMetadataDir, 'saml20-idp-hosted.php'),
  },
  {
    source: path.join(config.templatesDir, 'saml20-sp-remote.php.template'),
    target: path.join(config.generatedMetadataDir, 'saml20-sp-remote.php'),
  },
];

for (const file of files) {
  let output = fs.readFileSync(file.source, 'utf8');
  for (const [token, value] of Object.entries(context)) {
    output = output.split(token).join(value);
  }
  fs.writeFileSync(file.target, output, 'utf8');
  console.log(`rendered ${path.relative(config.generatedConfigDir, file.target)}`);
}
