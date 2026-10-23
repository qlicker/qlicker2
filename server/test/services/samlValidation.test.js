import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAML } from '@node-saml/node-saml';
import { SignedXml } from 'xml-crypto';

// End-to-end SAML signature validation against the real node-saml / xml-crypto /
// @xmldom/xmldom stack. The route tests mock the SAML provider, so without this
// test a dependency bump that breaks the XML stack (e.g. the @xmldom/xmldom
// 0.9.x override that rejected every IdP response in production) passes the
// whole suite while SSO login is completely broken.

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/saml');
// Throwaway self-signed test-only keypair; not used anywhere outside this suite.
const idpKey = fs.readFileSync(path.join(fixturesDir, 'test-idp.key'), 'utf8');
const idpCert = fs.readFileSync(path.join(fixturesDir, 'test-idp.crt'), 'utf8');

const SP_ENTITY_ID = 'https://qlicker.test';
const CALLBACK_URL = 'https://qlicker.test/SSO/SAML2';
const IDP_ISSUER = 'https://idp.test/';

function buildAssertion({ email = 'student@qlicker.test', notOnOrAfterMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  const issueInstant = new Date(now).toISOString();
  const notBefore = new Date(now - 5 * 60 * 1000).toISOString();
  const notOnOrAfter = new Date(now + notOnOrAfterMs).toISOString();
  return `<Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion" ID="_test-assertion" IssueInstant="${issueInstant}" Version="2.0"><Issuer>${IDP_ISSUER}</Issuer><Subject><NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</NameID><SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${CALLBACK_URL}"/></SubjectConfirmation></Subject><Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><AudienceRestriction><Audience>${SP_ENTITY_ID}</Audience></AudienceRestriction></Conditions><AttributeStatement><Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><AttributeValue>${email}</AttributeValue></Attribute></AttributeStatement><AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_test-session"><AuthnContext><AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</AuthnContextClassRef></AuthnContext></AuthnStatement></Assertion>`;
}

function signAssertion(assertion) {
  const sig = new SignedXml({ privateKey: idpKey });
  sig.addReference({
    xpath: `//*[local-name(.)='Assertion']`,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.computeSignature(assertion, {
    location: { reference: `//*[local-name(.)='Issuer']`, action: 'after' },
  });
  return sig.getSignedXml();
}

function buildResponse(assertionXml) {
  const issueInstant = new Date().toISOString();
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_test-response" Version="2.0" IssueInstant="${issueInstant}" Destination="${CALLBACK_URL}"><saml:Issuer>${IDP_ISSUER}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertionXml}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}

// Mirrors the options built in src/plugins/saml.js, including the
// wantAssertionsSigned=true default from getSamlAdvancedSettings.
function createSamlProvider(overrides = {}) {
  return new SAML({
    entryPoint: 'https://idp.test/sso',
    issuer: SP_ENTITY_ID,
    idpCert,
    callbackUrl: CALLBACK_URL,
    logoutCallbackUrl: `${CALLBACK_URL}/logout`,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 0,
    disableRequestedAuthnContext: true,
    ...overrides,
  });
}

describe('SAML response validation (real XML crypto stack)', () => {
  it('accepts a response whose assertion is signed by the IdP', async () => {
    const saml = createSamlProvider();
    const SAMLResponse = buildResponse(signAssertion(buildAssertion()));

    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse });

    expect(profile.nameID).toBe('student@qlicker.test');
    expect(profile.sessionIndex).toBe('_test-session');
    const attrs = profile.attributes || profile;
    expect(attrs['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'])
      .toBe('student@qlicker.test');
  });

  it('rejects an unsigned assertion when wantAssertionsSigned is true', async () => {
    const saml = createSamlProvider();
    const SAMLResponse = buildResponse(buildAssertion());

    await expect(saml.validatePostResponseAsync({ SAMLResponse })).rejects.toThrow();
  });

  it('rejects a signed assertion whose contents were tampered with', async () => {
    const saml = createSamlProvider();
    const tampered = signAssertion(buildAssertion())
      .replace('student@qlicker.test', 'attacker@qlicker.test');
    const SAMLResponse = buildResponse(tampered);

    await expect(saml.validatePostResponseAsync({ SAMLResponse })).rejects.toThrow();
  });

  it('rejects an expired assertion', async () => {
    const saml = createSamlProvider();
    const SAMLResponse = buildResponse(
      signAssertion(buildAssertion({ notOnOrAfterMs: -60 * 1000 }))
    );

    await expect(saml.validatePostResponseAsync({ SAMLResponse })).rejects.toThrow();
  });
});
