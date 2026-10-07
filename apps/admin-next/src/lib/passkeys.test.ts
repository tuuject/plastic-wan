import { WebAuthnError } from '@simplewebauthn/browser';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from './api.ts';
import { isWebAuthnAvailable, passkeyErrorMessage } from './passkeys.ts';

afterEach(() => vi.unstubAllGlobals());

describe('passkey browser helpers', () => {
  test('requires both a secure context and the WebAuthn browser API', () => {
    vi.stubGlobal('window', undefined);
    expect(isWebAuthnAvailable()).toBe(false);
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('PublicKeyCredential', class {});
    expect(isWebAuthnAvailable()).toBe(false);
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(isWebAuthnAvailable()).toBe(false);
    vi.stubGlobal('PublicKeyCredential', class {});
    expect(isWebAuthnAvailable()).toBe(true);
  });

  test('distinguishes cancellation, discoverable support, and other WebAuthn failures', () => {
    const message = 'Browser ceremony failed';
    const cause = new Error(message);
    expect(passkeyErrorMessage(new WebAuthnError({ message, code: 'ERROR_CEREMONY_ABORTED', cause }))).toBe(
      'Passkey request cancelled',
    );
    cause.name = 'NotAllowedError';
    expect(
      passkeyErrorMessage(new WebAuthnError({ message, code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause })),
    ).toBe('Passkey request cancelled');
    cause.name = 'SecurityError';
    expect(
      passkeyErrorMessage(new WebAuthnError({ message, code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause })),
    ).toBe('The passkey request failed. Try again.');
    expect(
      passkeyErrorMessage(
        new WebAuthnError({ message, code: 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT', cause }),
      ),
    ).toBe('This browser does not support discoverable (passkey) credentials.');
  });

  test('preserves server errors and provides a fallback for unknown failures', () => {
    expect(passkeyErrorMessage(new ApiError(409, 'password_required', 'Set a password first'))).toBe(
      'password_required: Set a password first',
    );
    expect(passkeyErrorMessage(new Error('Network unavailable'))).toBe('Network unavailable');
    expect(passkeyErrorMessage(null)).toBe('Request failed');
  });
});
