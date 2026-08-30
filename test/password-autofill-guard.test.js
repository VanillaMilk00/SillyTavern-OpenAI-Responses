import assert from 'node:assert/strict';
import test from 'node:test';

import { installPasswordAutofillGuard } from '../password-autofill-guard.js';

class FakePasswordInput extends EventTarget {
    constructor(value = '') {
        super();
        this.attributes = new Map();
        this.dataset = {};
        this.readOnly = false;
        this.value = value;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }
}

test('marks a proxy password as a non-login secret and locks it initially', () => {
    const input = new FakePasswordInput('proxy-secret');
    const cleanup = installPasswordAutofillGuard(input, () => 'proxy-secret');

    assert.equal(input.getAttribute('autocomplete'), 'one-time-code');
    assert.equal(input.getAttribute('data-1p-ignore'), 'true');
    assert.equal(input.getAttribute('data-bwignore'), 'true');
    assert.equal(input.getAttribute('data-form-type'), 'other');
    assert.equal(input.getAttribute('data-lpignore'), 'true');
    assert.equal(input.readOnly, true);

    cleanup();
    assert.equal(input.readOnly, false);
});

test('blocks an autofill input before SillyTavern can save it', () => {
    const input = new FakePasswordInput('proxy-secret');
    let coreInputEvents = 0;
    installPasswordAutofillGuard(input, () => 'proxy-secret');
    input.addEventListener('input', () => coreInputEvents++);

    input.value = 'browser-account-password';
    const event = new Event('input', { cancelable: true });
    input.dispatchEvent(event);

    assert.equal(input.value, 'proxy-secret');
    assert.equal(event.defaultPrevented, true);
    assert.equal(coreInputEvents, 0);
});

test('allows direct editing and locks the field again after blur', () => {
    const input = new FakePasswordInput('proxy-secret');
    let coreInputEvents = 0;
    installPasswordAutofillGuard(input, () => 'proxy-secret');
    input.addEventListener('input', () => coreInputEvents++);

    input.dispatchEvent(new Event('pointerdown'));
    assert.equal(input.readOnly, false);

    input.value = 'new-proxy-secret';
    input.dispatchEvent(new Event('input', { cancelable: true }));
    assert.equal(input.value, 'new-proxy-secret');
    assert.equal(coreInputEvents, 1);

    input.dispatchEvent(new Event('blur'));
    assert.equal(input.readOnly, true);
});

