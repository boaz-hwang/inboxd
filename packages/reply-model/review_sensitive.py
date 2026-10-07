"""Owner-memory credential screening. Evidence artifacts contain source keys only.

This conservative pattern screen supplements individual semantic inspection; it
does not claim that every secret, sensitive value, or private resource is found.
"""
import json
import re
import socket
from urllib.parse import unquote

import history


_PATTERNS = {
    'explicit_password_value': re.compile(r'(?:(?:비밀번호|비번|암호)(?:는|가|은|이)?\s*[:=]?|(?:password|passwd|pwd|pw)\s+is)\s+([A-Za-z0-9!@#$%^&*()._+=/?-]{4,})',re.I),
    'reverse_labeled_credential_value': re.compile(r'([^\s<>{}|]{4,})\s*[(（]\s*(?:비밀번호|비번|암호|password|passwd|pwd)\s*[)）]',re.I),
    'password_assignment': re.compile(r'(?:비밀번호|비번|암호|password|passwd|pwd|pw)\s*[:=]\s*[`\"\']?([^\s<>{}|]{4,})',re.I),
    'password_url_parameter': re.compile(r'[?&](?:pwd|password|passcode)=([A-Za-z0-9%._~+/-]{4,})',re.I),
    'access_key_url_parameter': re.compile(r'[?&](?:access[_-]?key|access[_-]?token|refresh[_-]?token|api[_-]?key|auth[_-]?(?:key|token)|signature|x-amz-signature|client_secret)=([A-Za-z0-9%._~+/-]{8,})',re.I),
    'opaque_token_url_parameter': re.compile(r'[?&](?:token|auth|access)=([A-Za-z0-9%._~+/-]{16,})',re.I),
    'meeting_pin_url_parameter': re.compile(r'[?&](?:pin|pincode)=([A-Za-z0-9%._~+-]{4,})',re.I),
    'explicit_meeting_pin': re.compile(r'(?:\bPIN|\bpasscode|\baccess code|입장코드|접속코드|참가코드|입장번호|핀번호)\s*[:：=]\s*([0-9][0-9 -]{2,}[0-9]#?)',re.I),
    'passcode_assignment': re.compile(r'(?:\bpasscode|\baccess code|입장암호|접속암호)\s*[:：=]\s*[`\"\']?([^\s<>{}|]{4,})',re.I),
    'bearer_token_value': re.compile(r'\bBearer\s+([A-Za-z0-9._~+/=-]{16,})',re.I),
    'provider_api_credential': re.compile(r'\b(?:xox[baprs]-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b'),
    'private_key_material': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'explicit_one_time_code': re.compile(r'(?:인증번호|인증코드|verification code|otp)\s*[:=]\s*\d{4,8}\b',re.I),
}
_PLACEHOLDERS = {'password','passwd','your_password','example','example_password','redacted','xxxx','xxxxxx','changeme','change_me',
                 'reset','required','policy','변경하세요','확인필요','직접설정','문의하세요'}


def credential_values(text):
    """For owner-memory propagation only. Never log or persist this return value."""
    values=set()
    if isinstance(text,str):
        for pattern in _PATTERNS.values():
            for match in pattern.finditer(text):
                if match.lastindex:
                    value=unquote(match.group(1)).strip('`\"\'<>[]{}')
                    if value.lower() not in _PLACEHOLDERS:
                        values.add(value)
    return values


def credential_rules(text):
    if not isinstance(text,str):
        return []
    found=[]
    for name, pattern in _PATTERNS.items():
        for match in pattern.finditer(text):
            value=match.group(1) if match.lastindex else None
            if value is None or unquote(value).strip('<>[]{}').lower() not in _PLACEHOLDERS:
                found.append(name)
                break
    return sorted(found)


def sensitive_source_evidence(cases, *, known_values=()):
    evidence={}
    for case in cases:
        for message in (*case.get('context',[]),*case.get('targets',[])):
            rules=credential_rules(message.get('body'))
            if isinstance(message.get('body'),str) and any(value in message['body'] for value in known_values):
                rules=sorted(set(rules)|{'repeated_known_credential_value'})
            if rules:
                key=history.source_key(case['chat'],message['message_id'])
                evidence.setdefault(key,set()).update(rules)
    return {key:sorted(rules) for key,rules in sorted(evidence.items())}


def quarantine_overlaps(record, source_keys):
    available=set(record.get('source_message_keys') or [])
    available.update(history.source_key(record['chat'],message['message_id'])
                     for message in (*record.get('context',[]),*record.get('targets',[])))
    return sorted(available & set(source_keys))


