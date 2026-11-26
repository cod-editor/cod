#!/usr/bin/env python3
"""Bounded macOS Cod observation. No app IPC, debugger or raw state export."""
import argparse
import collections
import datetime
import json
import os
from pathlib import Path
import platform
import subprocess
import time


def bounded_json(file, limit):
    with open(file, 'rb') as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            raise ValueError('size cap exceeded')
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ValueError('size cap exceeded')
    return json.loads(value)


def run(args, timeout=3, limit=65536):
    start = time.monotonic()
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return {'ok': result.returncode == 0, 'text': result.stdout[:limit],
                'returncode': result.returncode, 'truncated': len(result.stdout) > limit, 'ms': round((time.monotonic()-start)*1000)}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'ok': False, 'error': type(error).__name__, 'ms': round((time.monotonic()-start)*1000)}


def process_rows():
    value = run(['ps', '-axo', 'pid=,ppid=,comm='], limit=1024*1024)
    if not value['ok'] or value.get('truncated'):
        raise RuntimeError('process identity unavailable or process list exceeds cap')
    result = {}
    for line in value['text'].splitlines():
        bits = line.strip().split(None, 2)
        if len(bits) == 3:
            result[int(bits[0])] = (int(bits[1]), Path(bits[2]).name)
    return result


def cpu_seconds(value):
    days, _, rest = value.rpartition('-')
    fields = [float(x) for x in rest.split(':')]
    return (int(days) * 86400 if days else 0) + sum(x * 60 ** i for i, x in enumerate(reversed(fields)))


def snapshot(pid):
    start = time.monotonic()
    value = run(['ps', '-p', str(pid), '-o', 'pid=,ppid=,rss=,time=,state='])
    fields = value.get('text', '').split()
    if not value['ok'] or len(fields) != 5:
        return {'ok': False, 'latencyMs': round((time.monotonic()-start)*1000)}
    threads = run(['ps', '-M', '-p', str(pid), '-o', 'pid='])
    return {'ok': True, 'pid': int(fields[0]), 'ppid': int(fields[1]), 'rssKiB': int(fields[2]),
            'cpuSeconds': cpu_seconds(fields[3]), 'state': fields[4],
            'threads': sum(1 for line in threads.get('text', '').splitlines() if line.strip() and not line.lstrip().startswith('USER')) if threads['ok'] else None,
            'monotonic': time.monotonic(), 'latencyMs': round((time.monotonic()-start)*1000)}


