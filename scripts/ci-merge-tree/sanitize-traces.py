import json
import re
import stat
import sys
import zipfile
from pathlib import Path

CAP = 100 * 1024 * 1024
SAFE_EVENTS = {'before', 'after', 'event', 'context-options', 'console', 'log', 'screencast-frame'}
SAFE_TEXT_KEYS = {'type', 'apiName', 'browserName', 'platform', 'level'}
SAFE_NUMERIC_KEYS = {'startTime', 'endTime', 'time', 'wallTime', 'pageId', 'line', 'column'}

ALIASES = {}
SAFE_NUMBERS = {0, 1, 200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 500, 502, 503}

def scalar(value):
    if value is None or isinstance(value, bool) or (isinstance(value, (int, float)) and value in SAFE_NUMBERS):
        return value
    key = json.dumps(value, sort_keys=True)
    if key not in ALIASES:
        ALIASES[key] = f'trace-value-{len(ALIASES) + 1}'
    result = {'type': type(value).__name__, 'alias': ALIASES[key]}
    if isinstance(value, str):
        result['length'] = len(value)
    return result

def error_projection(error):
    message = re.sub(r'\x1b\[[0-9;]*m', '', str(error.get('message', '')) if isinstance(error, dict) else str(error))
    result = {'redacted': True}
    pair = re.search(r'expected (true|false|null) to be (true|false|null)', message)
    for field, label, pair_index in [('actual', 'Received', 1), ('expected', 'Expected', 2)]:
        match = re.search(r'^' + label + r':\s*(.*)$', message, re.MULTILINE)
        text = match.group(1).strip() if match else pair.group(pair_index) if pair else None
        if text is not None:
            try:
                value = json.loads(text)
            except (ValueError, TypeError):
                value = text
            result[field] = scalar(value)
    if 'lock timeout' in message.lower():
        result['signature'] = 'lock_timeout'
    return result

def event_projection(event):
    if not isinstance(event, dict) or event.get('type') not in SAFE_EVENTS:
        return None
    result = {}
    for key in SAFE_TEXT_KEYS:
        value = event.get(key)
        if key == 'apiName':
            allowed = isinstance(value, str) and re.fullmatch(r'(?:page|locator|expect|browser|browserContext|frame|keyboard|mouse)\.(?:goto|click|fill|press|waitFor|waitForTimeout|reload|evaluate|screenshot|toBeVisible|toBeHidden|toHaveText|toHaveURL|toBe|toEqual)', value)
        else:
            allowed = value in SAFE_EVENTS or value in {'chromium', 'firefox', 'webkit', 'linux', 'error', 'warning', 'info', 'debug'}
        if allowed:
            result[key] = value
    for key in SAFE_NUMERIC_KEYS:
        value = event.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            result[key] = value
    for key in ['callId', 'pageId', 'parentId']:
        value = event.get(key)
        if isinstance(value, str) and re.fullmatch(r'(?:call|page|frame|browser-context|context)@[a-f0-9]+', value):
            result[key] = value
    if 'error' in event:
        result['error'] = error_projection(event['error'])
    return result

def sanitize(inputs, output, gaps, identities=None):
    consumed = 0
    omitted = 0
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for index, file in enumerate(inputs):
            if file.is_symlink() or not file.is_file():
                raise ValueError('unsafe_trace_file')
            with zipfile.ZipFile(file) as source:
                for entry in source.infolist():
                    parts = Path(entry.filename).parts
                    if (entry.flag_bits & 1 or entry.filename.startswith('/') or '\\' in entry.filename
                        or any(part.startswith('.') for part in parts)
                        or stat.S_ISLNK(entry.external_attr >> 16)):
                        raise ValueError('unsafe_trace_entry')
                    consumed += entry.file_size
                    if consumed > CAP:
                        raise ValueError('trace_expansion_cap')
                    if not re.fullmatch(r'(?:test|[0-9]+-trace)\.trace', entry.filename):
                        omitted += 1
                        continue
                    records = []
                    for line in source.read(entry).splitlines():
                        value = event_projection(json.loads(line))
                        if value:
                            records.append(json.dumps(value, separators=(',', ':')))
                    target.writestr(f'{(identities or {}).get(str(file), str(index))}-{entry.filename}', '\n'.join(records))
    gaps.append({'kind': 'trace_payloads_removed', 'omittedEntries': omitted,
                 'removed': ['DOM snapshots', 'network bodies and headers', 'storage state',
                             'screenshots', 'attachments', 'action parameters', 'free text']})

if __name__ == '__main__':
    try:
        root, output, gap_file = map(Path, sys.argv[1:4])
        inputs = sorted(root.rglob('trace.zip'))
        gaps = []
        identities = {}
        index_file = root.parent / 'trace-index.jsonl'
        if index_file.exists():
            for line in index_file.read_text().splitlines():
                record = json.loads(line)
                if re.fullmatch(r'[a-f0-9-]{20,80}', str(record.get('testId', ''))):
                    identities[str(Path(record['path']))] = record['testId']
        if len(sys.argv) > 4 and sys.argv[4] == 'e2e':
            if not inputs:
                gaps.append({'kind': 'trace_missing'})
            if any(str(file) not in identities for file in inputs):
                gaps.append({'kind': 'trace_correlation_missing'})
        sanitize(inputs, output, gaps, identities)
        gap_file.write_text(json.dumps(gaps))
    except Exception:
        print('trace_sanitization_failed', file=sys.stderr)
        sys.exit(1)
