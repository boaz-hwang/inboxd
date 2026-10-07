#!/usr/bin/env python3
"""Plan and resume bounded owner-local history reads without sending messages.

Plans and results contain only room identifiers, intervals, counts and states.
The daemon owns provider cursors and durable coverage; terminal != full coverage.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

DEFAULT_ROOT = Path.home() / '.inboxd/reply-model/learning/collection'


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def cli(command, group, action, payload=None, *, owner=False):
    # The local CLI authenticates trajectory and backfill with the owner token.
    # Interactive approver mode requires a TTY and is not used by this runner.
    if owner and (group, action) != ('sync', 'backfill'):
        raise ValueError('owner_command_not_supported')
    args = [str(command), group, action]
    if payload is not None:
        args.append(json.dumps(payload, separators=(',', ':')))
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        raise ValueError('request_outcome_unknown') from None
    if result.returncode:
        # Provider errors can contain bodies or credentials. Persist classifications only.
        error = result.stderr.lower()
        code = next((reason for marker, reason in (
            ('max_pages', 'provider_page_budget'), ('cursor_unsupported', 'cursor_unsupported'),
            ('rate', 'rate_limit'), ('요청 제한','rate_limit'), ('unavailable', 'unavailable'), ('permission', 'permission'),
            ('cursor', 'account_cursor_expired'))
            if marker in error), 'request_failed')
        raise ValueError(code)
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError('invalid_response')
    return value


def inventory(request, platforms):
    rooms = []
    for platform in platforms:
        cursor, seen = None, set()
        while True:
            query = {'history_inventory': True, 'platform': platform, 'limit': 50}
            if cursor:
                query['cursor'] = cursor
            page = request('trajectory', 'list', query)
            if not isinstance(page.get('rooms'), list):
                raise ValueError('inventory_unavailable')
            rooms.extend(page['rooms'])
            cursor = page.get('next_cursor')
            if cursor is None:
                break
            if cursor in seen:
                raise ValueError('inventory_cursor_repeated')
            seen.add(cursor)
    return rooms


def make_plan(rooms, *, from_ts, to_ts, max_rooms=1, pages_per_room=1, chat_ids=()):
    if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (from_ts, to_ts)) or from_ts >= to_ts:
        raise ValueError('invalid_interval')
    if max_rooms < 1 or not 1 <= pages_per_room <= 100:
        raise ValueError('invalid_budget')
    unique = {identity(r['chat']): r for r in rooms if not chat_ids or r['chat']['chat_id'] in chat_ids}
    ordered = sorted(unique.values(), key=lambda r: (-r.get('self_message_count', 0), identity(r['chat'])))
    selected, per_platform = [], {}
    for row in ordered:
        platform = row['chat']['platform']
        if per_platform.get(platform, 0) >= max_rooms:
            continue
        selected.append({'chat': row['chat'], 'interval': {'from_ts': from_ts, 'to_ts': to_ts},
                         'page_budget': pages_per_room})
        per_platform[platform] = per_platform.get(platform, 0) + 1
    spec = {'version': 1, 'rooms': selected}
    return {'plan_id': identity(spec), 'spec': spec, 'created_at': time.time(), 'results': {}}


def running_jobs(status, chat, operation='sync.backfill'):
    return [j for j in status.get('work', {}).get('jobs', [])
            if j.get('operation') == operation and j.get('state') == 'running'
            and (not j.get('scope') or all(j['scope'].get(k) == v for k, v in chat.items()))]


def metadata_progress(value):
    if (not isinstance(value, dict) or value.get('status') not in
            ('unstarted', 'pending', 'complete', 'budget_exhausted')
            or type(value.get('committed_pages')) is not int or value['committed_pages'] < 0):
        raise ValueError('daemon_progress_unavailable')
    result = {key: value[key] for key in ('status', 'committed_pages')}
    if type(value.get('terminal')) is bool:
        result['terminal'] = value['terminal']
    if type(value.get('max_pages')) is int and value['max_pages'] >= 0:
        result['max_pages'] = value['max_pages']
    return result


def account_read_scope(chat):
    if chat['platform'] != 'telegram':
        raise ValueError('unsupported_account_history')
    raw = chat['chat_id'].removeprefix('telegram:chat:')
    if not raw.lstrip('-').isdigit():
        raise ValueError('invalid_account_chat')
    return {**chat, 'chat_id': raw}


def account_page(item, result, request, save, plan):
    """Bounded connected-account fallback; it never creates coverage evidence.

    The daemon cursor can contain an unconsumed buffered page. If it expires,
    restart at the head and deduplicate, rather than skipping that buffer by
    guessing a provider anchor. Every attempted page consumes the fixed budget.
    """
    params = {**account_read_scope(item['chat']), 'limit': 30}
    cursor = result.get('account_cursor')
    if cursor and time.time() - result.get('cursor_saved_at', 0) < 100:
        params['cursor'] = cursor
    elif cursor:
        cursor = None
        result.pop('account_cursor', None)
        result['cursor_restarts'] = result.get('cursor_restarts', 0) + 1
    result['account_requests'] = result.get('account_requests', 0) + 1
    result.update(state='requesting', coverage_state='unknown')
    save(plan)
    started = time.monotonic()
    page = request('account', 'messages', params)
    messages = page.get('messages')
    if not isinstance(messages, list) or any(not isinstance(m, dict) or not isinstance(m.get('id'), str)
            or type(m.get('ts')) not in (int, float) or not math.isfinite(m['ts']) for m in messages):
        raise ValueError('invalid_account_page')
    seen = set(result.get('seen_message_ids', []))
    fresh = []
    for message in messages:
        if message['id'] not in seen:
            fresh.append(message)
            seen.add(message['id'])
    result['seen_message_ids'] = sorted(seen | {m['id'] for m in messages})
    result['pages_read'] += 1
    result['event_count'] = result.get('event_count', 0) + len(fresh)
    in_range = sum(item['interval']['from_ts'] <= m['ts'] <= item['interval']['to_ts'] for m in fresh)
    result['in_range_count'] = result.get('in_range_count', 0) + in_range
    result['out_of_range_count'] = result.get('out_of_range_count', 0) + len(fresh) - in_range
    result['last_duration_seconds'] = round(time.monotonic() - started, 3)
    result.pop('reason', None)
    if messages:
        times = [m['ts'] for m in messages]
        result['earliest_observed_ts'] = min(result.get('earliest_observed_ts', min(times)), min(times))
        result['latest_observed_ts'] = max(result.get('latest_observed_ts', max(times)), max(times))
    next_cursor = page.get('next_cursor')
    if next_cursor is not None and (not isinstance(next_cursor, str) or next_cursor == cursor):
        raise ValueError('account_cursor_not_progressing')
    if page.get('complete') is True:
        result['state'] = 'complete'
    elif result.get('earliest_observed_ts', math.inf) <= item['interval']['from_ts']:
        result['state'] = 'range_reached'
    elif not next_cursor:
        result.update(state='unsupported', reason='account_cursor_unavailable')
    elif result['account_requests'] >= item['page_budget']:
        result['state'] = 'local_budget'
    else:
        result['state'] = 'pending'
    result['account_cursor'] = next_cursor
    result['cursor_saved_at'] = time.time()
    save(plan)


def execute(plan, request, save, *, max_requests=1):
    if plan.get('plan_id') != identity(plan.get('spec')):
        raise ValueError('collection_plan_changed')
    if max_requests < 1:
        raise ValueError('invalid_request_budget')
    used = 0
    for item in plan['spec']['rooms']:
        key = identity(item)
        result = plan['results'].setdefault(key, {'state': 'pending', 'pages_read': 0, 'coverage_state': 'unknown'})
        if result['state'] in ('complete', 'range_reached', 'local_budget', 'provider_budget', 'unsupported'):
            continue
        while used < max_requests:
            try:
                account_route = result.get('reader') == 'account_messages'
                scope = account_read_scope(item['chat']) if account_route else item['chat']
                jobs = running_jobs(request('sync', 'status', None), scope,
                                    'account.messages' if account_route else 'sync.backfill')
                if jobs:
                    result.update(state='waiting', job_ids=[j['id'] for j in jobs])
                    save(plan)
                    break
                result.pop('job_ids', None)
                if account_route:
                    if result.get('account_requests', 0) >= item['page_budget']:
                        result['state'] = 'local_budget'
                        save(plan)
                        break
                    used += 1
                    account_page(item, result, request, save, plan)
                    if result['state'] != 'pending':
                        break
                    continue
                params = {'chat': item['chat'], 'interval': item['interval']}
                snapshot = request('sync', 'backfill', {**params, 'status_only': True}, owner=True)
                progress = metadata_progress(snapshot.get('progress'))
                result.pop('reason', None)
                result.setdefault('initial_committed_pages', progress['committed_pages'])
                result['pages_read'] = max(result['pages_read'], progress['committed_pages'] - result['initial_committed_pages'])
                result['progress'] = progress
                result.pop('job_ids', None)
                if progress['status'] == 'complete':
                    result['state'] = 'complete'
                    save(plan)
                    break
                if progress['status'] == 'budget_exhausted':
                    result['state'] = 'provider_budget'
                    save(plan)
                    break
                if max(result['pages_read'], result.get('backfill_requests', 0)) >= item['page_budget']:
                    result['state'] = 'local_budget'
                    save(plan)
                    break
                # Save before provider I/O; resume consults actual daemon work/checkpoint.
                result['state'] = 'requesting'
                result['backfill_requests'] = result.get('backfill_requests', 0) + 1
                save(plan)
                started = time.monotonic()
                used += 1
                page = request('sync', 'backfill', {**params, 'resume': True}, owner=True)
                progress = metadata_progress(page.get('progress'))
                result.update(progress=progress, state='pending',
                              last_duration_seconds=round(time.monotonic() - started, 3))
                result['pages_read'] = max(result['pages_read'], progress['committed_pages'] - result['initial_committed_pages'])
                result['event_count'] = result.get('event_count', 0) + page.get('event_count', 0)
                if progress['status'] == 'complete':
                    result['state'] = 'complete'
                elif progress['status'] == 'budget_exhausted':
                    result['state'] = 'provider_budget'
                elif max(result['pages_read'], result.get('backfill_requests', 0)) >= item['page_budget']:
                    result['state'] = 'local_budget'
                save(plan)
                if result['state'] != 'pending':
                    break
            except (ValueError, OSError, json.JSONDecodeError) as error:
                reason = str(error) if isinstance(error, ValueError) else type(error).__name__
                if reason == 'unavailable' and item['chat']['platform'] == 'telegram' and not account_route:
                    result.update(reader='account_messages', state='pending', coverage_state='unknown',
                                  fallback_reason='no_capability_history_adapter')
                    result.pop('reason', None)
                    save(plan)
                    continue
                if account_route and reason == 'account_cursor_expired':
                    result.pop('account_cursor', None)
                    result['cursor_restarts'] = result.get('cursor_restarts', 0) + 1
                safe = reason if reason in ('request_outcome_unknown', 'provider_page_budget', 'cursor_unsupported',
                    'rate_limit', 'unavailable', 'permission', 'request_failed', 'daemon_progress_unavailable',
                    'account_cursor_expired') else 'response_failed'
                result.update(state='unsupported' if safe in ('cursor_unsupported', 'unavailable', 'permission') else 'uncertain', reason=safe)
                save(plan)
                break
        if used >= max_requests:
            break
    return {'plan_id': plan['plan_id'], 'requests_this_run': used, 'rooms': [
        {**item, **{k:v for k,v in plan['results'].get(identity(item), {'state': 'pending'}).items()
                   if k not in ('seen_message_ids', 'account_cursor')}} for item in plan['spec']['rooms']]}


def connected_inventory(request, platforms):
    """Freeze one provider directory snapshot, including empty local rooms."""
    rooms, errors, cursor, seen = [], [], None, set()
    while True:
        query = {'cursor':cursor} if cursor else {'refresh':True}
        page = request('account','list',query)
        rows = page.get('chats')
        if not isinstance(rows,list):raise ValueError('inventory_unavailable')
        rooms.extend({'chat':{k:row[k] for k in ('platform','account','chat_id')}}
                     for row in rows if row.get('platform') in platforms)
        errors.extend({**{k:e[k] for k in ('platform','account') if k in e},'reason':'account_directory_failed'}
                      for e in page.get('errors',[]) if e.get('platform') in platforms)
        if page.get('refreshing') is True:errors.append({'reason':'directory_refresh_in_progress'})
        cursor=page.get('next_cursor')
        if cursor is None:break
        if cursor in seen:raise ValueError('inventory_cursor_repeated')
        seen.add(cursor)
    # Local counts influence order; they never replace provider room discovery.
    try:
        metadata={identity(r['chat']):r for r in inventory(request,platforms)}
    except (ValueError,OSError,json.JSONDecodeError):metadata={}
    for room in rooms:
        room['self_message_count']=metadata.get(identity(room['chat']),{}).get('self_message_count',0)
    return rooms,list({identity(e):e for e in errors}.values())


def make_full_plan(rooms, errors=()):
    unique = {identity(r['chat']): r for r in rooms}
    spec = {'version':2, 'mode':'full_server_accessible', 'rooms':[
        {'chat': unique[key]['chat'], 'interval':{'from_ts':0,'to_ts':9007199254740991}}
        for key in sorted(unique,key=lambda key:(('kakao','telegram','slack').index(unique[key]['chat']['platform']),-unique[key].get('self_message_count',0),unique[key]['chat']['account'],unique[key]['chat']['chat_id']))]}
    return {'plan_id':identity(spec), 'spec':spec, 'created_at':time.time(), 'results':{},
            'inventory_errors':list(errors),'inventory_complete':not bool(errors),
            'snapshot_frozen_at':time.time()}


def full_summary(plan, used=0):
    return {'plan_id':plan['plan_id'], 'requests_this_run':used,
            'scope':'all_current_connected_rooms_server_accessible_history',
            'coverage_state':'unknown', 'inventory_errors':plan.get('inventory_errors',[]),
            'inventory_complete':plan.get('inventory_complete',False), 'snapshot_frozen_at':plan.get('snapshot_frozen_at'),
            'rooms':[{**item, **plan['results'].get(identity(item), {'state':'pending'})}
                     for item in plan['spec']['rooms']]}


def execute_full(plan, request, save, *, max_requests=100, now=time.time):
    """Continue bounded invocations until source terminal; no lifetime page cap.

    A timeout may have committed a page. Consult the durable daemon checkpoint
    before any retry. Errors/backoff are metadata; responses never contain bodies.
    """
    if plan.get('plan_id') != identity(plan.get('spec')) or plan['spec'].get('version') != 2:
        raise ValueError('collection_plan_changed')
    if max_requests < 1: raise ValueError('invalid_request_budget')
    used = 0
    for item in plan['spec']['rooms']:
        result = plan['results'].setdefault(identity(item), {'state':'pending','pages_read':0,'coverage_state':'unknown'})
        if result['state'] in ('complete','blocked'): continue
        params = {'chat':item['chat'],'interval':item['interval'],'reader':'connected_account'}
        while used < max_requests:
            try:
                jobs = running_jobs(request('sync','status',None),item['chat'])
                if jobs:
                    result.update(state='waiting',job_ids=[j['id'] for j in jobs]);save(plan);break
                result.pop('job_ids',None)
                snapshot = request('sync','backfill',{**params,'status_only':True},owner=True)
                raw = snapshot.get('progress');progress = metadata_progress(raw)
                committed = progress['committed_pages']
                if committed > result['pages_read']:
                    result['consecutive_failures'] = 0
                    result.pop('next_retry_at',None)
                result['pages_read'] = committed
                result['progress'] = progress
                for field in ('earliest_observed_ts','latest_observed_ts'):
                    value = raw.get(field)
                    if type(value) in (int,float) and math.isfinite(value): result[field] = value
                if progress['status'] == 'complete':
                    result.update(state='complete',terminal_reason='provider_reported_terminal',coverage_state='unknown')
                    result.pop('reason',None);save(plan);break
                if result.get('next_retry_at',0) > now():
                    result['state']='backoff';save(plan);break
                result['state']='requesting';result['attempts']=result.get('attempts',0)+1;save(plan)
                used += 1;started=time.monotonic()
                page=request('sync','backfill',{**params,'resume':True},owner=True)
                progress=metadata_progress(page.get('progress'))
                if progress['committed_pages'] <= committed: raise ValueError('daemon_not_progressing')
                result.update(state='pending',pages_read=progress['committed_pages'],progress=progress,
                              consecutive_failures=0,last_duration_seconds=round(time.monotonic()-started,3))
                result['events_reported']=result.get('events_reported',0)+page.get('event_count',0)
                result['inserted_reported']=result.get('inserted_reported',0)+page.get('inserted',0)
                for field in ('earliest_observed_ts','latest_observed_ts'):
                    value=page['progress'].get(field)
                    if type(value) in (int,float) and math.isfinite(value):result[field]=value
                result.pop('reason',None);result.pop('next_retry_at',None)
                if progress['status']=='complete':result.update(state='complete',terminal_reason='provider_reported_terminal')
                save(plan)
                if result['state']=='complete':break
            except (ValueError,OSError,json.JSONDecodeError) as error:
                reason=str(error) if isinstance(error,ValueError) else 'request_failed'
                safe=reason if reason in ('request_outcome_unknown','rate_limit','unavailable','permission','request_failed',
                    'daemon_not_progressing','daemon_progress_unavailable') else 'response_failed'
                failures=result.get('consecutive_failures',0)+1
                result.update(reason=safe,consecutive_failures=failures,state='backoff',
                              next_retry_at=now()+min(300,5*2**min(failures-1,6)))
                if failures >= (10 if safe == 'rate_limit' else 5):result.update(state='blocked',terminal_reason='provider_failure_after_bounded_retries')
                save(plan);break
        if used>=max_requests:break
    return full_summary(plan,used)


@contextlib.contextmanager
def locked(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError('collection_directory_must_be_owner_only')
    fd = os.open(root / 'collection.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def save_plan(path, value):
    if path.is_symlink():
        raise ValueError('invalid_plan_path')
    fd, temporary = tempfile.mkstemp(prefix='.collection-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'run', 'status', 'plan-all', 'run-all'))
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--inboxd', type=Path, default=Path.home()/'.local/bin/inboxd')
    parser.add_argument('--platform', action='append', choices=('kakao', 'telegram', 'slack'))
    parser.add_argument('--chat-id', action='append', default=[])
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--max-rooms', type=int, default=1, help='maximum per platform')
    parser.add_argument('--pages-per-room', type=int, default=1)
    parser.add_argument('--max-requests', type=int, default=1, help='provider calls during this invocation')
    parser.add_argument('--until-terminal',action='store_true',help='repeat resumable bounded runs until every source is terminal or blocked')
    args = parser.parse_args()
    request = lambda group, action, payload, **kw: cli(args.inboxd, group, action, payload, **kw)
    with locked(args.root):
        path = args.root / 'plan.json'
        if args.command == 'plan-all':
            if path.exists(): raise ValueError('plan_exists_use_a_new_root')
            rooms, errors=connected_inventory(request,args.platform or ('kakao','telegram','slack'))
            plan=make_full_plan(rooms,errors);save_plan(path,plan);result=full_summary(plan)
        elif args.command == 'plan':
            if path.exists():
                raise ValueError('plan_exists_use_a_new_root')
            if not 1 <= args.days <= 3650:
                raise ValueError('invalid_days')
            rooms = inventory(request, args.platform or ('kakao', 'telegram'))
            now = time.time()
            plan = make_plan(rooms, from_ts=now-args.days*86400, to_ts=now,
                             max_rooms=args.max_rooms, pages_per_room=args.pages_per_room, chat_ids=args.chat_id)
            save_plan(path, plan)
            result = plan
        else:
            if path.is_symlink():
                raise ValueError('invalid_plan_path')
            plan = json.loads(path.read_text())
            if args.command == 'run-all':
                result=execute_full(plan,request,lambda value:save_plan(path,value),max_requests=args.max_requests)
                while args.until_terminal and any(r['state'] not in ('complete','blocked') for r in result['rooms']):
                    print(json.dumps(result,ensure_ascii=False),flush=True)
                    if not result['requests_this_run']: time.sleep(5)
                    result=execute_full(plan,request,lambda value:save_plan(path,value),max_requests=args.max_requests)
            else:
                result = plan if args.command == 'status' else execute(plan, request,
                lambda value: save_plan(path, value), max_requests=args.max_requests)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'error', 'error_type': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