def sensitive_admission_report(records, quarantine):
    """Reproducible final admission gate. Never mask or mutate an approved row."""
    if quarantine.get('quarantine_hash') != history.digest({key:value for key,value in quarantine.items()
                                                           if key!='quarantine_hash'}):
        raise ValueError('sensitive_quarantine_hash_mismatch')
    keys=quarantine['source_keys']
    if len(set(keys))!=len(keys) or any(history.canonical_key(key)!=key for key in keys):
        raise ValueError('invalid_sensitive_quarantine_source_keys')
    kept,excluded=[],[]
    for record in records:
        affected=sorted(set(quarantine_overlaps(record,keys)) | set(sensitive_source_evidence([record])))
        message_rules=sorted({rule for message in record.get('messages',[])
                              for rule in credential_rules(message.get('content'))})
        if affected or message_rules:
            excluded.append({'id':record['id'],'review_hash':record.get('review_hash'),
                'reason':'sensitive_credential_context','source_keys':affected,'message_rules':message_rules})
        else:
            kept.append(record)
    return kept,excluded


def assert_no_sensitive_sources(records, quarantine):
    _,excluded=sensitive_admission_report(records,quarantine)
    if excluded:
        raise ValueError('sensitive_source_in_admitted_record')


def original_packet(grant, request):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(grant['socket_path'])
        client.sendall(json.dumps(request,separators=(',',':')).encode()+b'\n')
        data=client.makefile('rb').readline(524289)
    if len(data)>524288:
        raise ValueError('screening_backend_packet_over_budget')
    response=json.loads(data)
    if response.get('split')!=grant['split'] or response.get('snapshot_hash')!=grant['snapshot_hash']:
        raise ValueError('screening_backend_scope_changed')
    if [(case.get('id'),case.get('review_hash')) for case in response.get('cases',[])] != [(entry['id'],entry['hash']) for entry in request['entries']]:
        raise ValueError('screening_backend_records_changed')
    return response


class SensitiveReviewProxy:
    """One exact prior grant only; no SQL, paths, body edits, or wider access."""
    def __init__(self, grant, quarantine_path):
        if grant.get('grant_hash')!=history.digest({key:value for key,value in grant.items() if key!='grant_hash'}):
            raise ValueError('screening_prior_grant_changed')
        self.grant=grant
        self.quarantine_path=quarantine_path
        self.entries={entry['id']:entry['hash'] for entry in grant['entries']}
        self.audit=[]

    def packet(self,request):
        if not isinstance(request,dict) or set(request)!={'shard_index','shard_hash','entries'}:
            raise ValueError('invalid_screened_review_request')
        if request['shard_index']!=self.grant['shard_index'] or request['shard_hash']!=self.grant['shard_hash']:
            raise ValueError('screened_review_scope_changed')
        entries=request['entries']
        if not isinstance(entries,list) or not 1<=len(entries)<=10 or any(not isinstance(entry,dict) for entry in entries):
            raise ValueError('invalid_screened_review_batch')
        if len({entry.get('id') for entry in entries})!=len(entries):
            raise ValueError('invalid_screened_review_batch')
        if any(not isinstance(entry,dict) or set(entry)!={'id','hash'} or self.entries.get(entry['id'])!=entry['hash'] for entry in entries):
            raise ValueError('ungranted_screened_review_entry')
        response=original_packet(self.grant,request)
        quarantine=json.loads(self.quarantine_path.read_text())
        if quarantine.get('quarantine_hash')!=history.digest({key:value for key,value in quarantine.items() if key!='quarantine_hash'}):
            raise ValueError('screening_quarantine_hash_changed')
        keys=quarantine['source_keys']
        replacements=[]
        for case in response['cases']:
            overlap=quarantine_overlaps(case,keys)
            detected=sensitive_source_evidence([case])
            affected=sorted(set(overlap)|set(detected))
            if affected:
                replacements.append({'id':case['id'],'review_hash':case['review_hash'],
                    'split':self.grant['split'],'exclusion_kind':'metadata_only_sensitive_credential_context',
                    'approvable':False,'quarantine_source_keys':affected,'rationale_codes':['sensitive_credential_context'],
                    'original_packet_case_hash':history.digest(case)})
            else:
                replacements.append(case)
        response={**response,'cases':replacements,'screening':'source_keys_and_actual_value_patterns',
                  'quarantine_hash':quarantine['quarantine_hash'],
                  'originals_unchanged':True,'credential_detection_not_exhaustive':True}
        encoded=json.dumps(response,ensure_ascii=False,separators=(',',':')).encode()+b'\n'
        if len(encoded)>524288:
            raise ValueError('screened_review_packet_over_budget')
        self.audit.append({'case_count':len(entries),'metadata_only_exclusions':sum(case.get('approvable') is False for case in replacements),
                           'packet_hash':history.digest(response),'response_bytes':len(encoded)})
        return encoded

    def clear(self):
        self.entries.clear()
