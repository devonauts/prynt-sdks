#!/usr/bin/env python3
"""Prynt SDK release tool: build, test, pack, check and publish every public SDK.

    sdk.py list                                  packages, local version, registry name
    sdk.py status [--json]                       local version vs what each registry serves
    sdk.py bump <id|all> <X.Y.Z>                 set the version everywhere + date the CHANGELOG
    sdk.py release <id|all> [--version X.Y.Z]    build + test + pack + registry dry-run (default)
                          [--publish]            ...then publish what is not live yet (tokens from env)
    sdk.py check [PATH ...]                      fail on secrets / internal names in files or archives
    sdk.py export --out DIR [--repo owner/name]  write the public repository (+ split repos)
                  [--git] [--push]               ...commit it, tag new versions, push
    sdk.py downloads --out DIR                   pack everything for pryntid.com/downloads
    sdk.py tag-to-id <tag>                       which package a release tag belongs to

Everything builds inside pinned Docker images (Node, Python, Ruby, .NET, Maven, Go, Composer,
Flutter, Gradle), the same on a laptop, a server or GitHub Actions; `--native` runs the same
scripts on the host instead. Nothing is published without `--publish`, and a version that is
already on its registry is skipped, so re-running is safe.

Publishing tokens are read from the environment, never from the command line:
  npm        NPM_TOKEN                     (GitHub Actions: adds --provenance automatically)
  PyPI       PYPI_API_TOKEN (or PYPI_TOKEN)
  RubyGems   RUBYGEMS_API_KEY
  NuGet      NUGET_API_KEY
  Maven      MAVEN_CENTRAL_USERNAME, MAVEN_CENTRAL_PASSWORD, MAVEN_GPG_PRIVATE_KEY, MAVEN_GPG_PASSPHRASE
  CocoaPods  COCOAPODS_TRUNK_TOKEN         (macOS only: trunk validates with Xcode)
  pub.dev    PUB_CREDENTIALS               (contents of pub-credentials.json; or OIDC in Actions)
  WordPress  WP_SVN_USERNAME, WP_SVN_PASSWORD
  Packagist / Go / Swift Package Manager read git tags: publishing them = pushing the tag.
In GitHub Actions a registry is only published when the repository variable PUBLISH_<REGISTRY>
is "true" (PUBLISH_NPM, PUBLISH_PYPI, PUBLISH_RUBYGEMS, PUBLISH_NUGET, PUBLISH_MAVEN,
PUBLISH_PUB, PUBLISH_COCOAPODS, PUBLISH_WORDPRESS).
"""
import argparse
import datetime
import fnmatch
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MANIFEST = json.load(open(os.path.join(HERE, 'packages.json')))
PUBLIC_TEMPLATE = os.path.join(HERE, 'public')
PRIVATE_DIR = os.path.join(HERE, 'private')
LICENSE_TEMPLATE = os.path.join(PUBLIC_TEMPLATE, 'LICENSE')
SEMVER = re.compile(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
UA = 'prynt-sdk-release/1.0 (+https://pryntid.com)'
EPOCH = 315532800  # 1980-01-01: fixed timestamps so rebuilt archives do not churn

IMAGES = {
    'npm': 'node:20-alpine',
    'python': 'python:3.12-slim',
    'ruby': 'ruby:3.3-slim',
    'dotnet': 'mcr.microsoft.com/dotnet/sdk:8.0',
    'maven': 'maven:3.9-eclipse-temurin-17',
    'android': 'gradle:8.7-jdk17',
    'go': 'golang:1.22-alpine',
    'php': 'composer:2',
    'flutter': 'ghcr.io/cirruslabs/flutter:3.24.5',
    'ios': 'ruby:3.3-slim',
    'wordpress': 'php:8.3-cli-alpine',
    'zip': 'node:20-alpine',
}
# Registry -> GitHub Actions variable that must be "true" for CI to publish there.
GATE = {'npm': 'PUBLISH_NPM', 'pypi': 'PUBLISH_PYPI', 'rubygems': 'PUBLISH_RUBYGEMS',
        'nuget': 'PUBLISH_NUGET', 'maven': 'PUBLISH_MAVEN', 'pub': 'PUBLISH_PUB',
        'cocoapods': 'PUBLISH_COCOAPODS', 'wordpress': 'PUBLISH_WORDPRESS'}
# Registry -> env vars a publish needs (any one of a tuple).
TOKENS = {
    'npm': [('NPM_TOKEN',)],
    'pypi': [('PYPI_API_TOKEN', 'PYPI_TOKEN')],
    'rubygems': [('RUBYGEMS_API_KEY',)],
    'nuget': [('NUGET_API_KEY',)],
    'maven': [('MAVEN_CENTRAL_USERNAME',), ('MAVEN_CENTRAL_PASSWORD',), ('MAVEN_GPG_PRIVATE_KEY',), ('MAVEN_GPG_PASSPHRASE',)],
    'cocoapods': [('COCOAPODS_TRUNK_TOKEN',)],
    'pub': [('PUB_CREDENTIALS', 'PUB_TOKEN')],
    'wordpress': [('WP_SVN_USERNAME',), ('WP_SVN_PASSWORD',)],
}
SECRET_ENV = sorted({n for reqs in TOKENS.values() for alts in reqs for n in alts})
# Copied into the public repository and the downloads: never build output or local state.
EXCLUDE = ['node_modules', 'dist', '.types', 'package-lock.json', '__pycache__', '*.pyc', 'build',
           '.gradle', 'target', 'bin', 'obj', 'out', '.dart_tool', '*.gem', '*.nupkg', '.DS_Store',
           '.venv', '*.egg-info', '.pytest_cache', '.wrangler', 'pubspec.lock', '.idea', 'local.properties']


def die(msg):
    print(f'error: {msg}', file=sys.stderr)
    sys.exit(1)


def info(msg):
    print(msg, flush=True)


# ---- manifest + versions ------------------------------------------------------------------------
def packages(sel):
    allp = MANIFEST['packages']
    if sel in (None, 'all'):
        return allp
    ids = sel.split(',')
    out = [p for p in allp if p['id'] in ids or p['name'] in ids]
    missing = set(ids) - {p['id'] for p in out} - {p['name'] for p in out}
    if missing:
        die(f'unknown package(s): {", ".join(sorted(missing))} (see `sdk.py list`)')
    return out


def _vfile(p, spec, root):
    return os.path.normpath(os.path.join(root, p['dir'], spec['file']))


def _read_spec(p, spec, root):
    path = _vfile(p, spec, root)
    if not os.path.exists(path):
        return None
    text = open(path, encoding='utf-8').read()
    if 'json' in spec:
        return json.loads(text).get(spec['json'])
    m = re.search(spec['re'], text)
    return m.group(1).strip() if m else None


def version(p, root=ROOT):
    return _read_spec(p, p['versions'][0], root)


def version_drift(p, root=ROOT):
    """Every place the version is written must agree with the version of record."""
    v = version(p, root)
    bad = []
    for spec in p['versions'][1:]:
        got = _read_spec(p, spec, root)
        if got != v:
            bad.append(f'{p["dir"]}/{spec["file"]}: {got!r} != {v!r}')
    return bad


def _write_spec(p, spec, v, root):
    path = _vfile(p, spec, root)
    if os.path.basename(path) == 'CHANGELOG.md':
        return  # handled by date_changelog
    text = open(path, encoding='utf-8').read()
    if 'json' in spec:
        j = json.loads(text)
        j[spec['json']] = v
        new = json.dumps(j, indent=2, ensure_ascii=False) + '\n'
    else:
        m = re.search(spec['re'], text)
        if not m:
            die(f'no version found in {path} (pattern {spec["re"]})')
        new = text[:m.start(1)] + v + text[m.end(1):]
    open(path, 'w', encoding='utf-8').write(new)


def date_changelog(p, v, root):
    """Move `## [Unreleased]` notes under `## [v] - today` and open a new empty Unreleased."""
    path = os.path.join(root, p['dir'], 'CHANGELOG.md')
    if not os.path.exists(path):
        die(f'{p["dir"]}/CHANGELOG.md is missing')
    text = open(path, encoding='utf-8').read()
    if re.search(rf'(?m)^## \[{re.escape(v)}\]', text):
        return
    m = re.search(r'(?m)^## \[Unreleased\][^\n]*\n', text)
    today = datetime.date.today().isoformat()
    if not m:
        die(f'{p["dir"]}/CHANGELOG.md has no "## [Unreleased]" section')
    rest = text[m.end():]
    nxt = re.search(r'(?m)^## \[', rest)
    notes = (rest[:nxt.start()] if nxt else rest).strip()
    if not notes:
        notes = '- Maintenance release.'
        print(f'  warning: {p["id"]}: no notes under [Unreleased]; wrote "{notes}"')
    tail = rest[nxt.start():] if nxt else ''
    text = text[:m.start()] + f'## [Unreleased]\n\n## [{v}] - {today}\n\n{notes}\n\n' + tail
    open(path, 'w', encoding='utf-8').write(text.rstrip() + '\n')


def bump(p, v, root=ROOT):
    if not SEMVER.match(v):
        die(f'not a semver version: {v}')
    cur = version(p, root)
    if cur and _vkey(v) < _vkey(cur):
        die(f'{p["id"]}: {v} is lower than the current {cur}')
    date_changelog(p, v, root)
    for spec in p['versions']:
        _write_spec(p, spec, v, root)
    if p['id'] == 'agent':  # @pryntid/react's peer range follows @pryntid/js's major
        react = next(x for x in MANIFEST['packages'] if x['id'] == 'react')
        rp = os.path.join(root, react['dir'], 'package.json')
        j = json.load(open(rp))
        j.setdefault('peerDependencies', {})['@pryntid/js'] = f'^{v.split(".")[0]}.0.0'
        open(rp, 'w').write(json.dumps(j, indent=2, ensure_ascii=False) + '\n')
    info(f'  {p["id"]}: {cur} -> {v}')


def _vkey(v):
    core, _, pre = v.partition('-')
    nums = []
    for x in core.split('+')[0].split('.'):
        m = re.match(r'\d+', x)
        nums.append(int(m.group(0)) if m else 0)
    return tuple(nums) + ((1,) if not pre else (0, pre))


# ---- registries ---------------------------------------------------------------------------------
def _get(url, timeout=15):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except Exception:
        return 0, ''


def published(p):
    """Versions the registry serves today: a set, or None when the registry could not be read."""
    reg, name = p['registry'], p['name']
    try:
        if reg == 'npm':
            code, body = _get('https://registry.npmjs.org/' + urllib.parse.quote(name, safe='@'))
            return set(json.loads(body).get('versions', {})) if code == 200 else (set() if code == 404 else None)
        if reg == 'pypi':
            code, body = _get(f'https://pypi.org/pypi/{name}/json')
            return set(json.loads(body).get('releases', {})) if code == 200 else (set() if code == 404 else None)
        if reg == 'rubygems':
            code, body = _get(f'https://rubygems.org/api/v1/versions/{name}.json')
            return {x['number'] for x in json.loads(body)} if code == 200 else (set() if code == 404 else None)
        if reg == 'nuget':
            code, body = _get(f'https://api.nuget.org/v3-flatcontainer/{name.lower()}/index.json')
            return set(json.loads(body).get('versions', [])) if code == 200 else (set() if code == 404 else None)
        if reg == 'maven':
            g, a = name.split(':')
            code, body = _get(f'https://repo1.maven.org/maven2/{g.replace(".", "/")}/{a}/maven-metadata.xml')
            return set(re.findall(r'<version>([^<]+)</version>', body)) if code == 200 else (set() if code == 404 else None)
        if reg == 'packagist':
            code, body = _get(f'https://repo.packagist.org/p2/{name}.json')
            if code == 200:
                return {x['version'].lstrip('v') for x in json.loads(body)['packages'].get(name, [])}
            return set() if code == 404 else None
        if reg == 'go':
            esc = re.sub(r'[A-Z]', lambda m: '!' + m.group(0).lower(), name)
            code, body = _get(f'https://proxy.golang.org/{esc}/@v/list')
            return {x.lstrip('v') for x in body.split()} if code == 200 else (set() if code in (404, 410) else None)
        if reg == 'cocoapods':
            code, body = _get(f'https://trunk.cocoapods.org/api/v1/pods/{name}')
            return {x['name'] for x in json.loads(body).get('versions', [])} if code == 200 else (set() if code == 404 else None)
        if reg == 'pub':
            code, body = _get(f'https://pub.dev/api/packages/{name}')
            return {x['version'] for x in json.loads(body).get('versions', [])} if code == 200 else (set() if code == 404 else None)
        if reg == 'wordpress':
            code, body = _get('https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=' + name)
            if code == 200 and body.strip().startswith('{'):
                j = json.loads(body)
                return set((j.get('versions') or {}).keys()) | ({j['version']} if j.get('version') else set())
            return set() if code in (200, 404) else None
        return set()
    except (ValueError, KeyError, TypeError):
        return None


# ---- forbidden-content check --------------------------------------------------------------------
# Generic rules: safe to ship (they name nothing of ours). Private names live in private/forbidden.txt,
# which is never exported.
GENERIC_RULES = [
    (r'\b(?:sk|pk|rk|whsec)_live_[A-Za-z0-9]{12,}', 'live API key'),
    (r'\bsk_test_[A-Za-z0-9]{20,}', 'secret test key'),
    (r'(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d.])', 'private IPv4 (192.168/16)'),
    (r'(?<![\d.])10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])', 'private IPv4 (10/8)'),
    (r'(?<![\d.])172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?![\d.])', 'private IPv4 (172.16/12)'),
    (r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY', 'private key'),
    (r'\bAKIA[0-9A-Z]{16}\b', 'AWS access key'),
    (r'\bgh[pousr]_[A-Za-z0-9]{30,}', 'GitHub token'),
    (r'\bnpm_[A-Za-z0-9]{30,}', 'npm token'),
    (r'\bpypi-[A-Za-z0-9_-]{40,}', 'PyPI token'),
    (r'\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}', 'SendGrid key'),
    (r'\bxox[abposr]-[A-Za-z0-9-]{10,}', 'Slack token'),
    (r'\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}', 'AI provider key'),
    (r'\bAIza[0-9A-Za-z_-]{35}\b', 'Google API key'),
]
GENERIC_FILES = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore',
                 'id_rsa*', 'id_ed25519*', '*.mobileprovision', '.npmrc', '.pypirc', 'credentials',
                 'pub-credentials.json', '*.sqlite', '*.sqlite3', '*.db', 'google-services.json',
                 'GoogleService-Info.plist', 'secring.*', '*.gpg']
TEXT_LIMIT = 8 * 1024 * 1024


def load_rules():
    rules = [(re.compile(r), why) for r, why in GENERIC_RULES]
    files = list(GENERIC_FILES)
    allow = set()
    fpath = os.path.join(PRIVATE_DIR, 'forbidden.txt')
    if os.path.exists(fpath):
        for line in open(fpath, encoding='utf-8'):
            line = line.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if line.startswith('file:'):
                files.append(line[5:].strip())
            else:
                pat, _, why = line.partition('  #')
                rules.append((re.compile(pat.strip(), re.I), why.strip() or 'internal name'))
    apath = os.path.join(PRIVATE_DIR, 'allow.txt')
    for p in (apath, os.path.join(HERE, 'allow.txt')):
        if os.path.exists(p):
            allow |= {ln.strip() for ln in open(p, encoding='utf-8') if ln.strip() and not ln.startswith('#')}
    return rules, files, allow


def _scan_text(label, data, rules, allow, out):
    if len(data) > TEXT_LIMIT or b'\0' in data[:4096]:
        return
    text = data.decode('utf-8', 'replace')
    for n, line in enumerate(text.splitlines(), 1):
        for rx, why in rules:
            for m in rx.finditer(line):
                if m.group(0) in allow or any(a in line for a in allow if len(a) > 12 and m.group(0) in a):
                    continue
                out.append(f'{label}:{n}: {why}: {m.group(0)[:60]}')


def _scan_name(label, name, files, out):
    base = os.path.basename(name)
    for g in files:
        if fnmatch.fnmatch(base, g) or fnmatch.fnmatch(name, g):
            out.append(f'{label}: forbidden file ({g})')
            return


def _scan_archive(label, data, rules, files, allow, out, depth=0):
    """Scan inside .tgz/.tar.gz/.gem/.zip/.whl/.nupkg/.jar/.aar — what users actually download."""
    def entry(name, blob):
        lab = f'{label}!{name}'
        _scan_name(lab, name, files, out)
        if depth < 2 and re.search(r'\.(tgz|tar\.gz|tar|gem|zip|whl|nupkg|snupkg|jar|aar)$', name):
            _scan_archive(lab, blob, rules, files, allow, out, depth + 1)
        else:
            _scan_text(lab, blob, rules, allow, out)
    bio = io.BytesIO(data)
    if zipfile.is_zipfile(bio):
        with zipfile.ZipFile(bio) as z:
            for i in z.infolist():
                if not i.is_dir():
                    entry(i.filename, z.read(i))
        return
    bio.seek(0)
    try:
        with tarfile.open(fileobj=bio, mode='r:*') as t:
            for m in t.getmembers():
                if m.isfile():
                    entry(m.name, t.extractfile(m).read())
    except tarfile.TarError:
        _scan_text(label, data, rules, allow, out)


def scan(paths, quiet=False):
    rules, files, allow = load_rules()
    out = []
    for top in paths:
        if os.path.isfile(top):
            walk = [(os.path.dirname(top), [], [os.path.basename(top)])]
        else:
            walk = os.walk(top)
        for d, dirs, fns in walk:
            dirs[:] = [x for x in dirs if x not in ('.git', 'node_modules')]
            for fn in fns:
                full = os.path.join(d, fn)
                rel = os.path.relpath(full, top) if os.path.isdir(top) else fn
                label = os.path.join(os.path.basename(os.path.normpath(top)), rel) if os.path.isdir(top) else top
                _scan_name(label, rel, files, out)
                data = open(full, 'rb').read()
                if re.search(r'\.(tgz|tar\.gz|gem|zip|whl|nupkg|snupkg|jar|aar)$', fn):
                    _scan_archive(label, data, rules, files, allow, out)
                else:
                    _scan_text(label, data, rules, allow, out)
    if out and not quiet:
        print('Forbidden content (fix it, or add a known-fake value to scripts/sdk/private/allow.txt):', file=sys.stderr)
        for f in out:
            print('  ' + f, file=sys.stderr)
    return out


# ---- staging + license --------------------------------------------------------------------------
def _ignored(name):
    return any(fnmatch.fnmatch(name, g) for g in EXCLUDE)


def copy_tree(src, dst):
    shutil.copytree(src, dst, ignore=lambda d, names: [n for n in names if _ignored(n)], dirs_exist_ok=True)


def license_spdx():
    first = open(LICENSE_TEMPLATE, encoding='utf-8').readline().strip()
    return {'MIT License': 'MIT', 'Apache License': 'Apache-2.0'}.get(first.split(',')[0].strip(), first)


def declared_licenses(pdir):
    """License strings a package's manifests declare (so they can be checked against LICENSE)."""
    found = []
    for fn, rx in (('package.json', r'"license"\s*:\s*"([^"]+)"'), ('pyproject.toml', r'(?m)^license\s*=\s*"([^"]+)"'),
                   ('composer.json', r'"license"\s*:\s*"([^"]+)"'), ('Prynt.Server.csproj', r'<PackageLicenseExpression>([^<]+)<'),
                   ('prynt.gemspec', r"license\s*=\s*'([^']+)'"), ('Prynt.podspec', r":type => '([^']+)'"),
                   ('pom.xml', r'<license>\s*<name>([^<]+)</name>'), ('build.gradle.kts', r'license \{\s*name\.set\("([^"]+)"\)'),
                   ('prynt-for-wordpress/readme.txt', r'(?m)^License: (\S+)')):
        path = os.path.join(pdir, fn)
        if os.path.exists(path):
            m = re.search(rx, open(path, encoding='utf-8').read())
            if m:
                found.append((fn, m.group(1).replace(' License', '')))
    return found


def ensure_license(pdir):
    spdx = license_spdx()
    for fn, lic in declared_licenses(pdir):
        if lic != spdx:
            die(f'{pdir}/{fn} declares license {lic!r} but scripts/sdk/public/LICENSE is {spdx!r}')
    target = os.path.join(pdir, 'LICENSE')
    if not os.path.exists(target):
        shutil.copyfile(LICENSE_TEMPLATE, target)
    wp = os.path.join(pdir, 'prynt-for-wordpress')
    if os.path.isdir(wp) and not os.path.exists(os.path.join(wp, 'LICENSE')):
        shutil.copyfile(LICENSE_TEMPLATE, os.path.join(wp, 'LICENSE'))


def stage(pkgs, bump_to=None):
    """A clean copy of the packages (plus what they build against), with LICENSE files added."""
    st = tempfile.mkdtemp(prefix='prynt-sdk-')
    need = {p['id'] for p in pkgs}
    for p in pkgs:
        need |= set(p.get('buildFirst', []))
    for p in MANIFEST['packages']:
        if p['id'] in need:
            copy_tree(os.path.join(ROOT, p['dir']), os.path.join(st, p['dir']))
            ensure_license(os.path.join(st, p['dir']))
    if bump_to:
        for p in pkgs:
            bump(p, bump_to, st)
    return st


# ---- executors ----------------------------------------------------------------------------------
def gha_env():
    """Env GitHub Actions sets, forwarded into containers so `npm publish --provenance` can use OIDC."""
    keep = re.compile(r'^(GITHUB_|ACTIONS_|RUNNER_)|^CI$')
    return sorted(k for k in os.environ if keep.match(k))


def run(p, script, st, out, native=False, publish=False, channel='npm'):
    eco = p['eco']
    env = {'PKG_DIR': p['dir'], 'PKG_NAME': p['name'], 'MODE': 'publish' if publish else 'dry-run',
           'SOURCE_DATE_EPOCH': str(EPOCH),
           # The browser agent reports how it was installed (npm | download | cdn); see packages/agent/build.mjs.
           'PRYNT_CHANNEL': channel}
    passthrough = (SECRET_ENV if publish else []) + gha_env()
    prelude = 'set -eu\nmkdir -p "$W"\ncp -R "$REPO/." "$W/"\ncd "$W/$PKG_DIR"\n'
    if native:
        w = tempfile.mkdtemp(prefix='prynt-w-')
        cache = os.path.expanduser('~/.cache/prynt-sdk')
        os.makedirs(cache, exist_ok=True)
        e = dict(os.environ, **env, W=w, OUT=out, REPO=st, CACHE=cache)
        if not publish:
            for k in SECRET_ENV:
                e.pop(k, None)
        r = subprocess.run(['bash', '-c', prelude + script], env=e)
        shutil.rmtree(w, ignore_errors=True)
        return r.returncode
    if not shutil.which('docker'):
        die('docker is not installed (or pass --native to use the host toolchains)')
    vol = os.environ.get(f'SDK_CACHE_{eco.upper()}', f'prynt-sdk-cache-{eco}')
    cmd = ['docker', 'run', '--rm', '-v', f'{st}:/repo:ro', '-v', f'{out}:/out', '-v', f'{vol}:/cache',
           '-e', 'W=/w', '-e', 'OUT=/out', '-e', 'REPO=/repo', '-e', 'CACHE=/cache']
    for k, v in env.items():
        cmd += ['-e', f'{k}={v}']
    for k in passthrough:
        if k in os.environ:
            cmd += ['-e', k]  # value comes from our environment, never the command line
    owner = f'{os.getuid()}:{os.getgid()}' if hasattr(os, 'getuid') else '0:0'
    tail = f'\nchown -R {owner} /out 2>/dev/null || true\n'
    cmd += [IMAGES[eco], 'sh', '-c', prelude + script + tail]
    return subprocess.run(cmd).returncode


# ---- per-ecosystem scripts (POSIX sh; $W work copy, $OUT artifacts, $CACHE persistent cache) ----
NPM = r'''
export npm_config_cache="$CACHE/npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false npm_config_loglevel=error
# Peers (react, react-native) are the app's to install; dev dependencies cover the builds.
export npm_config_legacy_peer_deps=true
for dep in {build_first}; do (cd "$W/packages/$dep" && rm -f package-lock.json && npm install && npm run build --if-present >/dev/null); done
rm -f package-lock.json   # lockfiles written on macOS miss Linux optional deps; resolve fresh
if node -e "const j=require('./package.json');process.exit(Object.keys(j.devDependencies||{{}}).length+Object.keys(j.dependencies||{{}}).length?0:1)"; then npm install; fi
npm run build --if-present
npm run test --if-present
rm -f "$OUT"/*.tgz
npm pack --pack-destination "$OUT"
TGZ=$(ls "$OUT"/*.tgz)
echo "--- tarball contents"; tar tzf "$TGZ" | sed 's/^/  /'
if [ "$MODE" = publish ]; then
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$HOME/.npmrc"
  PROV=""; [ "${{GITHUB_ACTIONS:-}}" = true ] && PROV="--provenance"
  npm publish "$TGZ" --access public $PROV
  rm -f "$HOME/.npmrc"
else
  npm publish "$TGZ" --access public --dry-run
fi
'''
PYTHON = r'''
export PIP_CACHE_DIR="$CACHE/pip" PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore
python -m unittest discover -s tests
pip install -q build twine
rm -rf "$OUT"/*
python -m build --outdir "$OUT"
twine check --strict "$OUT"/*
python -m zipfile -l "$OUT"/*.whl
if [ "$MODE" = publish ]; then
  TWINE_USERNAME=__token__ TWINE_PASSWORD="${{PYPI_API_TOKEN:-${{PYPI_TOKEN:-}}}}" twine upload --non-interactive "$OUT"/*
fi
'''
RUBY = r'''
ruby -Ilib test/test_prynt.rb
rm -f "$OUT"/*.gem
gem build prynt.gemspec -o "$OUT/prynt-{v}.gem"
tar -xOf "$OUT/prynt-{v}.gem" data.tar.gz | tar tzf - | sed 's/^/  /'
if [ "$MODE" = publish ]; then GEM_HOST_API_KEY="$RUBYGEMS_API_KEY" gem push "$OUT/prynt-{v}.gem"; fi
'''
DOTNET = r'''
export NUGET_PACKAGES="$CACHE/nuget" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
rm -f "$OUT"/*.nupkg "$OUT"/*.snupkg
dotnet pack -c Release -o "$OUT" -p:ContinuousIntegrationBuild=true
if [ "$MODE" = publish ]; then
  dotnet nuget push "$OUT/{name}.{v}.nupkg" -k "$NUGET_API_KEY" -s https://api.nuget.org/v3/index.json
fi
'''
MAVEN = r'''
M="-B -ntp -Dmaven.repo.local=$CACHE/m2"
mvn $M -q package
mvn $M -q -Prelease -Dgpg.skip=true verify   # sources + javadoc jars: what Maven Central requires
rm -f "$OUT"/*.jar; cp target/prynt-server-{v}*.jar "$OUT"/
ls -l "$OUT"
if [ "$MODE" = publish ]; then
  command -v gpg >/dev/null || (apt-get update -qq && apt-get install -y -qq gnupg >/dev/null)
  printf '%s\n' "$MAVEN_GPG_PRIVATE_KEY" | gpg --batch --import
  cat > /tmp/settings.xml <<'XML'
<settings><servers><server><id>central</id>
<username>${{env.MAVEN_CENTRAL_USERNAME}}</username><password>${{env.MAVEN_CENTRAL_PASSWORD}}</password>
</server></servers></settings>
XML
  mvn $M -s /tmp/settings.xml -Prelease deploy
fi
'''
ANDROID = r'''
export ANDROID_HOME="$CACHE/android-sdk" ANDROID_SDK_ROOT="$CACHE/android-sdk" GRADLE_USER_HOME="$CACHE/gradle"
if [ ! -d "$ANDROID_HOME/platforms/android-34" ]; then
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  curl -fsSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  (cd /tmp && unzip -q -o clt.zip) && rm -rf "$ANDROID_HOME/cmdline-tools/latest" && mv /tmp/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-34" "build-tools;34.0.0" >/dev/null
fi
gradle --no-daemon -q assembleRelease
rm -f "$OUT"/*.aar; cp build/outputs/aar/*-release.aar "$OUT/prynt-android-{v}.aar"
ls -l "$OUT"
if [ "$MODE" = publish ]; then
  ORG_GRADLE_PROJECT_mavenCentralUsername="$MAVEN_CENTRAL_USERNAME" \
  ORG_GRADLE_PROJECT_mavenCentralPassword="$MAVEN_CENTRAL_PASSWORD" \
  ORG_GRADLE_PROJECT_signingInMemoryKey="$MAVEN_GPG_PRIVATE_KEY" \
  ORG_GRADLE_PROJECT_signingInMemoryKeyPassword="$MAVEN_GPG_PASSPHRASE" \
  gradle --no-daemon publishToMavenCentral --no-configuration-cache
fi
'''
GO = r'''
export GOMODCACHE="$CACHE/gomod" GOCACHE="$CACHE/gobuild" CGO_ENABLED=0 GOFLAGS=-mod=mod GOTOOLCHAIN=local
go vet ./...
go test ./...
'''
PHP = r'''
export COMPOSER_HOME="$CACHE/composer"
composer validate --strict --no-check-publish
for f in $(find src -name '*.php'); do php -l "$f" >/dev/null; done
echo "php -l: ok"
'''
FLUTTER = r'''
export PUB_CACHE="$CACHE/pub"
git config --global --add safe.directory '*' 2>/dev/null || true
flutter --no-version-check pub get
flutter --no-version-check pub publish --dry-run
if [ "$MODE" = publish ]; then
  if [ -n "${{PUB_CREDENTIALS:-}}" ]; then mkdir -p "$HOME/.config/dart" && printf '%s' "$PUB_CREDENTIALS" > "$HOME/.config/dart/pub-credentials.json"; fi
  flutter --no-version-check pub publish --force
fi
'''
IOS = r'''
export GEM_HOME="$CACHE/gems" PATH="$CACHE/gems/bin:$PATH"
gem list -i cocoapods-core >/dev/null 2>&1 || gem install -N --silent cocoapods-core
ruby -e '
  require "cocoapods-core"
  s = Pod::Specification.from_file("Prynt.podspec")
  abort "podspec version #{{s.version}} != {v}" unless s.version.to_s == "{v}"
  abort "podspec source tag #{{s.source[:tag]}} != v{v}" unless s.source[:tag] == "v{v}"
  files = Dir.glob(s.consumer(:ios).source_files)
  abort "podspec source_files match nothing" if files.empty?
  puts "podspec ok: #{{s.name}} #{{s.version}} (#{{files.size}} source files, iOS #{{s.deployment_target(:ios)}})"
'
'''
WORDPRESS = r'''
for f in $(find prynt-for-wordpress -name '*.php'); do php -l "$f" >/dev/null; done
echo "php -l: ok"
if [ "$MODE" = publish ]; then
  apk add -q subversion rsync
  svn co -q --depth immediates "https://plugins.svn.wordpress.org/{name}" /tmp/svn
  svn up -q --set-depth infinity /tmp/svn/trunk
  rsync -a --delete --exclude .svn prynt-for-wordpress/ /tmp/svn/trunk/
  cd /tmp/svn
  svn add -q --force trunk
  svn status trunk | awk '/^!/ {{print $2}}' | xargs -r svn rm -q
  svn cp -q trunk "tags/{v}"
  svn ci -m "Release {v}" --username "$WP_SVN_USERNAME" --password "$WP_SVN_PASSWORD" --non-interactive
fi
'''
ZIP = r'''
if [ -f src/worker.js ]; then node --check src/worker.js && echo "worker.js: syntax ok"; fi
'''
SCRIPTS = {'npm': NPM, 'python': PYTHON, 'ruby': RUBY, 'dotnet': DOTNET, 'maven': MAVEN,
           'android': ANDROID, 'go': GO, 'php': PHP, 'flutter': FLUTTER, 'ios': IOS,
           'wordpress': WORDPRESS, 'zip': ZIP}
# Archives built on the host (no toolchain needed): what /downloads serves for these packages.
ZIPS = {'server-php': 'prynt-php-{v}', 'server-go': 'prynt-go-{v}', 'mobile-ios': 'prynt-ios-{v}',
        'mobile-flutter': 'prynt-flutter-{v}', 'mobile-android': 'prynt-android-{v}-src',
        'edge-cloudflare': 'prynt-edge-cloudflare', 'edge-nginx': 'prynt-edge-nginx',
        'wordpress': 'prynt-for-wordpress'}


def write_zip(src, dest, prefix):
    """Deterministic zip (sorted, fixed timestamps) so rebuilding without changes is a no-op."""
    files = []
    for d, dirs, fns in os.walk(src):
        dirs[:] = sorted(x for x in dirs if not _ignored(x))
        files += [os.path.join(d, f) for f in sorted(fns) if not _ignored(f)]
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(files):
            rel = os.path.relpath(f, src).replace(os.sep, '/')
            zi = zipfile.ZipInfo(f'{prefix}/{rel}', date_time=(1980, 1, 1, 0, 0, 0))
            zi.external_attr = 0o644 << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, open(f, 'rb').read())


