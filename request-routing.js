const OPENAI_SOURCE = 'openai';

/**
 * Normalize a Reverse Proxy base URL for request ownership comparisons.
 * SillyTavern and third-party generators may disagree only on trailing slashes.
 *
 * @param {unknown} value Reverse Proxy base URL.
 * @returns {string} Normalized base URL.
 */
export function normalizeApiBase(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Decide whether a generated request still belongs to the active Responses
 * connection. Third-party extensions can emit the same global settings event
 * after replacing the request's API endpoint; those requests must retain their
 * original protocol instead of being redirected to `/responses`.
 *
 * @param {unknown} generationData Request body emitted by SillyTavern.
 * @param {unknown} configuredReverseProxy Reverse Proxy selected in the main connection.
 * @returns {boolean} Whether the Responses bridge should claim the request.
 */
export function shouldRouteGenerationToResponses(generationData, configuredReverseProxy) {
    if (!generationData || typeof generationData !== 'object') return false;

    const requestSource = String(generationData.chat_completion_source ?? OPENAI_SOURCE);
    if (requestSource !== OPENAI_SOURCE) return false;

    const requestApiBase = normalizeApiBase(generationData.reverse_proxy);
    const configuredApiBase = normalizeApiBase(configuredReverseProxy);
    return requestApiBase === configuredApiBase;
}
