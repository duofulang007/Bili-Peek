"""Offline installer check: python tests/install-translation.test.py."""
import base64
import contextlib
import io
import json
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

code = (Path(__file__).resolve().parents[1] / 'helper/install-translation.py').read_text('utf-8')
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    for name, content in {
        'metadata.json': json.dumps({'from_code': 'en', 'to_code': 'zh'}),
        'sentencepiece.model': 'tokenizer', 'model/model.bin': 'weights',
        'unused.bin': 'skip',
    }.items():
        archive.writestr('package/' + name, content)
package = {'from_code': 'en', 'to_code': 'zh', 'package_version': '1.9', 'links': ['https://example.invalid/model']}
index = json.dumps({'content': base64.b64encode(json.dumps([package]).encode()).decode()}).encode()
sandbox = Path(__file__).resolve().parent / 'export-sandbox'
sandbox.mkdir(exist_ok=True)
bad_buffer = io.BytesIO()
with zipfile.ZipFile(bad_buffer, 'w') as malicious_archive, zipfile.ZipFile(buffer) as normal_archive:
    for name in normal_archive.namelist():
        malicious_archive.writestr(name, normal_archive.read(name))
    malicious_archive.writestr('package/model/C:/metadata.json', 'unsafe')
for compression_status, unsafe in ((0, False), (1, False), (0, True)):
    with tempfile.TemporaryDirectory(dir=sandbox) as directory:
        root = Path(directory)
        python = root / '.tools/translation-env/Scripts/python.exe'
        python.parent.mkdir(parents=True)
        python.touch()
        fetch = SimpleNamespace(open=lambda request, **kwargs: io.BytesIO(index if request.full_url.endswith('index.json') else (bad_buffer if unsafe else buffer).getvalue()))
        with patch('urllib.request.build_opener', return_value=fetch), patch('subprocess.run', return_value=SimpleNamespace(returncode=compression_status)) as run, contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            tested_code = code.replace('433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab', hashlib.sha256((bad_buffer if unsafe else buffer).getvalue()).hexdigest())
            try:
                exec(compile(tested_code, 'install-translation.py', 'exec'), {'__file__': str(root / 'helper/install-translation.py')})
            except ValueError as error:
                assert unsafe and 'Unsafe translation archive path' in str(error)
                assert not (root / 'outside.txt').exists()
                continue
        if unsafe and __import__('os').name == 'nt':
            raise AssertionError('Windows archive traversal must be rejected')
        assert json.loads(output.getvalue())['model'] == str(root / '.tools/translation-model')
        assert (root / '.tools/translation-model/model/model.bin').read_text() == 'weights'
        assert not (root / '.tools/translation-model/unused.bin').exists()
        assert not (root / '.local/translation.argosmodel').exists()
        compact = [call for call in run.call_args_list if call.args[0][0] == 'compact.exe']
        import os
        if os.name == 'nt':
            assert len(compact) == 2
            assert all(call.args[0] == ['compact.exe', '/C', '/EXE:XPRESS4K', '/S', '/I', '/Q', '*'] for call in compact)
            assert {call.kwargs['cwd'].name for call in compact} == {'translation-env', 'translation-model'}
            assert bool(errors.getvalue()) == bool(compression_status)
        else:
            assert not compact
with tempfile.TemporaryDirectory(dir=sandbox) as directory:
    root = Path(directory)
    fetch = SimpleNamespace(open=lambda request, **kwargs: io.BytesIO(index if request.full_url.endswith('index.json') else buffer.getvalue()))
    with patch('urllib.request.build_opener', return_value=fetch), patch('subprocess.run', return_value=SimpleNamespace(returncode=0)):
        try:
            exec(compile(code, 'install-translation.py', 'exec'), {'__file__': str(root / 'helper/install-translation.py')})
        except ValueError as error:
            assert 'SHA-256 mismatch' in str(error)
        else:
            raise AssertionError('Unverified model bytes must be rejected')
    assert not (root / '.tools/translation-model').exists()
print('TRANSLATION_INSTALL_CHECK_PASS')
