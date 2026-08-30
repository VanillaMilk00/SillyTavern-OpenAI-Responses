const GUARDED_DATASET_KEY = 'openaiResponsesAutofillGuard';

const AUTOFILL_GUARD_ATTRIBUTES = Object.freeze({
    autocomplete: 'one-time-code',
    autocapitalize: 'off',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-bwignore': 'true',
    'data-form-type': 'other',
    'data-lpignore': 'true',
});

/**
 * Keep browser password managers from treating a proxy secret as an account
 * password. SillyTavern saves this input on every `input` event, so an
 * autofill event must be stopped before the core listener receives it.
 *
 * @param {HTMLInputElement | any} input Proxy password input.
 * @param {() => unknown} getTrustedValue Returns SillyTavern's current value.
 * @returns {() => void} Cleanup callback.
 */
export function installPasswordAutofillGuard(input, getTrustedValue) {
    if (!input || typeof input.addEventListener !== 'function' || typeof input.setAttribute !== 'function') {
        return () => {};
    }

    if (input.dataset?.[GUARDED_DATASET_KEY] === 'true') {
        return () => {};
    }

    input.dataset ??= {};
    input.dataset[GUARDED_DATASET_KEY] = 'true';

    for (const [name, value] of Object.entries(AUTOFILL_GUARD_ATTRIBUTES)) {
        input.setAttribute(name, value);
    }

    // A read-only password field is not eligible for page-load autofill in
    // Chromium. Unlock only after direct interaction, then lock again on blur.
    input.readOnly = true;
    let userEditing = false;

    const unlockForUser = () => {
        userEditing = true;
        input.readOnly = false;
    };

    const relock = () => {
        userEditing = false;
        input.readOnly = true;
    };

    const blockUnexpectedInput = event => {
        if (userEditing) return;

        const trustedValue = String(getTrustedValue?.() ?? '');
        if (String(input.value ?? '') === trustedValue) return;

        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        input.value = trustedValue;
    };

    input.addEventListener('pointerdown', unlockForUser, true);
    input.addEventListener('keydown', unlockForUser, true);
    input.addEventListener('input', blockUnexpectedInput, true);
    input.addEventListener('blur', relock, true);

    return () => {
        input.removeEventListener('pointerdown', unlockForUser, true);
        input.removeEventListener('keydown', unlockForUser, true);
        input.removeEventListener('input', blockUnexpectedInput, true);
        input.removeEventListener('blur', relock, true);
        input.readOnly = false;
        if (input.dataset) delete input.dataset[GUARDED_DATASET_KEY];
    };
}

