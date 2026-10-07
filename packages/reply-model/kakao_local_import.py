"""Read the owner's Kakao Mac SQLCipher history without touching the app database.

Known key derivation audited against silver-flight-group/kakaocli sources.
Keys and identifiers never enter logs. Only encrypted snapshots touch disk;
message iterators are intended for the daemon's owner-only encrypted ingestion.
"""
import base64
import contextlib
import ctypes
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import time


class LocalKakaoError(ValueError):
    """Only fixed, non-sensitive classification codes are exposed."""


def derive(user_id, uuid):
    hashed = base64.b64encode(hashlib.sha1(uuid.encode()).digest() +
                             hashlib.sha256(uuid.encode()).digest()).decode()
    def pbkdf(password, salt):
        return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(),
                                  100000, 128).hex()
    filename = pbkdf('.'.join(['.', 'F', str(user_id), 'A', 'F', uuid[::-1], '.', '|']),
                     hashed[::-1])[28:106]
    key = pbkdf('F'.join(['A', hashed, '|', 'F', uuid[:5], 'H', str(user_id), '|', uuid[7:]])[::-1],
                uuid[int(len(uuid) * .3):]).encode()
    return filename, key


def owner_identity(home):
    config = json.loads((home / '.inboxd/config.json').read_text())
    providers = [p for p in config['providers'] if p['kind'] == 'kakao_personal']
    identities = {(str(json.loads(p['credentials'])['userId']), p['account']) for p in providers}
    if len(identities) != 1:
        raise LocalKakaoError('ambiguous_owner_account')
    user_id, account = identities.pop()
    marker = hashlib.sha512(user_id.encode()).hexdigest()
    prefdir = home / 'Library/Containers/com.kakao.KakaoTalkMac/Data/Library/Preferences'
    matched = False
    for path in prefdir.glob('com.kakao.KakaoTalkMac*.plist'):
        data = plistlib.loads(path.read_bytes())
        value = data.get('DESIGNATEDFRIENDSREVISION:' + marker)
        matched |= isinstance(value, (int, float)) and value != 0
    if not matched:
        raise LocalKakaoError('active_owner_marker_mismatch')
    result = subprocess.run(['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'],
                            capture_output=True, timeout=10)
    match = re.search(rb'"IOPlatformUUID" = "([^"]+)"', result.stdout)
    if result.returncode or not match:
        raise LocalKakaoError('platform_uuid_unavailable')
    return user_id, account, match.group(1).decode()


def stamp(path):
    try:
        stat = path.stat()
        return (stat.st_ino, stat.st_size, stat.st_mtime_ns)
    except FileNotFoundError:
        return None


def encrypted_snapshot(source, directory):
    """Copy DB/WAL only if both remain stable across the bounded copy."""
    paths = [source, Path(str(source) + '-wal')]
    for _ in range(3):
        before = [stamp(p) for p in paths]
        for path, meta in zip(paths, before):
            target = directory / path.name
            target.unlink(missing_ok=True)
            if meta is not None:
                # Create private before writing; do not preserve source permissions.
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as output, path.open('rb') as input_file:
                    shutil.copyfileobj(input_file, output)
        if before == [stamp(p) for p in paths]:
            return directory / source.name, {'main_bytes': before[0][1],
                                           'wal_bytes': before[1][1] if before[1] else 0}
    raise LocalKakaoError('source_changed_during_snapshot')


