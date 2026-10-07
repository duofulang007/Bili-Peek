from pathlib import Path
import hashlib
import urllib.request
import zipfile
import shutil
import os
import subprocess

target = Path(__file__).resolve().parents[1] / '.tools'
target.mkdir(exist_ok=True)
url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
archive = target / 'ffmpeg-release-essentials.zip'
with urllib.request.urlopen(url + '.sha256', timeout=60) as response:
    expected = response.read().decode().split()[0].lower()
with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as destination:
    shutil.copyfileobj(response, destination)
checksum = hashlib.sha256()
with archive.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        checksum.update(chunk)
actual = checksum.hexdigest()
if actual != expected:
    raise RuntimeError('FFmpeg archive checksum mismatch')
with zipfile.ZipFile(archive) as bundle:
    for name in ('ffmpeg.exe', 'ffprobe.exe'):
        item = next(item for item in bundle.namelist() if item.endswith('/bin/' + name))
        with bundle.open(item) as source, (target / name).open('wb') as destination:
            shutil.copyfileobj(source, destination)
(target / 'source.txt').write_text(url + '\nSHA256=' + actual + '\n', encoding='utf-8')
if os.name == 'nt':
    result = subprocess.run(['compact.exe', '/C', '/EXE:XPRESS4K', str(target / 'ffmpeg.exe'), str(target / 'ffprobe.exe')], creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        print('Tools ready, but native disk compression was unavailable; binaries remain usable.')
archive.unlink()
print('FFmpeg and ffprobe ready; archive SHA256 verified.')
