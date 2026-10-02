from pathlib import Path
import hashlib
import urllib.request
import zipfile
import shutil

target = Path(__file__).resolve().parents[1] / '.tools'
target.mkdir(exist_ok=True)
url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
archive = target / 'ffmpeg-release-essentials.zip'
with urllib.request.urlopen(url + '.sha256', timeout=60) as response:
    expected = response.read().decode().split()[0].lower()
with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as destination:
    shutil.copyfileobj(response, destination)
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if actual != expected:
    raise RuntimeError('FFmpeg archive checksum mismatch')
with zipfile.ZipFile(archive) as bundle:
    for name in ('ffmpeg.exe', 'ffprobe.exe'):
        item = next(item for item in bundle.namelist() if item.endswith('/bin/' + name))
        with bundle.open(item) as source, (target / name).open('wb') as destination:
            shutil.copyfileobj(source, destination)
(target / 'source.txt').write_text(url + '\nSHA256=' + actual + '\n', encoding='utf-8')
print('FFmpeg and ffprobe ready; archive SHA256 verified.')