def host_zip(p, st, out, v):
    name = ZIPS.get(p['id'])
    if not name:
        return
    src = os.path.join(st, p['dir'])
    if p['id'] == 'wordpress':
        src = os.path.join(src, 'prynt-for-wordpress')
    name = name.format(v=v)
    for f in os.listdir(out):
        if f.endswith('.zip'):
            os.remove(os.path.join(out, f))
    write_zip(src, os.path.join(out, name + '.zip'), name)
    info(f'  packed {name}.zip')


# ---- release ------------------------------------------------------------------------------------
def tokens_missing(p):
    missing = []
    for alts in TOKENS.get(p['registry'], []):
        if not any(os.environ.get(a) for a in alts):
            missing.append('/'.join(alts))
    return missing


def release(pkgs, ver=None, publish=False, native=False, out_root=None, skip=(), channel='npm'):
    out_root = out_root or os.path.join(ROOT, 'dist-sdk')
    results = []
    for p in pkgs:
        if p['id'] in skip:
            continue
        pid, reg = p['id'], p['registry']
        info(f'\n=== {pid}  ({reg} {p["name"]})')
        st = stage([p], bump_to=ver if (ver and not publish) else None)
        v = version(p, st)
        drift = version_drift(p, st)
        if drift:
            results.append((pid, v, 'FAIL', 'version mismatch: ' + '; '.join(drift)))
            continue
        found = scan([os.path.join(st, p['dir'])])
        if found:
            results.append((pid, v, 'FAIL', f'{len(found)} forbidden match(es)'))
            continue
        out = os.path.join(out_root, pid)
        os.makedirs(out, exist_ok=True)
        live = published(p) if publish else None
        do_pub = publish
        note = ''
        if publish:
            if reg in ('none', 'go', 'packagist'):
                do_pub, note = False, ('published by pushing the git tag' if reg != 'none' else 'no registry: /downloads + repository')
            elif live is None:
                results.append((pid, v, 'FAIL', f'could not read {reg} to check {v}'))
                continue
            elif v in live:
                do_pub, note = False, f'{v} already on {reg}'
            elif os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get(GATE.get(reg, '-'), '') != 'true':
                do_pub, note = False, f'{GATE.get(reg)} is not "true" in this repository'
            elif tokens_missing(p):
                do_pub, note = False, 'missing ' + ', '.join(tokens_missing(p))
            else:
                for rid in p.get('requires', []):
                    r = next(x for x in MANIFEST['packages'] if x['id'] == rid)
                    if version(r, ROOT) not in (published(r) or set()):
                        do_pub, note = False, f'waiting for {r["name"]} {version(r, ROOT)} to be live (re-run later)'
                        break
        pod_push = do_pub and reg == 'cocoapods'
        if pod_push:
            do_pub = False  # the container only lints; trunk push runs on the host (macOS)
        script = SCRIPTS[p['eco']].format(v=v, name=p['name'], build_first=' '.join(p.get('buildFirst', [])))
        if p['eco'] == 'android' and os.environ.get('SDK_SKIP_ANDROID') == '1':
            info('  SDK_SKIP_ANDROID=1: Android build skipped')
            rc = 0
        else:
            rc = run(p, script, st, out, native=native, publish=do_pub, channel=channel)
        if rc == 0:
            host_zip(p, st, out, v)
        if rc == 0 and pod_push:
            note = publish_cocoapods(p, st, v)
            do_pub = note == 'pushed to CocoaPods trunk'
        if rc != 0:
            results.append((pid, v, 'FAIL', f'build/test/{"publish" if do_pub else "dry-run"} exited {rc}'))
        elif do_pub:
            results.append((pid, v, 'PUBLISHED', reg))
        else:
            results.append((pid, v, 'OK', note or 'dry-run passed'))
        if rc == 0 and publish and reg == 'go' and live is not None and v not in live:
            _get(f'https://proxy.golang.org/{p["name"]}/@v/v{v}.info', timeout=30)  # warm the proxy once tagged
        shutil.rmtree(st, ignore_errors=True)
    info('\n' + '\n'.join(f'{s:9} {pid:20} {v or "?":10} {n}' for pid, v, s, n in results))
    return 0 if all(s != 'FAIL' for _, _, s, _ in results) else 1


