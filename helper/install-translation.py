"""Install the small, offline English-to-Chinese translation runtime."""
import base64, hashlib, json, os, pathlib, subprocess, sys, urllib.request, zipfile
root = pathlib.Path(__file__).resolve().parent.parent
runtime = root / '.tools' / 'translation-env'
model = root / '.tools' / 'translation-model'
if not (runtime / 'Scripts/python.exe').exists():
    subprocess.run([sys.executable, '-m', 'venv', str(runtime)], check=True)
python = runtime / 'Scripts/python.exe'
subprocess.run([str(python), '-m', 'pip', 'install', '--only-binary=:all:', 'ctranslate2>=4.6,<5', 'sentencepiece>=0.2,<0.3'], check=True)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
request = urllib.request.Request('https://api.github.com/repos/argosopentech/argospm-index/contents/index.json', headers={'User-Agent': 'Bili-Peek'})
with opener.open(request, timeout=40) as response:
    index = json.loads(base64.b64decode(json.load(response)['content']))
package = next((p for p in index if p.get('from_code') == 'en' and p.get('to_code') == 'zh' and p.get('package_version') == '1.9'), None)
if package is None:
    raise ValueError('Verified English-to-Chinese model version 1.9 is unavailable')
archive = root / '.local' / 'translation.argosmodel'
archive.parent.mkdir(exist_ok=True)
digest = hashlib.sha256()
request = urllib.request.Request(package['links'][0], headers={'User-Agent': 'Mozilla/5.0'})
with opener.open(request, timeout=60) as response, archive.open('wb') as output:
    while chunk := response.read(1024 * 1024):
        output.write(chunk); digest.update(chunk)
if digest.hexdigest() != '433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab':
    raise ValueError('English-to-Chinese model SHA-256 mismatch')
model.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    for info in bundle.infolist():
        parts = pathlib.PurePosixPath(info.filename).parts
        if info.is_dir() or '..' in parts or len(parts) < 2:
            continue
        relative = pathlib.Path(*parts[1:])
        if relative.parts[0] != 'model' and relative.name not in ('sentencepiece.model', 'metadata.json', 'README.md', 'LICENSE'):
            continue
        target = model / relative
        if not target.resolve().is_relative_to(model.resolve()):
            raise ValueError('Unsafe translation archive path')
        target.parent.mkdir(parents=True, exist_ok=True)
        with bundle.open(info) as source, target.open('wb') as output:
            import shutil
            shutil.copyfileobj(source, output)
metadata = json.loads((model / 'metadata.json').read_text('utf-8'))
if metadata.get('from_code') != 'en' or metadata.get('to_code') != 'zh':
    raise ValueError('Model direction mismatch')
if not (model / 'model/model.bin').exists() or not (model / 'sentencepiece.model').exists():
    raise ValueError('Incomplete translation model')
(root / '.local' / 'translation-install.json').write_text(json.dumps({'package': package, 'sha256': digest.hexdigest(), 'python': str(python), 'model': str(model)}, ensure_ascii=False), encoding='utf-8')
archive.unlink()
if os.name == 'nt':
    for directory in (runtime, model):
        result = subprocess.run(['compact.exe', '/C', '/EXE:XPRESS4K', '/S', '/I', '/Q', '*'], cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            print(f'Native disk compression unavailable for {directory.name}; translation remains usable.', file=sys.stderr)
print(json.dumps({'python': str(python), 'model': str(model), 'package': metadata.get('package_version')}))
