"""Offline installer check: python tests/download-tools.test.py."""
import contextlib
import hashlib
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

code = (Path(__file__).resolve().parents[1] / 'helper/download-tools.py').read_text(encoding='utf-8')
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    for name in ('ffmpeg.exe', 'ffprobe.exe'):
        archive.writestr('release/bin/' + name, name.encode())
payload = buffer.getvalue()
sandbox = Path(__file__).resolve().parent / 'export-sandbox'
sandbox.mkdir(exist_ok=True)

for valid in (True, False):
    with tempfile.TemporaryDirectory(prefix='bili-tools-', dir=sandbox) as directory:
        root = Path(directory)
        tools = root / '.tools'
        tools.mkdir()
        (tools / 'ffmpeg.exe').write_bytes(b'keep existing tool')
        expected = hashlib.sha256(payload).hexdigest() if valid else '0' * 64
        def fetch(url, **kwargs):
            return io.BytesIO(expected.encode() if url.endswith('.sha256') else payload)
        with patch('urllib.request.urlopen', side_effect=fetch), patch('subprocess.run', return_value=SimpleNamespace(returncode=0)) as compact, contextlib.redirect_stdout(io.StringIO()):
            try:
                exec(compile(code, 'download-tools.py', 'exec'), {'__file__': str(root / 'helper/download-tools.py')})
                assert valid, 'checksum mismatch must stop installation'
            except RuntimeError as error:
                assert not valid and 'checksum mismatch' in str(error)
        if valid:
            assert (tools / 'ffprobe.exe').read_bytes() == b'ffprobe.exe'
            assert not (tools / 'ffmpeg-release-essentials.zip').exists()
            if compact.called:
                assert compact.call_args.args[0][:3] == ['compact.exe', '/C', '/EXE:XPRESS4K']
        else:
            assert (tools / 'ffmpeg.exe').read_bytes() == b'keep existing tool'
            assert not compact.called
print('DOWNLOAD_TOOLS_CHECK_PASS')
