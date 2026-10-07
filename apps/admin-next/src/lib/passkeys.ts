import { WebAuthnError, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { ApiError } from './api.ts';
import i18n from './i18n.ts';

/**
 * WebAuthn only works in a secure context (HTTPS or a loopback origin), and
 * only in browsers that expose `PublicKeyCredential`. `browserSupportsWebAuthn`
 * already returns false off secure contexts, but we check `isSecureContext`
 * explicitly so the UI can tell the two failure modes apart if needed.
 */
export function isWebAuthnAvailable(): boolean {
  if (typeof window === 'undefined' || window.isSecureContext !== true) {
    return false;
  }
  return browserSupportsWebAuthn();
}

/**
 * Map a WebAuthn or API failure onto a user-facing message. The browser
 * ceremony throws `WebAuthnError`; the most common case is the user dismissing
 * the prompt, which must read as "cancelled", not as a server error.
 */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof WebAuthnError) {
    if (error.code === 'ERROR_CEREMONY_ABORTED') {
      return i18n.t('pages.passkeys.cancelled');
    }
    if (error.code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT') {
      return i18n.t('pages.passkeys.discoverableRequired');
    }
    if (
      error.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' &&
      error.cause instanceof Error &&
      error.cause.name === 'NotAllowedError'
    ) {
      return i18n.t('pages.passkeys.cancelled');
    }
    return i18n.t('pages.passkeys.webauthnFailed');
  }
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : i18n.t('common.requestFailed');
}
