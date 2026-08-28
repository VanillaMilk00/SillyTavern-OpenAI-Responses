import assert from 'node:assert/strict';
import test from 'node:test';

import {
    normalizeApiBase,
    shouldRouteGenerationToResponses,
} from '../request-routing.js';

test('normalizeApiBase ignores surrounding whitespace and trailing slashes', () => {
    assert.equal(
        normalizeApiBase('  https://opencode.ai/zen/go/v1///  '),
        'https://opencode.ai/zen/go/v1',
    );
});

test('routes the active OpenAI Reverse Proxy through Responses', () => {
    const request = {
        chat_completion_source: 'openai',
        reverse_proxy: 'https://opencode.ai/zen/go/v1/',
    };

    assert.equal(
        shouldRouteGenerationToResponses(request, 'https://opencode.ai/zen/go/v1'),
        true,
    );
});

test('routes the official OpenAI endpoint when both Reverse Proxy values are empty', () => {
    assert.equal(
        shouldRouteGenerationToResponses({ chat_completion_source: 'openai' }, ''),
        true,
    );
});

test('does not claim a third-party request that overrides the Reverse Proxy', () => {
    const foxJudgeRequest = {
        chat_completion_source: 'openai',
        reverse_proxy: 'https://api.cline.bot/api/v1',
        model: 'cline-pass/deepseek-v4-flash',
    };

    assert.equal(
        shouldRouteGenerationToResponses(foxJudgeRequest, 'https://opencode.ai/zen/go/v1'),
        false,
    );
    assert.equal('_openai_responses' in foxJudgeRequest, false);
});

test('does not claim an explicitly custom Chat Completions request', () => {
    const request = {
        chat_completion_source: 'custom',
        reverse_proxy: 'https://opencode.ai/zen/go/v1',
    };

    assert.equal(
        shouldRouteGenerationToResponses(request, 'https://opencode.ai/zen/go/v1'),
        false,
    );
});

test('rejects invalid generation data', () => {
    assert.equal(shouldRouteGenerationToResponses(null, ''), false);
    assert.equal(shouldRouteGenerationToResponses('request', ''), false);
});
