import { eventSource, event_types, saveSettingsDebounced, settings as loadedSettings } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { installPasswordAutofillGuard, resolveTrustedProxyPassword } from './password-autofill-guard.js';
import { shouldRouteGenerationToResponses } from './request-routing.js';

const MODULE_NAME = 'openaiResponses';
const SENTINEL_VALUE = 'openai_responses';
const CORE_SOURCE_VALUE = 'openai';
const GENERATE_ROUTE = '/api/backends/chat-completions/generate';
const PLUGIN_ROUTE = '/api/plugins/openai-responses/generate';
const HEALTH_ROUTE = '/api/plugins/openai-responses/health';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    store: false,
    truncation: 'disabled',
    manualModel: '',
    custom_include_body: '',
    custom_exclude_body: '',
    custom_include_headers: '',
});

let sourceOption;
let originalFetch;
let initializationPromise;
let proxyPasswordGuard;

function getSettings() {
    extension_settings[MODULE_NAME] ??= { ...DEFAULT_SETTINGS };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

function isGenerateRequest(input) {
    try {
        const rawUrl = typeof input === 'string' ? input : input?.url;
        return new URL(rawUrl, window.location.origin).pathname === GENERATE_ROUTE;
    } catch {
        return false;
    }
}

function installFetchBridge() {
    if (globalThis.__openaiResponsesFetchBridgeInstalled) return;

    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function openaiResponsesFetch(input, init = {}) {
        if (!isGenerateRequest(input) || typeof init?.body !== 'string') {
            return originalFetch(input, init);
        }

        try {
            const body = JSON.parse(init.body);
            if (!body?._openai_responses) {
                return originalFetch(input, init);
            }

            return originalFetch(PLUGIN_ROUTE, {
                ...init,
                body: JSON.stringify(body),
            });
        } catch (error) {
            console.error('[OpenAI Responses] Failed to redirect generation request.', error);
            return originalFetch(input, init);
        }
    };

    globalThis.__openaiResponsesFetchBridgeInstalled = true;
}

function tagUnsupportedControls() {
    const selectors = [
        '#n_openai',
        '#freq_pen_openai',
        '#pres_pen_openai',
        '#seed_openai',
        '#logit_bias_openai',
        '#openai_request_images',
        '#openai_show_thoughts',
    ];

    for (const selector of selectors) {
        const element = document.querySelector(selector);
        const container = element?.closest('.range-block') ?? element?.parentElement;
        container?.classList.add('openai-responses-unsupported');
    }
}

function updateActiveUi() {
    const enabled = Boolean(getSettings().enabled);
    document.body.classList.toggle('openai-responses-active', enabled);
    document.getElementById('openai_responses_active_note')?.classList.toggle('displayNone', !enabled);

    if (enabled && sourceOption) {
        sourceOption.value = CORE_SOURCE_VALUE;
        sourceOption.selected = true;
    }
}

async function checkServerPlugin() {
    if (!getSettings().enabled) return;

    try {
        const response = await originalFetch(HEALTH_ROUTE, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        console.warn('[OpenAI Responses] Server plugin is unavailable.', error);
        toastr.error(
            '请启用并安装配套的 server plugin，然后重启 SillyTavern。',
            'OpenAI Responses 服务端未加载',
            { preventDuplicates: true, timeOut: 10000 },
        );
    }
}

function setEnabled(enabled) {
    const settings = getSettings();
    if (settings.enabled === enabled) return;

    settings.enabled = enabled;
    saveSettingsDebounced();
    updateActiveUi();

    if (enabled) {
        queueMicrotask(checkServerPlugin);
    }
}

function onSourceChangeCapture(event) {
    const select = event.currentTarget;
    const selected = select.selectedOptions?.[0];
    const selectedResponses = selected?.dataset?.openaiResponses === 'true';

    if (selectedResponses) {
        // SillyTavern continues to use its mature OpenAI model/key/settings path.
        // The extension marker redirects only the final generation request.
        selected.value = CORE_SOURCE_VALUE;
        setEnabled(true);
    } else {
        if (sourceOption) sourceOption.value = SENTINEL_VALUE;
        setEnabled(false);
    }
}

function installSourceOption() {
    const select = document.getElementById('chat_completion_source');
    if (!(select instanceof HTMLSelectElement)) {
        throw new Error('Chat Completion Source selector was not found.');
    }

    const existingOption = [...select.options].find(option => option.dataset.openaiResponses === 'true');
    if (existingOption) {
        sourceOption = existingOption;
        sourceOption.value = getSettings().enabled ? CORE_SOURCE_VALUE : SENTINEL_VALUE;
        return;
    }

    sourceOption = document.createElement('option');
    sourceOption.textContent = 'OpenAI Responses';
    sourceOption.value = getSettings().enabled ? CORE_SOURCE_VALUE : SENTINEL_VALUE;
    sourceOption.dataset.openaiResponses = 'true';

    // Insert before the regular OpenAI option. Programmatic .val('openai') calls
    // made by SillyTavern will then settle on the regular OpenAI option.
    const regularOpenAi = [...select.options].find(option => option.value === CORE_SOURCE_VALUE);
    regularOpenAi?.before(sourceOption);
    if (!regularOpenAi) select.prepend(sourceOption);

    select.addEventListener('change', onSourceChangeCapture, true);
}

function installConnectionNote() {
    const select = document.getElementById('chat_completion_source');
    if (!select || document.getElementById('openai_responses_active_note')) return;

    const note = document.createElement('div');
    note.id = 'openai_responses_active_note';
    note.className = 'openai-responses-note displayNone';
    note.innerHTML = '<strong>Responses API 已启用。</strong> 密钥、模型列表和反代继续使用下方的 OpenAI 配置；生成请求将发送到 <code>/responses</code>。';
    select.insertAdjacentElement('afterend', note);
}

function applyManualModel() {
    const input = document.getElementById('openai_responses_manual_model');
    const model = String(input?.value ?? '').trim();
    if (!model) {
        toastr.warning('请输入模型 ID。', 'OpenAI Responses');
        return;
    }

    const modelSelect = document.getElementById('model_openai_select');
    if (!(modelSelect instanceof HTMLSelectElement)) return;

    let option = [...modelSelect.options].find(item => item.value === model);
    if (!option) {
        option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        option.dataset.openaiResponsesManual = 'true';
        modelSelect.append(option);
    }

    option.selected = true;
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    getSettings().manualModel = model;
    saveSettingsDebounced();
    toastr.success(`已选择 ${model}`, 'OpenAI Responses');
}

function installSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('openai_responses_settings')) return;

    const settings = getSettings();
    const panel = document.createElement('div');
    panel.id = 'openai_responses_settings';
    panel.className = 'extension_container openai-responses-settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>OpenAI Responses</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="openai_responses_store" type="checkbox" ${settings.store ? 'checked' : ''}>
                    <span>允许 OpenAI 存储 Response（默认关闭）</span>
                </label>
                <label for="openai_responses_truncation">超长上下文处理</label>
                <select id="openai_responses_truncation" class="text_pole">
                    <option value="disabled" ${settings.truncation === 'disabled' ? 'selected' : ''}>报错，不自动截断</option>
                    <option value="auto" ${settings.truncation === 'auto' ? 'selected' : ''}>自动截断最早内容</option>
                </select>
                <label for="openai_responses_manual_model">手动模型 ID（用于未出现在模型列表中的模型）</label>
                <div class="flex-container">
                    <input id="openai_responses_manual_model" class="text_pole flex1" type="text" value="${String(settings.manualModel).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}" placeholder="例如 gpt-5.4">
                    <button id="openai_responses_apply_model" class="menu_button">应用</button>
                </div>
                <button id="openai_responses_additional_parameters_toggle" type="button" class="menu_button" aria-expanded="false" aria-controls="openai_responses_additional_parameters">其他參數</button>
                <div id="openai_responses_additional_parameters" class="openai-responses-additional-parameters displayNone">
                    <label for="openai_responses_custom_include_body">包含請求主體參數</label>
                    <textarea id="openai_responses_custom_include_body" class="text_pole openai-responses-parameter-textarea" rows="4" spellcheck="false" placeholder="top_k: 20&#10;repetition_penalty: 1.1"></textarea>
                    <small>使用 YAML 物件；這些欄位會合併到 Responses 請求主體。</small>

                    <label for="openai_responses_custom_exclude_body">排除請求主體參數</label>
                    <textarea id="openai_responses_custom_exclude_body" class="text_pole openai-responses-parameter-textarea" rows="4" spellcheck="false" placeholder="- temperature&#10;- top_p"></textarea>
                    <small>使用 YAML 陣列；列出的頂層欄位會從請求主體移除。</small>

                    <label for="openai_responses_custom_include_headers">包含請求標頭（Request Headers）</label>
                    <textarea id="openai_responses_custom_include_headers" class="text_pole openai-responses-parameter-textarea" rows="4" spellcheck="false" placeholder="X-Custom-Header: value&#10;Another-Header: another-value"></textarea>
                    <small>使用 YAML 物件；標頭會附加到上游 Responses 請求。</small>
                </div>
                <small>函数调用、流式输出、图片输入、JSON Schema、推理强度、verbosity 和 Web Search 会自动转换。</small>
            </div>
        </div>`;
    host.append(panel);

    panel.querySelector('#openai_responses_store')?.addEventListener('change', event => {
        settings.store = Boolean(event.currentTarget.checked);
        saveSettingsDebounced();
    });
    panel.querySelector('#openai_responses_truncation')?.addEventListener('change', event => {
        settings.truncation = String(event.currentTarget.value);
        saveSettingsDebounced();
    });
    panel.querySelector('#openai_responses_apply_model')?.addEventListener('click', applyManualModel);

    const additionalParametersToggle = panel.querySelector('#openai_responses_additional_parameters_toggle');
    const additionalParameters = panel.querySelector('#openai_responses_additional_parameters');
    if (additionalParametersToggle && additionalParameters) {
        additionalParametersToggle.addEventListener('click', () => {
            const hidden = additionalParameters.classList.toggle('displayNone');
            additionalParametersToggle.setAttribute('aria-expanded', String(!hidden));
        });
    }

    const parameterFields = [
        ['openai_responses_custom_include_body', 'custom_include_body'],
        ['openai_responses_custom_exclude_body', 'custom_exclude_body'],
        ['openai_responses_custom_include_headers', 'custom_include_headers'],
    ];
    for (const [elementId, settingKey] of parameterFields) {
        const textarea = panel.querySelector(`#${elementId}`);
        if (!(textarea instanceof HTMLTextAreaElement)) continue;
        textarea.value = typeof settings[settingKey] === 'string' ? settings[settingKey] : '';
        textarea.addEventListener('input', event => {
            settings[settingKey] = String(event.currentTarget.value ?? '');
            saveSettingsDebounced();
        });
    }
}