def publish_cocoapods(p, st, v):
    if sys.platform != 'darwin' or not shutil.which('pod'):
        return 'CocoaPods trunk validates with Xcode: run on macOS (release workflow of the iOS repository)'
    r = subprocess.run(['pod', 'trunk', 'push', 'Prynt.podspec', '--allow-warnings'], cwd=os.path.join(st, p['dir']))
    return 'pushed to CocoaPods trunk' if r.returncode == 0 else f'pod trunk push exited {r.returncode}'


# ---- export (public repository) -----------------------------------------------------------------
def export(out, repo=None, git=False, push=False, splits=True):
    repo = repo or MANIFEST['repo']
    default_owner = MANIFEST['repo'].split('/')[0]
    owner = repo.split('/')[0]
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)

    def clean(d):
        for n in os.listdir(d):
            if n != '.git':
                pth = os.path.join(d, n)
                shutil.rmtree(pth) if os.path.isdir(pth) and not os.path.islink(pth) else os.remove(pth)

    clean(out)
    copy_tree(PUBLIC_TEMPLATE, out)
    for n in ('split-mobile-ios', 'split-server-php'):
        shutil.rmtree(os.path.join(out, n), ignore_errors=True)
    os.makedirs(os.path.join(out, 'scripts/sdk'), exist_ok=True)
    for f in ('sdk.py', 'release.sh', 'packages.json', 'allow.txt'):
        shutil.copy2(os.path.join(HERE, f), os.path.join(out, 'scripts/sdk', f))
    for p in MANIFEST['packages']:
        copy_tree(os.path.join(ROOT, p['dir']), os.path.join(out, p['dir']))
        ensure_license(os.path.join(out, p['dir']))
    targets = [(out, repo, None)]
    if splits:
        for p in MANIFEST['packages']:
            if p.get('split'):
                srepo = p['split']['repo'].replace(default_owner + '/', owner + '/', 1)
                sdir = os.path.join(os.path.dirname(out), srepo.split('/')[1])
                os.makedirs(sdir, exist_ok=True)
                clean(sdir)
                copy_tree(os.path.join(ROOT, p['dir']), sdir)
                ensure_license(sdir)
                tmpl = os.path.join(PUBLIC_TEMPLATE, 'split-' + p['id'])
                if os.path.isdir(tmpl):
                    copy_tree(tmpl, sdir)
                targets.append((sdir, srepo, p))
    if repo != MANIFEST['repo']:  # point every URL at the repository actually used
        for d, _, _ in targets:
            _rewrite(d, {MANIFEST['repo']: repo, f'{default_owner}/prynt-ios': f'{owner}/prynt-ios',
                         f'{default_owner}/prynt-php': f'{owner}/prynt-php'})
    bad = scan([d for d, _, _ in targets])
    if bad:
        die(f'export refused: {len(bad)} forbidden match(es) — nothing was committed or pushed')
    info(f'exported {len(MANIFEST["packages"])} packages to {out}' + ''.join(f'\n  split: {d}' for d, _, sp in targets if sp))
    if git:
        for d, r, sp in targets:
            _git_sync(d, r, sp, push)
    return 0