class Reader:
    def __init__(self, path, key, compatibility=3):
        self.path = path
        library = ctypes.util.find_library('sqlcipher')
        if not library:
            raise LocalKakaoError('sqlcipher_unavailable')
        self.lib = ctypes.CDLL(library)
        self.db = ctypes.c_void_p()
        declarations = {
            'sqlite3_open_v2': ([ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_void_p], ctypes.c_int),
            'sqlite3_key': ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
            'sqlite3_prepare_v2': ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p], ctypes.c_int),
            'sqlite3_step': ([ctypes.c_void_p], ctypes.c_int),
            'sqlite3_column_count': ([ctypes.c_void_p], ctypes.c_int),
            'sqlite3_column_type': ([ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
            'sqlite3_column_int64': ([ctypes.c_void_p, ctypes.c_int], ctypes.c_longlong),
            'sqlite3_column_double': ([ctypes.c_void_p, ctypes.c_int], ctypes.c_double),
            'sqlite3_column_text': ([ctypes.c_void_p, ctypes.c_int], ctypes.c_void_p),
            'sqlite3_column_bytes': ([ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
            'sqlite3_finalize': ([ctypes.c_void_p], ctypes.c_int),
            'sqlite3_close': ([ctypes.c_void_p], ctypes.c_int),
        }
        for name, (args, restype) in declarations.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, restype
        rc = self.lib.sqlite3_open_v2((path.as_uri() + '?mode=ro').encode(),
                                     ctypes.byref(self.db), 1 | 64, None)
        if rc:
            self.close()
            raise LocalKakaoError('snapshot_open_failed')
        try:
            if self.lib.sqlite3_key(self.db, key, len(key)):
                raise LocalKakaoError('cipher_key_rejected')
            list(self.query(f'PRAGMA cipher_compatibility={compatibility}'))
            list(self.query('PRAGMA query_only=ON'))
            list(self.query('PRAGMA temp_store=MEMORY'))
            list(self.query('SELECT count(*) FROM sqlite_master'))
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.db:
            self.lib.sqlite3_close(self.db)
            self.db = ctypes.c_void_p()

    def query(self, sql):
        statement = ctypes.c_void_p()
        if self.lib.sqlite3_prepare_v2(self.db, sql.encode(), -1, ctypes.byref(statement), None):
            raise LocalKakaoError('local_query_prepare_failed')
        try:
            while True:
                rc = self.lib.sqlite3_step(statement)
                if rc == 101:
                    break
                if rc != 100:
                    raise LocalKakaoError('local_query_read_failed')
                row = []
                for col in range(self.lib.sqlite3_column_count(statement)):
                    kind = self.lib.sqlite3_column_type(statement, col)
                    if kind == 5:
                        value = None
                    elif kind == 1:
                        value = self.lib.sqlite3_column_int64(statement, col)
                    elif kind == 2:
                        value = self.lib.sqlite3_column_double(statement, col)
                    elif kind == 3:
                        ptr = self.lib.sqlite3_column_text(statement, col)
                        value = ctypes.string_at(ptr, self.lib.sqlite3_column_bytes(statement, col)).decode('utf-8')
                    else:
                        raise LocalKakaoError('unexpected_local_blob')
                    row.append(value)
                yield tuple(row)
        finally:
            self.lib.sqlite3_finalize(statement)


@contextlib.contextmanager
def local_reader(home=None):
    home = Path(home or Path.home())
    user_id, account, uuid = owner_identity(home)
    filename, key = derive(user_id, uuid)
    source = home / 'Library/Containers/com.kakao.KakaoTalkMac/Data/Library/Application Support/com.kakao.KakaoTalkMac' / filename
    if not source.is_file():
        raise LocalKakaoError('derived_database_missing')
    # Encrypted files only; TemporaryDirectory is 0700 and removed on all paths.
    with tempfile.TemporaryDirectory(prefix='inboxd-kakao-encrypted-') as temporary:
        path, sizes = encrypted_snapshot(source, Path(temporary))
        reader = Reader(path, key)
        try:
            yield reader, user_id, account, sizes
        finally:
            reader.close()


def metadata(reader, user_id):
    """Only schema, counts and date bounds; no message/identity values."""
    tables = [r[0] for r in reader.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    result = {'schema': 'local-kakao-history-metadata/v1', 'table_names': tables}
    for table in ('NTChatMessage', 'NTChatRoom', 'NTChatContext'):
        result[table + '_columns'] = [r[1] for r in reader.query(f'PRAGMA table_info({table})')]
    result['integrity'] = next(reader.query('PRAGMA quick_check'))[0]
    result['message_summary'] = next(reader.query(
        'SELECT count(*), count(DISTINCT chatId), min(sentAt), max(sentAt), '
        f'sum(authorId={int(user_id)}), sum(type=1), sum(length(message)>0) FROM NTChatMessage'))
    result['room_count'] = next(reader.query('SELECT count(*) FROM NTChatRoom'))[0]
    result['self_context_matches'] = next(reader.query(f'SELECT count(*) FROM NTChatContext WHERE userId={int(user_id)}'))[0]
    result['message_type_counts'] = list(reader.query('SELECT type,count(*) FROM NTChatMessage GROUP BY type ORDER BY type'))
    return result


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def snapshot_hash(reader_path):
    digest = hashlib.sha256()
    for suffix in ('', '-wal'):
        path = Path(str(reader_path) + suffix)
        digest.update(suffix.encode() + b'\0')
        if path.exists():
            with path.open('rb') as source:
                while block := source.read(1024 * 1024):
                    digest.update(block)
    return digest.hexdigest()


def observations(reader):
    columns = [r[1] for r in reader.query('PRAGMA table_info(NTChatMessage)')]
    if any(not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', col) for col in columns):
        raise LocalKakaoError('unsupported_local_schema')
    room_metadata = {str(room): {'native_type': kind, 'active_member_count': count}
                     for room, kind, count in reader.query('SELECT chatId,type,activeMembersCount FROM NTChatRoom')}
    # Full original record preserved; raw JSON strings must not be interpreted as
    # human text. Source IDs are logId, never SQLite rowid or local msgId.
    for values in reader.query('SELECT ' + ','.join(columns) + ' FROM NTChatMessage ORDER BY chatId,sentAt,logId'):
        raw = dict(zip(columns, values))
        observation = {'id': str(raw['logId']), 'chat_id': str(raw['chatId']),
                       'author_id': str(raw['authorId']), 'ts': raw['sentAt'],
                       'body': raw['message'] or '', 'type': raw['type'],
                       'archive_metadata': {**raw, 'room_metadata': room_metadata.get(str(raw['chatId']))}}
        attachment = raw.get('attachment')
        if attachment:
            try:
                parent = json.loads(attachment).get('src_logId')
                if isinstance(parent, int) and parent > 0:
                    observation['parent_id'] = str(parent)
            except (ValueError, AttributeError):
                pass
        yield observation


def pages(rows, account, user_id, source, *, max_records=100, max_frame_bytes=48 * 1024):
    """Yield deterministic, room-scoped pages; never truncate an oversized row."""
    pending = []
    room = None
    def envelope(messages, chat_id):
        # Page digest includes exact source records; IDs exposed only over UDS.
        page_id = hashlib.sha256(encoded({'source': source['snapshot_sha256'],
                                          'room': chat_id, 'messages': messages})).hexdigest()
        return {'reader': 'local_archive',
                'chat': {'platform': 'kakao', 'account': account, 'chat_id': chat_id},
                'interval': {'from_ts': 0, 'to_ts': 9007199254740991},
                'self_user_id': str(user_id), 'source': source, 'page_id': page_id,
                'messages': messages}
    def fits(messages, chat_id):
        params = envelope(messages, chat_id)
        return len(encoded({'type': 'request', 'id': '999999999',
                            'method': 'sync.backfill', 'params': params})) + 1 <= max_frame_bytes
    for row in rows:
        current = row['chat_id']
        if pending and (current != room or len(pending) >= max_records or not fits(pending + [row], current)):
            yield envelope(pending, room)
            pending = []
        room = current
        if not fits([row], room):
            raise LocalKakaoError('single_record_exceeds_ipc_budget')
        pending.append(row)
    if pending:
        yield envelope(pending, room)


class OwnerRpc:
    """Memory-only JSON-lines client; no CLI arguments or body/token logging."""
    def __init__(self, home=None, *, timeout=90):
        if type(timeout) not in (int, float) or not 0 < timeout <= 90:
            raise LocalKakaoError('invalid_owner_rpc_timeout')
        home = Path(home or Path.home())
        config = json.loads((home / '.inboxd/config.json').read_text())
        socket_path = Path(config['socket_path']).expanduser()
        info = socket_path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise LocalKakaoError('untrusted_daemon_socket')
        token_path = socket_path.parent / 'approver.token'
        fd = os.open(token_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o600 or info.st_size > 4096:
                raise LocalKakaoError('untrusted_owner_token')
            token = os.read(fd, 4096).decode().strip()
        finally:
            os.close(fd)
        if not re.fullmatch('[A-Za-z0-9_-]{32,4096}', token):
            raise LocalKakaoError('invalid_owner_token')
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connection.settimeout(timeout)
        self.connection.connect(str(socket_path))
        self.stream = self.connection.makefile('rb')
        self.counter = 0
        self.request('system.hello', {'role': 'sender', 'sender_token': token})

    def close(self):
        self.stream.close()
        self.connection.close()

    def request(self, method, params):
        self.counter += 1
        request_id = str(self.counter)
        frame = encoded({'type': 'request', 'id': request_id, 'method': method, 'params': params}) + b'\n'
        if len(frame) > 48 * 1024:
            raise LocalKakaoError('request_exceeds_ipc_budget')
        self.connection.sendall(frame)
        while True:
            line = self.stream.readline(16 * 1024 * 1024 + 1)
            if not line or len(line) > 16 * 1024 * 1024:
                raise LocalKakaoError('daemon_response_invalid')
            value = json.loads(line)
            if value.get('id') != request_id:
                continue
            if 'error' in value:
                # RPC messages may contain private data: classify without echoing.
                if value['error'].get('code') == 'RESPONSE_TOO_LARGE':
                    raise LocalKakaoError('daemon_response_too_large')
                raise LocalKakaoError('daemon_request_rejected')
            return value['result']


def compare_overlap(reader, account, rpc, *, maximum_rooms=30):
    """Compare actual existing canonical IDs and values, returning aggregates."""
    counts = {'rooms_checked': 0, 'canonical_messages_checked': 0,
              'id_overlap': 0, 'exact_matches': 0, 'mismatches': 0,
              'field_mismatches': {field: 0 for field in ('chat_id', 'author_id', 'ts', 'body')},
              'timestamp_delta_counts': {}}
    rooms = [r[0] for r in reader.query('SELECT chatId FROM NTChatMessage GROUP BY chatId ORDER BY max(sentAt) DESC')]
    for room in rooms[:maximum_rooms]:
        counts['rooms_checked'] += 1
        def canonical_rows():
            params = {'chat': {'platform': 'kakao', 'account': account, 'chat_id': str(room)},
                      'interval': {'from_ts': 0, 'to_ts': 9007199254740991}, 'limit': 5}
            seen = set()
            while True:
                result = rpc.request('message.inbox', params)
                yield from result.get('messages', [])
                cursor = result.get('next_cursor')
                if cursor is None:
                    break
                if cursor in seen:
                    raise LocalKakaoError('canonical_cursor_repeated')
                seen.add(cursor)
                params['cursor'] = cursor
        for existing in canonical_rows():
            counts['canonical_messages_checked'] += 1
            key = existing.get('key', existing)
            msg_id = key['msg_id']
            if not re.fullmatch('[0-9]+', msg_id):
                continue
            local = next(reader.query(f'SELECT chatId,authorId,sentAt,message FROM NTChatMessage WHERE chatId={int(room)} AND logId={int(msg_id)}'), None)
            if local is None:
                continue
            counts['id_overlap'] += 1
            expected = (str(local[0]), str(local[1]), local[2], local[3])
            actual = (key['chat_id'], existing.get('author_id'), existing.get('ts'), existing.get('body'))
            differences = [i for i, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1]]
            for i in differences:
                counts['field_mismatches'][('chat_id', 'author_id', 'ts', 'body')[i]] += 1
                if i == 2:
                    delta = str(actual[2] - expected[2])
                    counts['timestamp_delta_counts'][delta] = counts['timestamp_delta_counts'].get(delta, 0) + 1
            counts['mismatches' if differences else 'exact_matches'] += 1
    return counts


def save_metadata(path, value):
    """Atomic, owner-only checkpoint containing counts/hashes only."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def message_digest(message):
    return hashlib.sha256(json.dumps(message, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def baseline_hashes(reader, account, rpc):
    """Owner-only identifiers+hashes; bodies never persist in baseline artifacts."""
    result = {'schema': 'kakao-canonical-baseline-hashes/v1', 'messages': {},
              'captured_at': time.time()}
    for (room,) in reader.query('SELECT chatId FROM NTChatMessage GROUP BY chatId'):
        params = {'chat': {'platform': 'kakao', 'account': account, 'chat_id': str(room)},
                  'interval': {'from_ts': 0, 'to_ts': 9007199254740991}, 'limit': 5}
        cursors = set()
        while True:
            page = rpc.request('message.inbox', params)
            for message in page.get('messages', []):
                key = message.get('key', message)
                identity = json.dumps([key['chat_id'], key['msg_id']], separators=(',', ':'))
                result['messages'][identity] = message_digest(message)
            cursor = page.get('next_cursor')
            if cursor is None:
                break
            if cursor in cursors:
                raise LocalKakaoError('baseline_cursor_repeated')
            cursors.add(cursor)
            params['cursor'] = cursor
    return result


def verify_baseline(baseline, account, rpc):
    result = {'baseline_records': len(baseline['messages']), 'unchanged': 0,
              'changed': 0, 'missing': 0}
    for identity, digest in baseline['messages'].items():
        room, message_id = json.loads(identity)
        message = rpc.request('message.get', {'chat': {'platform': 'kakao', 'account': account,
                                                       'chat_id': room}, 'msg_id': message_id})['message']
        if message is None:
            result['missing'] += 1
        elif message_digest(message) == digest:
            result['unchanged'] += 1
        else:
            result['changed'] += 1
    return result


def import_local(checkpoint_path, *, progress=None):
    """Stream every source record to atomic encrypted owner ingestion.

    The daemon's page ledger handles unknown outcomes and replays. Progress and
    checkpoint data contain only hashes/counts; no message or credential values.
    """
    started = time.time()
    with local_reader() as (reader, user_id, account, sizes):
        summary = metadata(reader, user_id)
        if summary['integrity'] != 'ok' or summary['self_context_matches'] != 1:
            raise LocalKakaoError('snapshot_validation_failed')
        app_info = plistlib.loads(Path('/Applications/KakaoTalk.app/Contents/Info.plist').read_bytes())
        source = {'snapshot_sha256': snapshot_hash(reader.path),
                  'schema': 'kakao-mac-sqlcipher-v1',
                  'app_version': app_info['CFBundleShortVersionString'],
                  'app_build': app_info['CFBundleVersion'], 'compatibility': 3,
                  'snapshot_integrity': 'ok', 'snapshot_encrypted_sizes': sizes,
                  'record_count': summary['message_summary'][0],
                  'room_count': summary['message_summary'][1],
                  'from_ts': summary['message_summary'][2],
                  'to_ts': summary['message_summary'][3],
                  'timestamp_policy': 'preserve_existing_canonical; raw_local_sentAt_retained',
                  'native_delete_flag': 16384,
                  'schema_sha256': hashlib.sha256(encoded(list(reader.query(
                      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name")))).hexdigest(),
                  'room_classification_policy': 'native_type_retained_without_inference'}
        report = {'schema': 'kakao-local-import-progress/v1', 'source': source,
                  'state': 'running', 'pages_committed': 0, 'records_submitted': 0,
                  'started_at': started, 'last_commit_at': None,
                  'canonical_committed': 0, 'already_present': 0,
                  'raw_committed': 0,
                  'replayed_pages': 0, 'committed_page_ids': []}
        save_metadata(checkpoint_path, report)
        rpc = OwnerRpc()
        try:
            for page in pages(observations(reader), account, user_id, source):
                response = rpc.request('sync.backfill', page)
                if (response.get('reader') != 'local_archive' or
                        response.get('page_id') != page['page_id'] or
                        response.get('event_count') != len(page['messages'])):
                    raise LocalKakaoError('archive_ack_invalid')
                report['pages_committed'] += 1
                report['records_submitted'] += len(page['messages'])
                report['raw_committed'] += response['event_count']
                report['last_commit_at'] = time.time()
                report['committed_page_ids'].append(page['page_id'])
                if response.get('replayed') is True:
                    report['replayed_pages'] += 1
                inserted, stored = response.get('inserted'), response.get('stored')
                if type(inserted) is int and type(stored) is int and 0 <= inserted <= stored:
                    report['canonical_committed'] += inserted
                    report['already_present'] += stored - inserted
                save_metadata(checkpoint_path, report)
                if progress and report['pages_committed'] % 100 == 0:
                    progress({k: report[k] for k in ('pages_committed', 'records_submitted')})
            if report['records_submitted'] != source['record_count']:
                raise LocalKakaoError('source_count_not_fully_submitted')
            audit = rpc.request('sync.backfill', {
                'reader': 'local_archive', 'status_only': True,
                'chat': {'platform': 'kakao', 'account': account,
                         'chat_id': str(next(reader.query('SELECT chatId FROM NTChatMessage LIMIT 1'))[0])},
                'self_user_id': str(user_id), 'source': source})
            report['encrypted_ledger_audit'] = audit
            if (audit.get('raw_records') != source['record_count'] or
                    audit.get('rooms') != source['room_count'] or
                    audit.get('acknowledged_events') != source['record_count']):
                raise LocalKakaoError('encrypted_ledger_count_mismatch')
            report['state'] = 'complete'
        except BaseException:
            report['state'] = 'interrupted_or_rejected'
            save_metadata(checkpoint_path, report)
            raise
        finally:
            rpc.close()
        save_metadata(checkpoint_path, report)
        return {k: v for k, v in report.items() if k != 'committed_page_ids'}