function installProxyPasswordProtection() {
    const input = document.getElementById('openai_proxy_password');
    if (!(input instanceof HTMLInputElement)) return;

    if (proxyPasswordGuard) return;

    const liveValueBeforeRestore = oai_settings.proxy_password;
    const loadedValue = resolveTrustedProxyPassword(loadedSettings, liveValueBeforeRestore);
    proxyPasswordGuard = installPasswordAutofillGuard(input, loadedValue);
    const trustedValue = proxyPasswordGuard.restore();
    oai_settings.proxy_password = trustedValue;

    // The core input handler may have queued a save before this extension was
    // activated. Re-save the restored value so that the browser credential can
    // never reach SillyTavern's persisted settings.
    if (liveValueBeforeRestore !== trustedValue) saveSettingsDebounced();

    const restoreBeforeCoreChange = () => {
        if (!proxyPasswordGuard) return;
        const value = proxyPasswordGuard.restore();
        oai_settings.proxy_password = value;
    };

    const syncAfterCoreChange = () => {
        queueMicrotask(() => {
            if (!proxyPasswordGuard) return;
            const value = proxyPasswordGuard.sync(oai_settings.proxy_password);
            oai_settings.proxy_password = value;
        });
    };

    // Preset changes and save/delete actions are handled by SillyTavern's
    // existing listeners first; synchronize after those listeners complete.
    const listenAfterCoreChange = (element, eventName) => {
        if (!element) return;

        // SillyTavern uses both native events and jQuery .trigger() for these
        // controls across supported releases. Prefer jQuery when available so
        // programmatic preset changes are covered as well.
        const jqueryElement = typeof globalThis.$ === 'function' ? globalThis.$(element) : null;
        if (jqueryElement && typeof jqueryElement.on === 'function') {
            jqueryElement.on(`${eventName}.openaiResponsesPasswordGuard`, syncAfterCoreChange);
            return;
        }

        element.addEventListener(eventName, syncAfterCoreChange);
    };

    const saveProxy = document.getElementById('save_proxy');
    const deleteProxy = document.getElementById('delete_proxy');
    saveProxy?.addEventListener('click', restoreBeforeCoreChange, true);
    deleteProxy?.addEventListener('click', restoreBeforeCoreChange, true);
    listenAfterCoreChange(document.getElementById('openai_proxy_preset'), 'change');
    listenAfterCoreChange(document.getElementById('settings_preset_openai'), 'change');
    listenAfterCoreChange(saveProxy, 'click');
    listenAfterCoreChange(deleteProxy, 'click');
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, syncAfterCoreChange);

    // A password manager may change the displayed value without dispatching an
    // input event. Restore the trusted value before the core connection handler.
    document.getElementById('api_button_openai')?.addEventListener('click', () => {
        restoreBeforeCoreChange();
    }, true);
}

