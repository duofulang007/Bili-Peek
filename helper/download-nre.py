"""Install the pinned prototype downloader from its official release, with SHA-256 verification."""
from pathlib import Path
import hashlib
import shutil
import urllib.request
import zipfile

target = Path(__file__).resolve().parents[1] / '.tools'
target.mkdir(exist_ok=True)
url = 'https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.6.0-beta/N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip'
expected = '3825fd42ee502f98a9378f6fdddb2f7822709f521806214f466db6935c950f1a'
archive = target / 'nre-v0.6.0-beta.zip'
with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as destination:
    shutil.copyfileobj(response, destination)
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if actual != expected:
    raise RuntimeError('N_m3u8DL-RE archive checksum mismatch')
with zipfile.ZipFile(archive) as bundle:
    item = next(item for item in bundle.namelist() if item.endswith('N_m3u8DL-RE.exe'))
    with bundle.open(item) as source, (target / 'N_m3u8DL-RE.exe').open('wb') as destination:
        shutil.copyfileobj(source, destination)
(target / 'nre-source.txt').write_text(url + '\nSHA256=' + actual + '\n', encoding='utf-8')
print('N_m3u8DL-RE v0.6.0-beta ready; official archive SHA256 verified.')
