"""Transient target-free context display; never persists message bodies."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit, parse_qsl
from behavior_audit import client
from validation_holdout_protocol import digest


def safe_text(value):
    text = str(value or '')

    def url_label(match):
        try:
            url = urlsplit(match.group())
            access = sorted({key for key, _ in parse_qsl(url.query)
                             if any(word in key.lower() for word in ('pwd', 'password', 'token', 'secret', 'auth', 'key', 'signature'))})
            return ('[url_host=' + (url.hostname or 'unknown') +
                    (' access_parameter_present' if access else '') + ']')
        except ValueError:
            return '[url_redacted]'

    text = re.sub(r'https?://\S+', url_label, text)
    text = re.sub(r'(?im)^.*(?:passcode|password|비번|암호|비밀번호|인증번호|초대코드)[^\n]*(?:\n[^\n]+){0,2}',
                  '[credential_block_redacted]', text)
    text = re.sub(r'(?i)(passcode|password|암호|비밀번호|인증번호|초대코드)\s*[:：]?\s*\S+', r'\1 [access_value_redacted]', text)
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email_redacted]', text)
    text = re.sub(r'\d(?:[\d\s+()-]{4,}\d)', '[identifier_number_redacted]', text)
    text = re.sub(r'[가-힣]{2,4}(님|씨)', r'[person]\1', text)
    text = re.sub(r'<[가-힣]{2,4}>', '[person]', text)
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--index', type=int, required=True)
    parser.add_argument('--receipt', default='validation-sampling-tranche-receipt-v2.json')
    parser.add_argument('--read-cache', type=Path)
    args = parser.parse_args()
    grant = json.loads((args.directory / 'primary-owner/owner-grant.json').read_text())
    selected = json.loads((args.directory / args.receipt).read_text())['entries']
    identity = selected[args.index]['id']
    packet = client(grant, {'op': 'records', 'ids': [identity], 'include_tokens': True})['cases'][0]
    record = packet['record']
    if record.get('targets'):
        raise ValueError('historical_target_not_hidden')
    print(json.dumps({'case_index': args.index, 'context_message_count': len(record['context']),
                      'historical_targets_count': 0,
                      'self_identity_present': bool(record.get('self_identity')),
                      'room_type_state': safe_text(record.get('room_type_state')),
                      'authorship_present': bool(record.get('authorship'))}, ensure_ascii=False))
    cache = json.loads(args.read_cache.read_text()) if args.read_cache and args.read_cache.exists() else {}
    for index, message in enumerate(record['context']):
        signature = digest({'chat': record['chat'], 'message': message})
        text = '[source already read: ' + cache[signature] + ']' if signature in cache else safe_text(message.get('body'))
        print(json.dumps({'turn': index, 'author_role': message.get('author_role'),
                          'content_kind': message.get('content_kind'),
                          'reply_to_present': bool(message.get('reply_to')),
                          'body_transient_redacted': text}, ensure_ascii=False))
        cache.setdefault(signature, args.receipt + ' case' + str(args.index) + ' turn' + str(index))
    if args.read_cache:
        args.read_cache.write_text(json.dumps(cache, ensure_ascii=False))
        args.read_cache.chmod(0o600)


if __name__ == '__main__':
    main()