function onGenerationSettingsReady(generationData) {
    if (!getSettings().enabled || oai_settings.chat_completion_source !== CORE_SOURCE_VALUE) return;
    if (!shouldRouteGenerationToResponses(generationData, oai_settings.reverse_proxy)) {
        console.debug('[OpenAI Responses] Skipped a generation request targeting a different API endpoint.');
        return;
    }

    if (proxyPasswordGuard) {
        const trustedValue = proxyPasswordGuard.restore();
        oai_settings.proxy_password = trustedValue;
        generationData.proxy_password = trustedValue;
    }

    const settings = getSettings();
    generationData._openai_responses = {
        store: Boolean(settings.store),
        truncation: settings.truncation === 'auto' ? 'auto' : 'disabled',
        custom_include_body: typeof settings.custom_include_body === 'string' ? settings.custom_include_body : '',
        custom_exclude_body: typeof settings.custom_exclude_body === 'string' ? settings.custom_exclude_body : '',
        custom_include_headers: typeof settings.custom_include_headers === 'string' ? settings.custom_include_headers : '',
    };

    // Responses has one candidate per request. SillyTavern will still provide
    // normal swiping/regeneration, but not multi-swipe in a single request.
    delete generationData.n;
}

async function waitForDocumentReady() {
    if (document.readyState !== 'loading') return;
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

async function initialize() {
    await waitForDocumentReady();
    getSettings();
    // Install and restore the proxy secret before any later initialization can
    // allow a queued core settings save to run.
    installProxyPasswordProtection();
    installFetchBridge();
    installSourceOption();
    installConnectionNote();
    installSettingsPanel();
    tagUnsupportedControls();
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onGenerationSettingsReady);
    updateActiveUi();

    if (getSettings().enabled) {
        await checkServerPlugin();
    }
}

export function init() {
    if (!initializationPromise) {
        initializationPromise = initialize().catch(error => {
            initializationPromise = undefined;
            throw error;
        });
    }
    return initializationPromise;
}

// SillyTavern 1.17+ calls the manifest activate hook. Versions 1.14-1.16 only
// import the module, so they need this side-effect bootstrap. init() is
// intentionally idempotent to make both startup paths safe.
void init().catch(error => console.error('[OpenAI Responses] Failed to initialize extension.', error));