def runtime_snapshot(directory):
    latest = None
    # Journal rotates at 1 MiB. Read at most 1 MiB of the current file.
    with open(directory / 'runtime.jsonl', 'rb') as stream:
        size = os.fstat(stream.fileno()).st_size
        stream.seek(max(0, size - 1024 * 1024))
        for line in stream.read(1024 * 1024).splitlines():
            try:
                row = json.loads(line)
                if row.get('event') == 'memory':
                    latest = row
            except (ValueError, TypeError):
                pass
    if latest is None:
        raise ValueError('No bounded memory event found')
    return latest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=os.environ.get('COD_DATA_DIR'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=30, choices=range(1, 61))
    parser.add_argument('--phase', choices=['idle','repro'], required=True)
    parser.add_argument('--no-stacks', action='store_true')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('This helper supports macOS only; adapt read-only tools on other systems')
    profile = args.data_dir or Path.home() / 'Library/Application Support/Cod'
    session_file = profile / 'diagnostics/session.json'
    session = bounded_json(session_file, 16384)
    pid = session.get('pid')
    processes = process_rows()
    if session.get('clean') or not isinstance(pid, int) or pid not in processes or processes[pid][1] not in {'Cod', 'Electron'}:
        raise RuntimeError('Session does not identify a live Cod main process; do not guess a PID')
    runtime = runtime_snapshot(profile / 'diagnostics')
    renderers = {c.get('pid') for c in runtime.get('contents', []) if c.get('role') == 'application'}
    renderers = sorted(p for p in renderers if isinstance(p, int) and p > 0 and p in processes)
    descendants = {pid}
    while True:
        expanded = descendants | {p for p, (parent, _) in processes.items() if parent in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    renderers = [p for p in renderers if p in descendants]
    if len(renderers) > 4:
        raise RuntimeError('More than four application renderers; select a narrower profile before capture')
    birth = {p: run(['ps','-p',str(p),'-o','lstart=']) for p in [pid]+renderers}
    if any(not value['ok'] for value in birth.values()):
        raise RuntimeError('Process birth identity unavailable')
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(args.out, 0o700)
    os.umask(0o077)
    start = time.monotonic()
    report = {'phase': args.phase, 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'logicalCpus': os.cpu_count(), 'mainPid': pid, 'applicationRendererPids': renderers,
              'journalTime': runtime.get('time'), 'windowOverlap': 'requires user action timing confirmation',
              'nativeContentsByRole': dict(collections.Counter(c.get('role') if c.get('role') in {'application','browser','agent-page','webview','window','backgroundPage'} else 'other' for c in runtime.get('contents', []))),
              'processCount': len(descendants), 'providerExecutables': dict(collections.Counter(name for p, (_, name) in processes.items() if p in descendants and name in {'codex','claude','kimi','code-mode-host'})),
              'samples': [], 'system': {}}
    try:
        report['persisted'] = {'fileBytes': (profile / 'workspace.sqlite').stat().st_size}
    except OSError as error:
        report['persisted'] = {'skipped': type(error).__name__}
    commands = {'memoryPressure': ['memory_pressure','-Q'], 'swap': ['sysctl','vm.swapusage'],
                'load': ['sysctl','vm.loadavg'], 'vm': ['vm_stat'], 'thermal': ['pmset','-g','therm']}
    for name, command in commands.items():
        report['system'][name] = run(command)
    print('READY: %s capture, %ss; record whether the intended action overlaps this window' % (args.phase, args.seconds), flush=True)
    window_start = time.monotonic()
    while time.monotonic()-window_start < args.seconds:
        report['samples'].append({'atSeconds': round(time.monotonic()-window_start, 3),
                                  'processes': {str(p): snapshot(p) for p in [pid]+renderers}})
        time.sleep(max(0, min(1, args.seconds-(time.monotonic()-window_start))))
    report['windowDurationSeconds'] = time.monotonic()-window_start
    report['systemAfter'] = {name: run(command) for name, command in commands.items()}
    report['cpuPercentOneCore'] = {}
    for p in [pid]+renderers:
        values = [s['processes'][str(p)] for s in report['samples'] if s['processes'][str(p)]['ok']]
        if len(values) >= 2:
            report['cpuPercentOneCore'][str(p)] = round(100*(values[-1]['cpuSeconds']-values[0]['cpuSeconds'])/(values[-1]['monotonic']-values[0]['monotonic']), 1)
    try:
        report['sessionUnchanged'] = bounded_json(session_file, 16384) == session
    except (OSError, ValueError):
        report['sessionUnchanged'] = False
    report['processIdentityUnchanged'] = {}
    for p in [pid]+renderers:
        latest = run(['ps','-p',str(p),'-o','lstart='])
        report['processIdentityUnchanged'][str(p)] = latest['ok'] and latest.get('text') == birth[p].get('text')
    report['stackSamples'] = {}
    if not args.no_stacks and report['sessionUnchanged']:
        for p in [pid]+renderers:
            if not report['processIdentityUnchanged'][str(p)]:
                continue
            report['stackSamples'][str(p)] = run(['/usr/bin/sample', str(p), '3', '5', '-file', str(args.out / ('stack-%s.txt' % p))], timeout=6)
    report['durationSeconds'] = time.monotonic()-start
    report['finishedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (args.out / 'capture.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'phase': args.phase, 'durationSeconds': report['durationSeconds'], 'sessionUnchanged': report['sessionUnchanged'], 'samples': len(report['samples']), 'out': str(args.out)}))


if __name__ == '__main__':
    main()
