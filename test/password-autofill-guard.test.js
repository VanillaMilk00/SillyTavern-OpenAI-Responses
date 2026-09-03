import assert from 'node:assert/strict';
import test from 'node:test';

import {
    installPasswordAutofillGuard,
    resolveTrustedProxyPassword,
} from '../password-autofill-guard.js';

class FakePasswordInput extends EventTarget {
    constructor(value = '') {
        super();
        this.attributes = new Map();
        this.dataset = {};
        this.readOnly = false;
        this.value = value;
        this.autofilled = false;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    matches(selector) {
        return this.autofilled && (selector === ':autofill' || selector === ':-webkit-autofill');
    }
}

function eventWithProperties(type, properties = {}, options = {}) {
    const event = new Event(type, options);
    for (const [name, value] of Object.entries(properties)) {
        Object.defineProperty(event, name, { configurable: true, value });
    }
    return event;
}

function dispatchInput(input, inputType = '') {
    const event = eventWithProperties('input', { inputType }, { cancelable: true });
    input.dispatchEvent(event);
    return event;
}

test('recovers the loaded proxy value, including an intentional empty value', () => {
    assert.equal(
        resolveTrustedProxyPassword({
            selected_proxy: { name: 'Proxy', password: '' },
            oai_settings: { proxy_password: 'browser-account-password' },
        },
            'live-value',
        ),
        '',
    );
    assert.equal(
        resolveTrustedProxyPassword({
            oai_settings: { proxy_password: 'saved-proxy-password' },
        },
            'browser-account-password',
        ),
        'saved-proxy-password',
    );
    assert.equal(
        resolveTrustedProxyPassword({
            selected_proxy: { name: 'Proxy' },
            oai_settings: { proxy_password: 'saved-proxy-password' },
        },
            'browser-account-password',
        ),
        'saved-proxy-password',
    );
    assert.equal(
        resolveTrustedProxyPassword({ proxy_password: 'legacy-proxy-password' }, 'browser-account-password'),
        'legacy-proxy-password',
    );
    assert.equal(resolveTrustedProxyPassword(undefined, ''), '');
});

test('marks a proxy password as a non-login secret and locks it initially', () => {
    const input = new FakePasswordInput('browser-account-password');
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');

    assert.equal(input.value, 'proxy-secret');
    assert.equal(input.getAttribute('autocomplete'), 'one-time-code');
    assert.equal(input.getAttribute('data-1p-ignore'), 'true');
    assert.equal(input.getAttribute('data-bwignore'), 'true');
    assert.equal(input.getAttribute('data-form-type'), 'other');
    assert.equal(input.getAttribute('data-lpignore'), 'true');
    assert.equal(input.readOnly, true);

    guard.cleanup();
    assert.equal(input.readOnly, false);
});

test('blocks page-load and replacement autofill before SillyTavern can save it', () => {
    const input = new FakePasswordInput('proxy-secret');
    let coreInputEvents = 0;
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');
    input.addEventListener('input', () => coreInputEvents++);

    input.value = 'browser-account-password';
    const pageLoadEvent = dispatchInput(input);
    assert.equal(input.value, 'proxy-secret');
    assert.equal(pageLoadEvent.defaultPrevented, true);
    assert.equal(coreInputEvents, 0);

    input.value = 'browser-account-password';
    const replacementEvent = dispatchInput(input, 'insertReplacementText');
    assert.equal(input.value, 'proxy-secret');
    assert.equal(replacementEvent.defaultPrevented, true);
    assert.equal(coreInputEvents, 0);

    guard.cleanup();
});

test('restores a silent autofill value when the field receives focus', () => {
    const input = new FakePasswordInput('proxy-secret');
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');

    input.value = 'browser-account-password';
    input.dispatchEvent(new Event('focus'));

    assert.equal(input.value, 'proxy-secret');
    assert.equal(guard.getValue(), 'proxy-secret');
    guard.cleanup();
});

test('clicking the field alone does not authorize a password-manager fill', () => {
    const input = new FakePasswordInput('proxy-secret');
    let coreInputEvents = 0;
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');
    input.addEventListener('input', () => coreInputEvents++);

    input.dispatchEvent(new Event('pointerdown'));
    assert.equal(input.readOnly, false);
    input.value = 'browser-account-password';
    dispatchInput(input, 'insertReplacementText');

    assert.equal(input.value, 'proxy-secret');
    assert.equal(coreInputEvents, 0);
    guard.cleanup();
});

test('allows an intentional keyboard edit and locks the field again after blur', () => {
    const input = new FakePasswordInput('proxy-secret');
    let coreInputEvents = 0;
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');
    input.addEventListener('input', () => coreInputEvents++);

    input.dispatchEvent(eventWithProperties('pointerdown'));
    input.dispatchEvent(eventWithProperties('keydown', { key: 'n' }));
    input.value = 'new-proxy-secret';
    dispatchInput(input, 'insertText');

    assert.equal(input.value, 'new-proxy-secret');
    assert.equal(guard.getValue(), 'new-proxy-secret');
    assert.equal(coreInputEvents, 1);

    input.dispatchEvent(new Event('blur'));
    assert.equal(input.readOnly, true);
    guard.cleanup();
});

test('allows deletion and composition edits', () => {
    const input = new FakePasswordInput('proxy-secret');
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');

    input.dispatchEvent(eventWithProperties('pointerdown'));
    input.dispatchEvent(eventWithProperties('keydown', { key: 'Backspace' }));
    input.value = 'proxy-secre';
    dispatchInput(input, 'deleteContentBackward');
    assert.equal(guard.getValue(), 'proxy-secre');

    input.dispatchEvent(new Event('compositionstart'));
    input.value = '代理密碼';
    dispatchInput(input, 'insertCompositionText');
    assert.equal(guard.getValue(), '代理密碼');

    guard.cleanup();
});

test('allows paste and composition edits but rejects autofill styling', () => {
    const input = new FakePasswordInput('proxy-secret');
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');

    input.dispatchEvent(new Event('pointerdown'));
    input.dispatchEvent(new Event('paste'));
    input.value = 'pasted-proxy-secret';
    dispatchInput(input, 'insertFromPaste');
    assert.equal(guard.getValue(), 'pasted-proxy-secret');

    input.autofilled = true;
    input.value = 'browser-account-password';
    dispatchInput(input, 'insertText');
    assert.equal(input.value, 'pasted-proxy-secret');
    assert.equal(guard.getValue(), 'pasted-proxy-secret');

    guard.cleanup();
});

test('sync and restore update the trusted value without dispatching input', () => {
    const input = new FakePasswordInput('proxy-secret');
    const guard = installPasswordAutofillGuard(input, 'proxy-secret');
    let inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);

    assert.equal(guard.sync('selected-proxy-secret'), 'selected-proxy-secret');
    assert.equal(input.value, 'selected-proxy-secret');
    input.value = 'untrusted-value';
    assert.equal(guard.restore(), 'selected-proxy-secret');
    assert.equal(input.value, 'selected-proxy-secret');
    assert.equal(inputEvents, 0);

    assert.strictEqual(installPasswordAutofillGuard(input, 'ignored'), guard);
    guard.cleanup();
});
