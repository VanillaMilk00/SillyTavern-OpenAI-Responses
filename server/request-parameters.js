import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let yamlParse;

// SillyTavern already ships the `yaml` package. Keep the extension usable in
// isolated unit tests (and on older installations missing that package) with
// the small parser below as a compatibility fallback.
try {
    yamlParse = require('yaml')?.parse;
} catch {
    yamlParse = undefined;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stripInlineComment(value) {
    let singleQuoted = false;
    let doubleQuoted = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '\\' && (singleQuoted || doubleQuoted)) {
            index += 1;
            continue;
        }
        if (character === '"' && !singleQuoted) doubleQuoted = !doubleQuoted;
        if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
        if (character === '#' && !singleQuoted && !doubleQuoted) return value.slice(0, index);
    }

    return value;
}

function parseScalar(value) {
    const text = String(value ?? '').trim();
    if (text === '' || text === '~' || /^null$/i.test(text)) return null;
    if (/^(true|yes|on)$/i.test(text)) return true;
    if (/^(false|no|off)$/i.test(text)) return false;

    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
        try {
            return JSON.parse(text);
        } catch {
            return text.slice(1, -1);
        }
    }
    if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
        return text.slice(1, -1).replaceAll("''", "'");
    }

    if (/^-?\d+$/.test(text)) {
        const number = Number.parseInt(text, 10);
        if (Number.isFinite(number)) return number;
    }
    if (/^-?(?:\d+\.\d*|\d*\.\d+|\d+e[+-]?\d+|\d+\.\d*e[+-]?\d+)$/i.test(text)) {
        const number = Number.parseFloat(text);
        if (Number.isFinite(number)) return number;
    }

    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try {
            return JSON.parse(text);
        } catch {
            // Fall through to a string. The full YAML parser, when available,
            // handles non-JSON flow collections.
        }
    }

    return text;
}

function parseSimpleYaml(value) {
    const records = [];
    const source = String(value).replace(/\r\n?/g, '\n');

    for (const line of source.split('\n')) {
        const withoutComment = stripInlineComment(line).replace(/\s+$/, '');
        if (!withoutComment.trim() || /^\s*---\s*$/.test(withoutComment)) continue;

        const match = withoutComment.match(/^(\s*)(.*)$/);
        const indent = match[1].replaceAll('\t', '  ').length;
        records.push({ indent, content: match[2] });
    }
    if (!records.length) return undefined;

    let index = 0;
    const peek = () => records[index];
    const isListItem = content => content === '-' || content.startsWith('- ');

    function splitKeyValue(content) {
        const separator = content.indexOf(':');
        if (separator <= 0) return null;
        const key = content.slice(0, separator).trim().replace(/^['"]|['"]$/g, '');
        return { key, value: content.slice(separator + 1).trim() };
    }

    function parseBlock(indent) {
        const first = peek();
        if (!first || first.indent < indent) return undefined;

        if (first.indent === indent && !isListItem(first.content) && !splitKeyValue(first.content)) {
            index += 1;
            return parseScalar(first.content);
        }

        if (first.indent === indent && isListItem(first.content)) {
            const result = [];
            while (index < records.length) {
                const record = records[index];
                if (record.indent !== indent || !isListItem(record.content)) break;
                const remainder = record.content === '-' ? '' : record.content.slice(2).trim();
                index += 1;

                if (!remainder) {
                    const nested = peek();
                    result.push(nested && nested.indent > indent ? parseBlock(nested.indent) : null);
                    continue;
                }

                const firstEntry = splitKeyValue(remainder);
                if (!firstEntry) {
                    result.push(parseScalar(remainder));
                    continue;
                }

                const object = {};
                const assignEntry = entry => {
                    if (entry.value === '') {
                        const nested = peek();
                        object[entry.key] = nested && nested.indent > indent
                            ? parseBlock(nested.indent)
                            : null;
                    } else {
                        object[entry.key] = parseScalar(entry.value);
                    }
                };
                assignEntry(firstEntry);

                const continuation = peek();
                const continuationIndent = continuation && continuation.indent > indent
                    ? continuation.indent
                    : indent + 2;
                while (index < records.length) {
                    const next = records[index];
                    if (next.indent !== continuationIndent || isListItem(next.content)) break;
                    const entry = splitKeyValue(next.content);
                    if (!entry) break;
                    index += 1;
                    assignEntry(entry);
                }
                result.push(object);
            }
            return result;
        }

        const object = {};
        while (index < records.length) {
            const record = records[index];
            if (record.indent !== indent || isListItem(record.content)) break;
            const entry = splitKeyValue(record.content);
            if (!entry) break;
            index += 1;

            if (entry.value === '') {
                const nested = peek();
                object[entry.key] = nested && nested.indent > indent ? parseBlock(nested.indent) : null;
            } else {
                object[entry.key] = parseScalar(entry.value);
            }
        }
        return object;
    }

    return parseBlock(records[0].indent);
}

export function parseYamlValue(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') return value;

    const source = value.trim();
    if (!source) return undefined;

    try {
        if (typeof yamlParse === 'function') return yamlParse(source);
    } catch {
        return undefined;
    }

    try {
        return parseSimpleYaml(source);
    } catch {
        return undefined;
    }
}

export function mergeObjectWithYaml(target, yamlString) {
    if (!target || typeof target !== 'object') return target;
    const parsed = parseYamlValue(yamlString);

    if (Array.isArray(parsed)) {
        for (const item of parsed) {
            if (isPlainObject(item)) Object.assign(target, item);
        }
    } else if (isPlainObject(parsed)) {
        Object.assign(target, parsed);
    }

    return target;
}

export function excludeKeysByYaml(target, yamlString) {
    if (!target || typeof target !== 'object') return target;
    const parsed = parseYamlValue(yamlString);

    if (Array.isArray(parsed)) {
        for (const key of parsed) {
            if (key !== null && key !== undefined) delete target[key];
        }
    } else if (isPlainObject(parsed)) {
        for (const key of Object.keys(parsed)) delete target[key];
    } else if (typeof parsed === 'string') {
        delete target[parsed];
    }

    return target;
}
