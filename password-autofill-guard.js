const GUARDED_DATASET_KEY = 'openaiResponsesAutofillGuard';
const CONTROLLER_PROPERTY = '__openaiResponsesPasswordGuardController';

const AUTOFILL_GUARD_ATTRIBUTES = Object.freeze({
    autocomplete: 'one-time-code',
    autocapitalize: 'off',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-bwignore': 'true',
    'data-form-type': 'other',
    'data-lpignore': 'true',
});

// These are the InputEvent types produced by an intentional edit. Autofill
// replacement uses insertReplacementText (or no beforeinput event at all), so
// it must not be treated as a user edit.
const USER_EDIT_INPUT_TYPES = new Set([
    'insertText',
    'insertCompositionText',
    'insertFromComposition',
    'insertFromPaste',
    'insertFromDrop',
    'deleteContentBackward',
    'deleteContentForward',
    'deleteWordBackward',
    'deleteWordForward',
    'deleteByCut',
    'deleteByDrag',
    'historyUndo',
    'historyRedo',
]);

const VALUE_EDITING_KEYS = new Set(['Backspace', 'Delete']);

function asString(value) {
    return String(value ?? '');
}

function hasOwn(object, key) {
    return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Select the value that was loaded from SillyTavern settings before browser
 * autofill can mutate the live OpenAI settings object.
 *
 * @param {object | undefined} settings SillyTavern's loaded settings snapshot.
 * @param {unknown} fallback Current live value, used only when no snapshot is available.
 * @returns {string} Trusted proxy password, including an intentional empty value.
 */
export function resolveTrustedProxyPassword(settings, fallback = '') {
    if (hasOwn(settings?.selected_proxy, 'password') && settings.selected_proxy.password !== undefined) {
        return asString(settings.selected_proxy.password);
    }

    if (hasOwn(settings?.oai_settings, 'proxy_password') && settings.oai_settings.proxy_password !== undefined) {
        return asString(settings.oai_settings.proxy_password);
    }

    // SillyTavern versions before nested oai_settings stored this at the root.
    if (hasOwn(settings, 'proxy_password') && settings.proxy_password !== undefined) {
        return asString(settings.proxy_password);
    }

    return asString(fallback);
}

function isAutofilled(input) {
    if (typeof input.matches !== 'function') return false;

    for (const selector of [':autofill', ':-webkit-autofill']) {
        try {
            if (input.matches(selector)) return true;
        } catch {
            // Unsupported pseudo-classes are expected on Firefox and older WebViews.
        }
    }

    return false;
}

function isValueEditingKey(event) {
    if (event?.ctrlKey || event?.metaKey || event?.altKey) return false;
    return VALUE_EDITING_KEYS.has(event?.key) || (typeof event?.key === 'string' && event.key.length === 1);
}

function createNoopController(input) {
    return {
        sync: value => asString(value),
        restore: () => asString(input?.value),
        getValue: () => asString(input?.value),
        cleanup: () => {},
    };
}

/**
 * Keep browser password managers from treating a proxy secret as an account
 * password. SillyTavern saves this input on every `input` event, so an
 * autofill event must be stopped before the core listener receives it.
 *
 * @param {HTMLInputElement | any} input Proxy password input.
 * @param {unknown | (() => unknown)} trustedValue Initial trusted value.
 * @returns {{sync: (value: unknown) => string, restore: () => string, getValue: () => string, cleanup: () => void}}
 */
export function installPasswordAutofillGuard(input, trustedValue) {
    if (!input || typeof input.addEventListener !== 'function' || typeof input.setAttribute !== 'function') {
        return createNoopController(input);
    }

    if (input[CONTROLLER_PROPERTY]) {
        return input[CONTROLLER_PROPERTY];
    }

    // Avoid taking over a guard installed by a different copy of the module.
    if (input.dataset?.[GUARDED_DATASET_KEY] === 'true') {
        return createNoopController(input);
    }

    input.dataset ??= {};
    input.dataset[GUARDED_DATASET_KEY] = 'true';

    for (const [name, value] of Object.entries(AUTOFILL_GUARD_ATTRIBUTES)) {
        input.setAttribute(name, value);
    }

    const previousReadOnly = Boolean(input.readOnly);
    let trusted = asString(typeof trustedValue === 'function' ? trustedValue() : trustedValue);
    let pendingUserEdit = false;

    // A read-only password field is not eligible for page-load autofill in
    // Chromium. Pointer interaction unlocks editing, but does not authorize
    // an input event by itself: clicking the field may also trigger autofill.
    input.readOnly = true;

    const unlockForUser = () => {
        if (!pendingUserEdit) restore();
        input.readOnly = false;
    };

    const authorizeUserEdit = () => {
        pendingUserEdit = true;
        input.readOnly = false;
    };

    const onKeydown = event => {
        unlockForUser();
        if (isValueEditingKey(event)) authorizeUserEdit();
    };

    const onBeforeInput = event => {
        unlockForUser();
        if (USER_EDIT_INPUT_TYPES.has(String(event?.inputType ?? ''))) {
            authorizeUserEdit();
        }
    };

    const onFocus = () => {
        // Autofill can update the value without dispatching an input event.
        // Reconcile it before the user starts an edit session.
        if (!pendingUserEdit) restore();
    };

    const onKeyup = () => {
        // A key that produced no value change should not authorize a later
        // autofill event (for example, when Backspace is pressed at position 0).
        pendingUserEdit = false;
    };

    const blockUnexpectedInput = event => {
        const inputType = String(event?.inputType ?? '');
        const autofillEvent = inputType === 'insertReplacementText' || (!pendingUserEdit && isAutofilled(input));

        if (pendingUserEdit && !autofillEvent) {
            pendingUserEdit = false;
            trusted = asString(input.value);
            return;
        }

        pendingUserEdit = false;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        input.value = trusted;
    };

    const relock = () => {
        pendingUserEdit = false;
        input.readOnly = true;
    };

    const restore = () => {
        input.value = trusted;
        return trusted;
    };

    const sync = value => {
        trusted = asString(value);
        return restore();
    };

    const cleanup = () => {
        input.removeEventListener('pointerdown', unlockForUser, true);
        input.removeEventListener('keydown', onKeydown, true);
        input.removeEventListener('keyup', onKeyup, true);
        input.removeEventListener('beforeinput', onBeforeInput, true);
        input.removeEventListener('focus', onFocus, true);
        input.removeEventListener('paste', authorizeUserEdit, true);
        input.removeEventListener('cut', authorizeUserEdit, true);
        input.removeEventListener('drop', authorizeUserEdit, true);
        input.removeEventListener('compositionstart', authorizeUserEdit, true);
        input.removeEventListener('input', blockUnexpectedInput, true);
        input.removeEventListener('blur', relock, true);
        input.readOnly = previousReadOnly;
        if (input.dataset) delete input.dataset[GUARDED_DATASET_KEY];
        if (input[CONTROLLER_PROPERTY] === controller) delete input[CONTROLLER_PROPERTY];
    };

    input.addEventListener('pointerdown', unlockForUser, true);
    input.addEventListener('keydown', onKeydown, true);
    input.addEventListener('keyup', onKeyup, true);
    input.addEventListener('beforeinput', onBeforeInput, true);
    input.addEventListener('focus', onFocus, true);
    input.addEventListener('paste', authorizeUserEdit, true);
    input.addEventListener('cut', authorizeUserEdit, true);
    input.addEventListener('drop', authorizeUserEdit, true);
    input.addEventListener('compositionstart', authorizeUserEdit, true);
    input.addEventListener('input', blockUnexpectedInput, true);
    input.addEventListener('blur', relock, true);

    const controller = { sync, restore, getValue: () => trusted, cleanup };
    Object.defineProperty(input, CONTROLLER_PROPERTY, {
        configurable: true,
        value: controller,
    });

    // Restore immediately in case the field was autofilled before this module
    // was activated, while keeping the original value in the controller.
    restore();
    return controller;
}