def _rewrite(d, mapping):
    for base, _, fns in os.walk(d):
        if '/.git' in base:
            continue
        for fn in fns:
            pth = os.path.join(base, fn)
            try:
                s = open(pth, encoding='utf-8').read()
            except (UnicodeDecodeError, OSError):
                continue
            t = s
            for a, b in mapping.items():
                t = t.replace(a, b)
            if t != s:
                open(pth, 'w', encoding='utf-8').write(t)


def _git(d, *args, check=True):
    return subprocess.run(['git', '-C', d, *args], check=check, capture_output=True, text=True)


def _git_sync(d, repo, split_pkg, push):
    if not os.path.isdir(os.path.join(d, '.git')):
        _git(d, 'init', '-q', '-b', 'main')
    if _git(d, 'remote', check=False).stdout.split().count('origin') == 0:
        _git(d, 'remote', 'add', 'origin', f'git@github.com:{repo}.git')
    _git(d, 'add', '-A')
    src = subprocess.run(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    if _git(d, 'diff', '--cached', '--quiet', check=False).returncode != 0:
        _git(d, 'commit', '-q', '-m', f'Sync SDKs from source {src or "(working tree)"}')
        info(f'{repo}: committed')
    sign = bool(subprocess.run(['git', '-C', d, 'config', 'user.signingkey'], capture_output=True, text=True).stdout.strip())
    existing = set(_git(d, 'tag', '-l').stdout.split())
    if push:
        r = _git(d, 'ls-remote', '--tags', 'origin', check=False)
        existing |= {ln.split('refs/tags/')[-1].removesuffix('^{}') for ln in r.stdout.splitlines()}
    new = []
    for p in ([split_pkg] if split_pkg else MANIFEST['packages']):
        v = version(p)
        tag = (p['split']['tag'] if split_pkg else p['tag']).format(v=v)
        if tag in existing:
            continue
        msg = f'{p["name"]} {v}'
        _git(d, 'tag', '-s' if sign else '-a', tag, '-m', msg)
        new.append(tag)
    if new:
        info(f'{repo}: tagged {", ".join(new)}' + ('' if sign else '  (unsigned: set git user.signingkey to sign tags)'))
    if push:
        _git(d, 'push', '-q', 'origin', 'main')
        for t in new:
            _git(d, 'push', '-q', 'origin', t)
        info(f'{repo}: pushed main + {len(new)} tag(s)')


# ---- downloads (pryntid.com/downloads) ----------------------------------------------------------
# Which artifacts each package contributes to /downloads (globs inside dist-sdk/<id>/).
DOWNLOADS = {
    'agent': ['*.tgz'], 'react': ['*.tgz'], 'server-node': ['*.tgz'], 'mobile-react-native': ['*.tgz'],
    'mcp': ['*.tgz'], 'server-python': ['*.whl', '*.tar.gz'], 'server-ruby': ['*.gem'],
    'server-dotnet': ['*.nupkg'], 'server-java': ['prynt-server-*[0-9].jar'],
    'mobile-android': ['*.aar', '*.zip'], 'server-php': ['*.zip'], 'server-go': ['*.zip'],
    'mobile-ios': ['*.zip'], 'mobile-flutter': ['*.zip'], 'wordpress': ['*.zip'],
    'edge-cloudflare': ['*.zip'], 'edge-nginx': ['*.zip'],
}
# File names each package owns in /downloads (so superseded versions are removed, others kept).
DL_OWNS = {
    'agent': r'^prynt-js-\d', 'react': r'^prynt-react-\d', 'server-node': r'^prynt-node-\d',
    'mobile-react-native': r'^prynt-react-native-\d', 'mcp': r'^prynt-mcp-\d', 'server-python': r'^pryntid-\d',
    'server-ruby': r'^prynt-\d.*\.gem$', 'server-dotnet': r'^Prynt\.Server\.\d', 'server-java': r'^prynt-server-\d',
    'mobile-android': r'^prynt-android-\d', 'server-php': r'^prynt-php-\d', 'server-go': r'^prynt-go-\d',
    'mobile-ios': r'^prynt-ios-\d', 'mobile-flutter': r'^prynt-flutter-\d', 'wordpress': r'^prynt-for-wordpress\.zip$',
    'edge-cloudflare': r'^prynt-edge-cloudflare\.zip$', 'edge-nginx': r'^prynt-edge-nginx\.zip$',
}


def downloads(out, data_json=None, native=False, skip=()):
    dist = os.path.join(ROOT, 'dist-sdk')
    skip = set(skip) | ({'mobile-android'} if os.environ.get('SDK_SKIP_ANDROID') == '1' else set())
    rc = release(packages('all'), native=native, out_root=dist, skip=skip, channel='download')
    if rc:
        die('a package failed: /downloads not updated')
    os.makedirs(out, exist_ok=True)
    produced = []
    for p in MANIFEST['packages']:
        if p['id'] in skip:
            continue
        d = os.path.join(dist, p['id'])
        files = sorted({f for g in DOWNLOADS[p['id']] for f in os.listdir(d) if fnmatch.fnmatch(f, g)})
        if p['id'] == 'server-java':
            files = [f for f in files if not re.search(r'-(sources|javadoc)\.jar$', f)]
        for f in files:
            produced.append((p, f, os.path.join(d, f)))
    bad = scan([src for _, _, src in produced])
    if bad:
        die('refusing to publish downloads with forbidden content')
    keep = {f for _, f, _ in produced}
    rebuilt = [DL_OWNS[p['id']] for p in MANIFEST['packages'] if p['id'] not in skip]
    for f in os.listdir(out):  # drop superseded versions of the packages rebuilt now; keep the rest
        if f not in keep and any(re.match(rx, f) for rx in rebuilt):
            os.remove(os.path.join(out, f))
    old = {}
    if os.path.exists(os.path.join(out, 'sdks.json')):
        for e in json.load(open(os.path.join(out, 'sdks.json'))).get('files', []):
            if e['id'] in skip and os.path.exists(os.path.join(out, e['file'])):
                old.setdefault(e['id'], []).append(e)
    entries = []
    for p, f, src in produced:
        shutil.copyfile(src, os.path.join(out, f))
        blob = open(src, 'rb').read()
        entries.append({'id': p['id'], 'name': p['name'], 'registry': p['registry'], 'version': version(p),
                        'file': f, 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
    entries += [e for es in old.values() for e in es]
    order = [p['id'] for p in MANIFEST['packages']]
    entries.sort(key=lambda e: (order.index(e['id']), e['file']))
    manifest = {'generatedFrom': 'scripts/sdk/sdk.py downloads', 'files': entries}
    json.dump(manifest, open(os.path.join(out, 'sdks.json'), 'w'), indent=2)
    with open(os.path.join(out, 'SHA256SUMS'), 'w') as fh:
        for e in entries:
            fh.write(f'{e["sha256"]}  {e["file"]}\n')
    if data_json:
        json.dump(manifest, open(data_json, 'w'), indent=2)
        open(data_json, 'a').write('\n')
    info(f'\n{len(entries)} files in {out} (+ sdks.json, SHA256SUMS)')
    return 0


# ---- CLI ----------------------------------------------------------------------------------------
def cmd_list(_):
    for p in MANIFEST['packages']:
        drift = version_drift(p)
        print(f'{p["id"]:20} {version(p) or "?":10} {p["registry"]:10} {p["name"]}' + ('   VERSION DRIFT' if drift else ''))


def cmd_status(a):
    rows = []
    for p in MANIFEST['packages']:
        live = published(p)
        v = version(p)
        rows.append({'id': p['id'], 'registry': p['registry'], 'name': p['name'], 'local': v,
                     'published': None if live is None else sorted(live, key=_vkey)[-1:] or [],
                     'live': None if live is None else (v in live)})
    if a.json:
        print(json.dumps(rows, indent=2))
        return
    for r in rows:
        pub = '?' if r['published'] is None else (r['published'][0] if r['published'] else '-')
        state = 'unknown' if r['live'] is None else ('live' if r['live'] else 'NOT PUBLISHED')
        print(f'{r["id"]:20} {r["registry"]:10} {r["name"]:48} local {r["local"] or "?":8} registry {pub:8} {state}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('list')
    s = sub.add_parser('status')
    s.add_argument('--json', action='store_true')
    s = sub.add_parser('bump')
    s.add_argument('package')
    s.add_argument('version')
    s = sub.add_parser('release')
    s.add_argument('package')
    s.add_argument('--version')
    s.add_argument('--publish', action='store_true')
    s.add_argument('--dry-run', action='store_true', help='the default; accepted for clarity')
    s.add_argument('--native', action='store_true')
    s.add_argument('--skip', default='', help='comma-separated ids to leave out')
    s = sub.add_parser('check')
    s.add_argument('paths', nargs='*')
    s = sub.add_parser('export')
    s.add_argument('--out', required=True)
    s.add_argument('--repo')
    s.add_argument('--git', action='store_true')
    s.add_argument('--push', action='store_true')
    s.add_argument('--no-splits', action='store_true')
    s = sub.add_parser('downloads')
    s.add_argument('--out', required=True)
    s.add_argument('--data-json')
    s.add_argument('--native', action='store_true')
    s.add_argument('--skip', default='')
    s = sub.add_parser('tag-to-id')
    s.add_argument('tag')
    a = ap.parse_args()

    if a.cmd == 'list':
        return cmd_list(a)
    if a.cmd == 'status':
        return cmd_status(a)
    if a.cmd == 'bump':
        for p in packages(a.package):
            bump(p, a.version)
        return 0
    if a.cmd == 'release':
        if a.publish and a.dry_run:
            die('--publish and --dry-run are exclusive')
        if a.publish and a.version:
            die('bump and commit first (`sdk.py bump`), then publish what is committed')
        return release(packages(a.package), ver=a.version, publish=a.publish, native=a.native,
                       skip=set(filter(None, a.skip.split(','))))
    if a.cmd == 'check':
        paths = a.paths or [os.path.join(ROOT, p['dir']) for p in MANIFEST['packages']]
        found = scan(paths)
        if not found:
            print(f'clean: {len(paths)} path(s)')
        return 1 if found else 0
    if a.cmd == 'export':
        return export(a.out, repo=a.repo, git=a.git or a.push, push=a.push, splits=not a.no_splits)
    if a.cmd == 'downloads':
        return downloads(a.out, a.data_json, native=a.native, skip=set(filter(None, a.skip.split(','))))
    if a.cmd == 'tag-to-id':  # tags of the public monorepo (split repositories hold one package each)
        for p in MANIFEST['packages']:
            rx = '^' + re.escape(p['tag']).replace(re.escape('{v}'), r'(\d+\.\d+\.\d+[^/]*)') + '$'
            m = re.match(rx, a.tag)
            if m:
                if m.group(1) != version(p):
                    die(f'tag {a.tag} does not match {p["dir"]} version {version(p)}')
                print(p['id'])
                return 0
        die(f'no package uses tag {a.tag}')


if __name__ == '__main__':
    sys.exit(main() or 0)
